import { afterEach, describe, expect, it, vi } from "vitest";

import handler, {
    envelopeDsn,
    matchTarget,
    parseDsn,
    resolveTunnelTargets,
} from "../../../api/sentry-tunnel.mjs";
import { mockResponse, streamRequest } from "../helpers/serverless.js";

const DSN = "https://abc123@o45.ingest.us.sentry.io/678";
const ENVELOPE_URL = "https://o45.ingest.us.sentry.io/api/678/envelope/";

/**
 * Build a Sentry envelope whose header names the given DSN.
 * @param {string} dsn - DSN for the envelope header.
 * @returns {string} Envelope text.
 */
function envelope(dsn = DSN) {
    return `${JSON.stringify({ dsn, sent_at: "2026-11-02T00:00:00.000Z" })}\n{"type":"event"}\n{"message":"x"}`;
}

/**
 * Build a fetch Response stand-in.
 * @param {number} status - HTTP status.
 * @param {Record<string, string>} [headers] - Response headers.
 * @returns {object} A response-like object with a `headers.get` lookup.
 */
function upstreamResponse(status, headers = {}) {
    return { status, headers: new Headers(headers) };
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete process.env.VITE_SENTRY_DSN;
    delete process.env.SENTRY_DSN;
});

describe("parseDsn", () => {
    it("parses a hosted DSN into its relay target", () => {
        expect(parseDsn(DSN)).toEqual({
            publicKey: "abc123",
            host: "o45.ingest.us.sentry.io",
            projectId: "678",
            envelopeUrl: ENVELOPE_URL,
        });
    });

    it("keeps a self-hosted path prefix and port", () => {
        expect(parseDsn("http://key@sentry.internal:9000/sentry/12/")).toEqual({
            publicKey: "key",
            host: "sentry.internal:9000",
            projectId: "12",
            envelopeUrl: "http://sentry.internal:9000/sentry/api/12/envelope/",
        });
    });

    it.each([
        ["a non-string", 42],
        ["an empty string", ""],
        ["an unparseable URL", "not a url"],
        ["a non-HTTP scheme", "ftp://key@host/1"],
        ["a DSN without a public key", "https://o45.ingest.sentry.io/678"],
        ["a DSN without a project", "https://key@o45.ingest.sentry.io/"],
        ["a non-numeric project", "https://key@o45.ingest.sentry.io/abc"],
    ])("rejects %s", (_label, dsn) => {
        expect(parseDsn(dsn)).toBeNull();
    });
});

describe("resolveTunnelTargets", () => {
    it("returns no targets without an environment", () => {
        expect(resolveTunnelTargets(undefined)).toEqual([]);
    });

    it("collects the browser and server DSNs and drops unusable ones", () => {
        const targets = resolveTunnelTargets({
            VITE_SENTRY_DSN: DSN,
            SENTRY_DSN: "not a dsn",
        });
        expect(targets.map((target) => target.envelopeUrl)).toEqual([ENVELOPE_URL]);
    });
});

describe("envelopeDsn", () => {
    it("reads the DSN from the first-line header", () => {
        expect(envelopeDsn(Buffer.from(envelope()))?.envelopeUrl).toBe(ENVELOPE_URL);
    });

    it("accepts a header-only envelope without a newline", () => {
        expect(envelopeDsn(Buffer.from(JSON.stringify({ dsn: DSN })))?.projectId).toBe("678");
    });

    it.each([
        ["invalid JSON", "{not json\n{}"],
        ["a null header", "null\n{}"],
        ["an array header", "[1]\n{}"],
        ["a header without a DSN", "{}\n{}"],
    ])("rejects %s", (_label, text) => {
        expect(envelopeDsn(Buffer.from(text))).toBeNull();
    });
});

describe("matchTarget", () => {
    const targets = [parseDsn(DSN)];

    it("matches the exact configured DSN", () => {
        expect(matchTarget(parseDsn(DSN), targets)).toBe(targets[0]);
    });

    it.each([
        ["another public key", "https://other@o45.ingest.us.sentry.io/678"],
        ["another project", "https://abc123@o45.ingest.us.sentry.io/999"],
        ["another host", "https://abc123@o99.ingest.us.sentry.io/678"],
        ["another scheme", "http://abc123@o45.ingest.us.sentry.io/678"],
        ["another path prefix", "https://abc123@o45.ingest.us.sentry.io/prefix/678"],
    ])("rejects %s", (_label, dsn) => {
        expect(matchTarget(parseDsn(dsn), targets)).toBeNull();
    });

    it("picks the target whose prefix matches when two DSNs share host, key, and project", () => {
        const prefixed = parseDsn("https://abc123@o45.ingest.us.sentry.io/prefix/678");
        expect(matchTarget(prefixed, [targets[0], prefixed])).toBe(prefixed);
    });
});

