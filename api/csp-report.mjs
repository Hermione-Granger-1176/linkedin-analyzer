// First-party collector for Content-Security-Policy violation reports.
//
// The browser POSTs CSP reports here (configured via `report-uri` / `report-to`
// + `Reporting-Endpoints` in vercel.json). Keeping the endpoint same-origin means
// vercel.json never has to embed a Sentry org/project, and the forwarding secret
// stays server-side. CSP reports contain only violation metadata (blocked URI,
// violated directive, document URI), never uploaded file contents, so this
// endpoint does not weaken the app's "data stays local" guarantee.
//
// Forwarding is opt-in and graceful: with no destination configured the function
// absorbs reports and returns 204, so the CSP directive is always valid.

const MAX_BODY_BYTES = 64 * 1024;

// Content types a CSP report may legitimately carry. The browser sends
// `application/csp-report` (report-uri) or `application/reports+json` (Reporting
// API). We forward using one of these rather than echoing the inbound header, so
// an attacker POSTing to this open endpoint cannot pick the upstream content type.
const ALLOWED_CONTENT_TYPES = new Set(["application/csp-report", "application/reports+json"]);
const DEFAULT_CONTENT_TYPE = "application/csp-report";

// Cap how long we wait on the upstream collector. Forwarding is best-effort, and
// the serverless function must still respond promptly, but it cannot truly
// fire-and-forget (pending work may be frozen once the response is sent), so the
// request is awaited with a bounded timeout instead.
const FORWARD_TIMEOUT_MS = 2000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const DEFAULT_REPORT_MAX_PER_MINUTE = 120;

let rateWindowStartedAt = 0;
let rateWindowCount = 0;
let rateWindowNoticeLogged = false;

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
 * Resolve the per-instance CSP report cap from server-side env vars.
 * @param {Record<string, string | undefined>|undefined} env - Environment variables.
 * @returns {number} Maximum reports per minute; 0 disables the guard.
 */
export function resolveReportMaxPerMinute(env) {
    const rawLimit = env && env.CSP_REPORT_MAX_PER_MINUTE;
    if (rawLimit === undefined) {
        return DEFAULT_REPORT_MAX_PER_MINUTE;
    }
    const trimmedLimit = rawLimit.trim();
    if (!/^\d+$/.test(trimmedLimit)) {
        return DEFAULT_REPORT_MAX_PER_MINUTE;
    }
    const parsed = Number(trimmedLimit);
    return parsed;
}

/**
 * Reset in-memory rate state for deterministic tests.
 * @returns {void}
 */
export function resetReportRateLimitForTests() {
    rateWindowStartedAt = 0;
    rateWindowCount = 0;
    rateWindowNoticeLogged = false;
}

/**
 * Return whether this valid CSP report should be dropped by the local rate guard.
 * @param {Record<string, string | undefined>|undefined} env - Environment variables.
 * @param {number} [now=Date.now()] - Current timestamp in milliseconds.
 * @param {(message: string) => void} [logFn=console.error] - Notice logger.
 * @returns {boolean} True when the report should be dropped.
 */
