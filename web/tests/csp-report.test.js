import { afterEach, describe, expect, it, vi } from "vitest";

import handler, { resolveReportEndpoint, sentryReportUriFromDsn } from "../../api/csp-report.mjs";

/**
 * Build a mock request whose body is delivered as an async stream of chunks.
 * @param {Array<string | Buffer>} chunks - Body chunks to yield.
 * @param {object} [options] - Overrides for method, headers, and body.
 * @returns {object} A request-like object.
 */
function streamRequest(chunks, options = {}) {
    const { method = "POST", headers = {}, body } = options;
    return {
        method,
        headers,
        body,
        async *[Symbol.asyncIterator]() {
            for (const chunk of chunks) {
                yield chunk;
            }
        },
    };
}

/**
 * Build a mock response capturing status, headers, and end state.
 * @returns {object} A response-like object.
 */
function mockResponse() {
    return {
        statusCode: 0,
        headers: {},
        ended: false,
        setHeader(key, value) {
            this.headers[key] = value;
        },
        end() {
            this.ended = true;
        },
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CSP_REPORT_URI;
    delete process.env.SENTRY_DSN;
});

describe("sentryReportUriFromDsn", () => {
    it("derives the security endpoint from a valid DSN", () => {
        expect(sentryReportUriFromDsn("https://abc123@o45.ingest.sentry.io/678")).toBe(
            "https://o45.ingest.sentry.io/api/678/security/?sentry_key=abc123",
        );
    });

    it("returns null when the DSN has no project id", () => {
        expect(sentryReportUriFromDsn("https://abc123@o45.ingest.sentry.io/")).toBeNull();
    });

    it("returns null when the DSN has no public key", () => {
        expect(sentryReportUriFromDsn("https://o45.ingest.sentry.io/678")).toBeNull();
    });

    it("returns null for a malformed DSN", () => {
        expect(sentryReportUriFromDsn("not a url")).toBeNull();
    });
});

describe("resolveReportEndpoint", () => {
    it("prefers an explicit CSP_REPORT_URI", () => {
        expect(
            resolveReportEndpoint({
                CSP_REPORT_URI: "https://collector.example/report",
                SENTRY_DSN: "https://abc123@o45.ingest.sentry.io/678",
            }),
        ).toBe("https://collector.example/report");
    });

    it("derives from SENTRY_DSN when no explicit URI is set", () => {
        expect(resolveReportEndpoint({ SENTRY_DSN: "https://abc123@o45.ingest.sentry.io/678" })).toBe(
            "https://o45.ingest.sentry.io/api/678/security/?sentry_key=abc123",
        );
    });

    it("returns null when nothing is configured", () => {
        expect(resolveReportEndpoint({})).toBeNull();
    });

    it("returns null for a missing env object", () => {
        expect(resolveReportEndpoint(undefined)).toBeNull();
    });
});

describe("csp-report handler", () => {
    it("rejects non-POST methods with 405", async () => {
        const res = mockResponse();
        await handler({ method: "GET", headers: {} }, res);
        expect(res.statusCode).toBe(405);
        expect(res.headers.Allow).toBe("POST");
        expect(res.ended).toBe(true);
    });

    it("forwards a parsed object body to the configured endpoint and returns 204", async () => {
        process.env.CSP_REPORT_URI = "https://collector.example/report";
        const fetchMock = vi.fn().mockResolvedValue({});
        vi.stubGlobal("fetch", fetchMock);

        const report = { "csp-report": { "violated-directive": "style-src-attr" } };
        const res = mockResponse();
        await handler({ method: "POST", headers: {}, body: report }, res);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe("https://collector.example/report");
        expect(init.method).toBe("POST");
        expect(init.body).toBe(JSON.stringify(report));
        expect(init.headers["content-type"]).toBe("application/csp-report");
        expect(res.statusCode).toBe(204);
    });

    it("forwards a string body and preserves the request content-type", async () => {
        process.env.CSP_REPORT_URI = "https://collector.example/report";
        const fetchMock = vi.fn().mockResolvedValue({});
        vi.stubGlobal("fetch", fetchMock);

        const res = mockResponse();
        await handler(
            { method: "POST", headers: { "content-type": "application/reports+json" }, body: "[]" },
            res,
        );

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [, init] = fetchMock.mock.calls[0];
        expect(init.body).toBe("[]");
        expect(init.headers["content-type"]).toBe("application/reports+json");
        expect(res.statusCode).toBe(204);
    });

    it("reads a streamed body and does not forward when no endpoint is configured", async () => {
        const fetchMock = vi.fn().mockResolvedValue({});
        vi.stubGlobal("fetch", fetchMock);

        const res = mockResponse();
        await handler(streamRequest(['{"csp-report":', "{}}"], { body: null }), res);

        expect(fetchMock).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(204);
    });

    it("does not forward an empty body", async () => {
        process.env.CSP_REPORT_URI = "https://collector.example/report";
        const fetchMock = vi.fn().mockResolvedValue({});
        vi.stubGlobal("fetch", fetchMock);

        const res = mockResponse();
        await handler(streamRequest([]), res);

        expect(fetchMock).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(204);
    });

    it("returns 413 when a parsed body exceeds the size cap", async () => {
        const res = mockResponse();
        await handler({ method: "POST", headers: {}, body: { data: "a".repeat(70 * 1024) } }, res);
        expect(res.statusCode).toBe(413);
    });

    it("returns 413 when a streamed body exceeds the size cap", async () => {
        const res = mockResponse();
        await handler(streamRequest([Buffer.alloc(70 * 1024, 0x61)]), res);
        expect(res.statusCode).toBe(413);
    });

    it("returns 400 when the body cannot be read", async () => {
        const res = mockResponse();
        await handler({ method: "POST", headers: {} }, res);
        expect(res.statusCode).toBe(400);
    });

    it("still returns 204 when forwarding fails", async () => {
        process.env.CSP_REPORT_URI = "https://collector.example/report";
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

        const res = mockResponse();
        await handler({ method: "POST", headers: {}, body: { "csp-report": {} } }, res);

        expect(res.statusCode).toBe(204);
    });
});
