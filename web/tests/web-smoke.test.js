import { describe, expect, it, vi } from "vitest";

import { normalizeBaseUrl, runWebSmoke } from "../../scripts/web-smoke.mjs";

const APP_HEADERS = {
    "content-security-policy": "default-src 'self'; report-uri /api/csp-report",
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy": "camera=()",
    "referrer-policy": "strict-origin-when-cross-origin",
    "strict-transport-security": "max-age=63072000",
    "x-content-type-options": "nosniff",
};

function response(status, body = "", headers = {}) {
    return new Response(status === 204 ? null : body, { status, headers });
}

function appShell() {
    return '<main id="appMain"><section id="screen-home"></section></main>';
}

describe("normalizeBaseUrl", () => {
    it("accepts http and https URLs", () => {
        expect(normalizeBaseUrl("https://example.com/app").toString()).toBe("https://example.com/app");
        expect(normalizeBaseUrl("http://localhost:3000").toString()).toBe("http://localhost:3000/");
    });

    it("rejects non-web URLs", () => {
        expect(() => normalizeBaseUrl("file:///tmp/index.html")).toThrow(/http or https/);
    });
});

describe("runWebSmoke", () => {
    it("passes when app shell, security headers, and CSP report endpoint are healthy", async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(response(200, appShell(), APP_HEADERS))
            .mockResolvedValueOnce(response(204));

        await expect(runWebSmoke("https://example.com", { fetchImpl })).resolves.toEqual({
            ok: true,
            url: "https://example.com/",
        });

        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(String(fetchImpl.mock.calls[0][0])).toBe("https://example.com/");
        expect(String(fetchImpl.mock.calls[1][0])).toBe("https://example.com/api/csp-report");
    });

    it("fails when a required security header is missing", async () => {
        const headers = { ...APP_HEADERS };
        delete headers["content-security-policy"];
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(response(200, appShell(), headers))
            .mockResolvedValueOnce(response(204));

        await expect(runWebSmoke("https://example.com", { fetchImpl })).rejects.toThrow(
            /missing header content-security-policy/,
        );
    });

    it("fails when app shell markers are missing", async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(response(200, "<main></main>", APP_HEADERS))
            .mockResolvedValueOnce(response(204));

        await expect(runWebSmoke("https://example.com", { fetchImpl })).rejects.toThrow(
            /app shell markers/,
        );
    });

    it("fails when the CSP report endpoint does not return 204", async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(response(200, appShell(), APP_HEADERS))
            .mockResolvedValueOnce(response(500));

        await expect(runWebSmoke("https://example.com", { fetchImpl })).rejects.toThrow(
            /csp-report returned HTTP 500/,
        );
    });
});