describe("sentry-tunnel handler", () => {
    it("rejects non-POST methods with 405", async () => {
        const res = mockResponse();
        await handler({ method: "GET", headers: {} }, res);
        expect(res.statusCode).toBe(405);
        expect(res.headers.Allow).toBe("POST");
        expect(res.ended).toBe(true);
    });

    it("returns 404 when no DSN is configured", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        const res = mockResponse();
        await handler({ method: "POST", headers: {}, body: envelope() }, res);
        expect(res.statusCode).toBe(404);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("forwards a text envelope to the configured project and relays rate limits", async () => {
        process.env.VITE_SENTRY_DSN = DSN;
        const fetchMock = vi
            .fn()
            .mockResolvedValue(upstreamResponse(429, { "Retry-After": "60", "X-Sentry-Rate-Limits": "60:error" }));
        vi.stubGlobal("fetch", fetchMock);

        const res = mockResponse();
        await handler({ method: "POST", headers: {}, body: envelope() }, res);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(ENVELOPE_URL);
        expect(init.method).toBe("POST");
        expect(init.headers["content-type"]).toBe("application/x-sentry-envelope");
        expect(init.body.toString("utf8")).toBe(envelope());
        expect(res.statusCode).toBe(429);
        expect(res.headers).toEqual({ "retry-after": "60", "x-sentry-rate-limits": "60:error" });
    });

    it("forwards a Buffer envelope through the server-side DSN", async () => {
        process.env.SENTRY_DSN = DSN;
        const fetchMock = vi.fn().mockResolvedValue(upstreamResponse(200));
        vi.stubGlobal("fetch", fetchMock);

        const res = mockResponse();
        await handler({ method: "POST", headers: {}, body: Buffer.from(envelope()) }, res);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBe(200);
        expect(res.headers).toEqual({});
    });

    it.each([
        ["an empty string", ""],
        ["an empty Buffer", Buffer.alloc(0)],
        ["null", null],
    ])("reads the stream when the pre-parsed body is %s", async (_label, body) => {
        process.env.VITE_SENTRY_DSN = DSN;
        const fetchMock = vi.fn().mockResolvedValue(upstreamResponse(200));
        vi.stubGlobal("fetch", fetchMock);

        const [header, ...rest] = envelope().split("\n");
        const res = mockResponse();
        await handler(streamRequest([`${header}\n`, Buffer.from(rest.join("\n"))], { body }), res);

        expect(fetchMock.mock.calls[0][1].body.toString("utf8")).toBe(envelope());
        expect(res.statusCode).toBe(200);
    });

    it("rejects a parsed JSON body with 400", async () => {
        process.env.VITE_SENTRY_DSN = DSN;
        const res = mockResponse();
        await handler({ method: "POST", headers: {}, body: { dsn: DSN } }, res);
        expect(res.statusCode).toBe(400);
    });

    it("returns 413 when a pre-parsed body exceeds the size cap", async () => {
        process.env.VITE_SENTRY_DSN = DSN;
        const res = mockResponse();
        await handler({ method: "POST", headers: {}, body: "a".repeat(300 * 1024) }, res);
        expect(res.statusCode).toBe(413);
    });

    it("returns 413 when a streamed body exceeds the size cap", async () => {
        process.env.VITE_SENTRY_DSN = DSN;
        const res = mockResponse();
        await handler(streamRequest([Buffer.alloc(300 * 1024, 0x61)]), res);
        expect(res.statusCode).toBe(413);
    });

    it("returns 400 when the body cannot be read", async () => {
        process.env.VITE_SENTRY_DSN = DSN;
        const res = mockResponse();
        await handler({ method: "POST", headers: {} }, res);
        expect(res.statusCode).toBe(400);
    });

    it("returns 400 for an envelope without a valid DSN header", async () => {
        process.env.VITE_SENTRY_DSN = DSN;
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        const res = mockResponse();
        await handler({ method: "POST", headers: {}, body: "{}\n{}" }, res);
        expect(res.statusCode).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses with 403 to relay to a project this deployment does not own", async () => {
        process.env.VITE_SENTRY_DSN = DSN;
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        const res = mockResponse();
        await handler(
            { method: "POST", headers: {}, body: envelope("https://attacker@o1.ingest.sentry.io/1") },
            res,
        );
        expect(res.statusCode).toBe(403);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns 502 when forwarding fails", async () => {
        process.env.VITE_SENTRY_DSN = DSN;
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
        const res = mockResponse();
        await handler({ method: "POST", headers: {}, body: envelope() }, res);
        expect(res.statusCode).toBe(502);
    });

    it("aborts a forward that outlives the timeout and returns 502", async () => {
        vi.useFakeTimers();
        process.env.VITE_SENTRY_DSN = DSN;
        vi.stubGlobal(
            "fetch",
            vi.fn(
                (_url, init) =>
                    new Promise((_resolve, reject) => {
                        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
                    }),
            ),
        );

        const res = mockResponse();
        const pending = handler({ method: "POST", headers: {}, body: envelope() }, res);
        await vi.advanceTimersByTimeAsync(5000);
        await pending;

        expect(res.statusCode).toBe(502);
    });
});