export function shouldDropReportForRateLimit(env, now = Date.now(), logFn = console.error) {
    const limit = resolveReportMaxPerMinute(env);
    if (limit === 0) {
        return false;
    }
    if (!rateWindowStartedAt || now - rateWindowStartedAt >= RATE_LIMIT_WINDOW_MS) {
        rateWindowStartedAt = now;
        rateWindowCount = 0;
        rateWindowNoticeLogged = false;
    }
    if (rateWindowCount >= limit) {
        if (!rateWindowNoticeLogged) {
            logFn("CSP report rate limit reached; dropping reports for this window.");
            rateWindowNoticeLogged = true;
        }
        return true;
    }
    rateWindowCount += 1;
    return false;
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
 * Parse a request body and extract the CSP violation it describes, supporting
 * both the legacy `report-uri` shape (`{"csp-report": {...}}`) and the Reporting
 * API shape (an array of `{type: "csp-violation", body: {...}}` entries).
 * @param {string} body - Raw request body text.
 * @returns {object|null} The violation object, or null if the body is not a CSP report.
 */
function parseCspReport(body) {
    let parsed;
    try {
        parsed = JSON.parse(body);
    } catch {
        return null;
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const report = parsed["csp-report"];
        return report && typeof report === "object" ? report : null;
    }
    if (Array.isArray(parsed)) {
        const entry = parsed.find(
            (item) => item && item.type === "csp-violation" && item.body && typeof item.body === "object",
        );
        return entry ? entry.body : null;
    }
    return null;
}

// Genuine CSP tokens: directive names and the non-URL keyword sources browsers
// put in blocked-uri (inline, eval, self, …) are all lowercase letters/hyphens.
const CSP_KEYWORD = /^[a-z][a-z-]*$/;
// Control characters, ASCII newlines, and the Unicode line/paragraph separators,
// collapsed to spaces so an attacker cannot inject extra or multi-line log entries.
const CONTROL_CHARS = /[\u0000-\u001f\u007f\u2028\u2029]+/g;

/**
 * Reduce an attacker-influenced field to a single safe log token: strip control
 * characters and newlines (no log injection / multi-line), trim, and bound length.
 * @param {unknown} value - Raw field value.
 * @param {number} maxLength - Maximum length to keep.
 * @returns {string} The sanitized token.
 */
function sanitizeToken(value, maxLength) {
    return String(value).replace(CONTROL_CHARS, " ").trim().slice(0, maxLength);
}

/**
 * Build a single-line, host-only summary of a CSP violation for log search.
 * This endpoint is public, so every field is treated as untrusted: the blocked
 * value is reduced to a host, a scheme, or a known keyword (never a path/query),
 * and all fields are stripped of newlines and length-bounded.
 * @param {object} report - A CSP violation object (either report shape).
 * @returns {string} A summary like `CSP violation: img-src blocked evil.example`.
 */
function summarizeReport(report) {
    const rawDirective = sanitizeToken(
        report["effective-directive"] ||
            report.effectiveDirective ||
            report["violated-directive"] ||
            report.violatedDirective ||
            "",
        64,
    );
    // Real directive names are lowercase letters/hyphens; reject anything else
    // (junk, coerced objects, or a value sanitized down to empty) as "unknown".
    const directive = CSP_KEYWORD.test(rawDirective) ? rawDirective : "unknown";
    const blockedUri = report["blocked-uri"] || report.blockedURL || "";
    let blocked = "(none)";
    if (typeof blockedUri === "string" && blockedUri) {
        try {
            const url = new URL(blockedUri);
            // Schemes like data:/blob: have no host; fall back to the scheme only
            // (never the full URI, which could embed inline content).
            blocked = url.host || url.protocol;
        } catch {
            // Not a URL: only echo genuine CSP keywords (inline, eval, self, …).
            // Anything else from this public endpoint becomes a placeholder so no
            // attacker-supplied path/query reaches the log.
            const token = sanitizeToken(blockedUri, 64);
            blocked = CSP_KEYWORD.test(token) ? token : "(non-url)";
        }
    }
    return `CSP violation: ${directive} blocked ${blocked}`;
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

    // Drop anything that is not a recognizable CSP report. The endpoint is open,
    // so this prevents it from being used to relay arbitrary bodies upstream.
    const report = body ? parseCspReport(body) : null;
    if (!report) {
        res.statusCode = 204;
        res.end();
        return;
    }

    if (shouldDropReportForRateLimit(process.env)) {
        res.statusCode = 204;
        res.end();
        return;
    }

    const endpoint = resolveReportEndpoint(process.env);
    if (endpoint) {
        const rawContentType = req.headers["content-type"];
        const inboundType = Array.isArray(rawContentType) ? rawContentType[0] : rawContentType;
        // Match on the media type alone (case-insensitive, parameters stripped) so
        // valid headers like "application/reports+json; charset=utf-8" are accepted,
        // but preserve the original header when forwarding so upstream parsing of
        // any charset parameter is unaffected.
        const baseType =
            typeof inboundType === "string" ? inboundType.split(";")[0].trim().toLowerCase() : "";
        const contentType = ALLOWED_CONTENT_TYPES.has(baseType)
            ? inboundType
            : DEFAULT_CONTENT_TYPE;
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
    } else {
        // With no forwarding destination, leave a one-line, host-only trace so
        // violations remain searchable in Vercel logs. Uses console.error because
        // it is the only console method the lint policy permits server-side and a
        // CSP violation is a security-relevant signal worth surfacing.
        console.error(summarizeReport(report));
    }

    res.statusCode = 204;
    res.end();
}
