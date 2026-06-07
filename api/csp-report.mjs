// First-party collector for Content-Security-Policy violation reports.
//
// The browser POSTs CSP reports here (configured via `report-uri` / `report-to`
// + `Reporting-Endpoints` in vercel.json). Keeping the endpoint same-origin means
// vercel.json never has to embed a Sentry org/project, and the forwarding secret
// stays server-side. CSP reports contain only violation metadata (blocked URI,
// violated directive, document URI) — never uploaded file contents — so this
// endpoint does not weaken the app's "data stays local" guarantee.
//
// Forwarding is opt-in and graceful: with no destination configured the function
// absorbs reports and returns 204, so the CSP directive is always valid.

const MAX_BODY_BYTES = 64 * 1024;

// Cap how long we wait on the upstream collector. Forwarding is best-effort, and
// the serverless function must still respond promptly, but it cannot truly
// fire-and-forget (pending work may be frozen once the response is sent), so the
// request is awaited with a bounded timeout instead.
const FORWARD_TIMEOUT_MS = 2000;

/**
 * Build an Error carrying an HTTP status code for the handler to surface.
 * @param {number} statusCode - HTTP status to send in the response.
 * @param {string} message - Error message.
 * @returns {Error} The error with a `statusCode` property attached.
 */
function httpError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

/**
 * Derive Sentry's security (CSP) report endpoint from a Sentry DSN.
 * @param {string} dsn - Sentry DSN, e.g. `https://<key>@<host>/<projectId>`.
 * @returns {string|null} The security endpoint URL, or null if the DSN is unusable.
 */
export function sentryReportUriFromDsn(dsn) {
    try {
        const url = new URL(dsn);
        const projectId = url.pathname.replace(/^\/+|\/+$/g, "");
        if (!url.username || !projectId) {
            return null;
        }
        return `${url.protocol}//${url.host}/api/${projectId}/security/?sentry_key=${url.username}`;
    } catch {
        return null;
    }
}

/**
 * Resolve the destination to forward CSP reports to, from server-side env vars.
 * Prefers an explicit `CSP_REPORT_URI`, then derives one from `SENTRY_DSN`.
 * @param {Record<string, string | undefined>} env - Environment variables.
 * @returns {string|null} The destination URL, or null when forwarding is disabled.
 */
export function resolveReportEndpoint(env) {
    if (env && env.CSP_REPORT_URI) {
        return env.CSP_REPORT_URI;
    }
    if (env && env.SENTRY_DSN) {
        return sentryReportUriFromDsn(env.SENTRY_DSN);
    }
    return null;
}

/**
 * Read the request body as a UTF-8 string, enforcing a hard size cap.
 * Handles both a pre-parsed `req.body` and a raw request stream.
 * @param {object} req - Incoming request (Node `IncomingMessage`-like).
 * @param {number} limit - Maximum allowed body size in bytes.
 * @returns {Promise<string>} The request body text.
 */
async function readReportBody(req, limit) {
    if (req.body !== undefined && req.body !== null) {
        const serialized = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
        if (Buffer.byteLength(serialized, "utf8") > limit) {
            throw httpError(413, "Payload too large");
        }
        return serialized;
    }

    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
        const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        size += buf.length;
        if (size > limit) {
            throw httpError(413, "Payload too large");
        }
        chunks.push(buf);
    }
    return Buffer.concat(chunks).toString("utf8");
}

/**
 * Vercel serverless handler that accepts and forwards CSP violation reports.
 * @param {object} req - Incoming request.
 * @param {object} res - Server response.
 * @returns {Promise<void>} Resolves once the response has been sent.
 */
export default async function handler(req, res) {
    if (req.method !== "POST") {
        res.statusCode = 405;
        res.setHeader("Allow", "POST");
        res.end();
        return;
    }

    let body;
    try {
        body = await readReportBody(req, MAX_BODY_BYTES);
    } catch (error) {
        res.statusCode = error && error.statusCode === 413 ? 413 : 400;
        res.end();
        return;
    }

    const endpoint = resolveReportEndpoint(process.env);
    if (endpoint && body) {
        const rawContentType = req.headers["content-type"];
        const contentType =
            (Array.isArray(rawContentType) ? rawContentType[0] : rawContentType) ||
            "application/csp-report";
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);
        try {
            await fetch(endpoint, {
                method: "POST",
                headers: {
                    "content-type": contentType,
                },
                body,
                signal: controller.signal,
            });
        } catch {
            // Best-effort forwarding: a failed or timed-out report must never affect the response.
        } finally {
            clearTimeout(timeout);
        }
    }

    res.statusCode = 204;
    res.end();
}
