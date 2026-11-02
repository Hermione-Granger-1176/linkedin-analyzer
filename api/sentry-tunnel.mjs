// Same-origin relay for opt-in Sentry diagnostics.
//
// The browser SDK posts envelopes here (the `tunnel` option in
// web/src/platform/observability/sentry.js), so the CSP can keep
// `connect-src 'self'` instead of allowing every Sentry tenant's ingest host.
// A wildcard ingest allowance would let any script running in the page, such as
// a compromised dependency, post data to a Sentry project its author controls.
//
// The relay forwards only to the project named by this deployment's own DSN
// configuration, and only when the envelope header names that same DSN. It
// cannot reach another Sentry project or any other host. Forwarding from the
// server also keeps the visitor's IP address out of the Sentry request.

// Reduced events carry fixed-schema tags and a few stack frames, so real
// envelopes are a few kilobytes. The cap only bounds abuse.
const MAX_BODY_BYTES = 256 * 1024;
const FORWARD_TIMEOUT_MS = 5000;
const ENVELOPE_CONTENT_TYPE = "application/x-sentry-envelope";
// Sentry's rate-limit headers tell the SDK to back off; relay them unchanged.
const RELAYED_RESPONSE_HEADERS = ["retry-after", "x-sentry-rate-limits"];
const PROJECT_ID = /^\d+$/;

/**
 * Build an Error carrying an HTTP status code for the handler to send.
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
 * @typedef {object} ParsedDsn
 * @property {string} publicKey - DSN public key.
 * @property {string} host - Ingest host, with port when present.
 * @property {string} projectId - Numeric Sentry project ID.
 * @property {string} envelopeUrl - Sentry envelope endpoint for this project.
 */

/**
 * Parse a Sentry DSN into the parts the relay compares and forwards to.
 * @param {unknown} dsn - Sentry DSN, e.g. `https://<key>@<host>/<projectId>`.
 * @returns {ParsedDsn|null} The parsed DSN, or null when it is unusable.
 */
export function parseDsn(dsn) {
    if (typeof dsn !== "string" || !dsn) {
        return null;
    }
    let url;
    try {
        url = new URL(dsn);
    } catch {
        return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        return null;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    const projectId = segments.pop();
    if (!url.username || !projectId || !PROJECT_ID.test(projectId)) {
        return null;
    }
    // Self-hosted Sentry can serve from a path prefix; keep it in the target.
    const prefix = segments.length ? `/${segments.join("/")}` : "";
    return {
        publicKey: url.username,
        host: url.host,
        projectId,
        envelopeUrl: `${url.protocol}//${url.host}${prefix}/api/${projectId}/envelope/`,
    };
}

/**
 * Resolve the DSNs this deployment may relay to, from server-side env vars.
 * The browser DSN is the usual target; `SENTRY_DSN` is accepted as well so a
 * deployment that sets only the server-side variable still works.
 * @param {Record<string, string | undefined>|undefined} env - Environment variables.
 * @returns {ParsedDsn[]} Allowed relay targets, possibly empty.
 */
export function resolveTunnelTargets(env) {
    if (!env) {
        return [];
    }
    return [env.VITE_SENTRY_DSN, env.SENTRY_DSN].map(parseDsn).filter((target) => target !== null);
}

/**
 * Read the DSN named in an envelope's first-line JSON header.
 * @param {Buffer} body - Raw envelope bytes.
 * @returns {ParsedDsn|null} The envelope's DSN, or null when the header is invalid.
 */
export function envelopeDsn(body) {
    const newline = body.indexOf(0x0a);
    const headerText = body.subarray(0, newline === -1 ? body.length : newline).toString("utf8");
    let header;
    try {
        header = JSON.parse(headerText);
    } catch {
        return null;
    }
    if (!header || typeof header !== "object" || Array.isArray(header)) {
        return null;
    }
    return parseDsn(header.dsn);
}

/**
 * Find the configured target that an envelope's DSN names exactly.
 * @param {ParsedDsn} dsn - DSN from the envelope header.
 * @param {ParsedDsn[]} targets - Allowed relay targets.
 * @returns {ParsedDsn|null} The matching target, or null.
 */
export function matchTarget(dsn, targets) {
    return (
        targets.find(
            (target) =>
                target.host === dsn.host &&
                target.projectId === dsn.projectId &&
                target.publicKey === dsn.publicKey,
        ) || null
    );
}

/**
 * Read the request body as bytes, enforcing a hard size cap. Vercel pre-parses
 * `text/plain` bodies (the SDK's default for string envelopes) into a string
 * and `application/octet-stream` bodies into a Buffer. A request without a
 * content type gets an empty pre-parsed string while its stream stays unread,
 * so an empty pre-parsed body falls back to the stream.
 * @param {object} req - Incoming request (Node `IncomingMessage`-like).
 * @param {number} limit - Maximum allowed body size in bytes.
 * @returns {Promise<Buffer>} The request body.
 */
async function readEnvelopeBody(req, limit) {
    const preParsed = req.body;
    let body;
    if (Buffer.isBuffer(preParsed) && preParsed.length) {
        body = preParsed;
    } else if (typeof preParsed === "string" && preParsed) {
        body = Buffer.from(preParsed, "utf8");
    } else if (preParsed && typeof preParsed === "object" && !Buffer.isBuffer(preParsed)) {
        // A parsed JSON or form body is not a Sentry envelope.
        throw httpError(400, "Unsupported body");
    } else {
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
        body = Buffer.concat(chunks);
    }
    if (body.length > limit) {
        throw httpError(413, "Payload too large");
    }
    return body;
}

/**
 * Forward an envelope to Sentry.
 * @param {ParsedDsn} target - Configured relay target.
 * @param {Buffer} body - Envelope bytes.
 * @returns {Promise<Response|null>} Sentry's response, or null when forwarding failed.
 */
async function forwardEnvelope(target, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);
    try {
        return await fetch(target.envelopeUrl, {
            method: "POST",
            headers: { "content-type": ENVELOPE_CONTENT_TYPE },
            body,
            signal: controller.signal,
        });
    } catch {
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Send an empty response with the given status.
 * @param {object} res - Server response.
 * @param {number} statusCode - HTTP status.
 */
function sendEmpty(res, statusCode) {
    res.statusCode = statusCode;
    res.end();
}

/**
 * Vercel serverless handler that relays Sentry envelopes to the configured project.
 * @param {object} req - Incoming request.
 * @param {object} res - Server response.
 * @returns {Promise<void>} Resolves once the response has been sent.
 */
export default async function handler(req, res) {
    if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        sendEmpty(res, 405);
        return;
    }

    const targets = resolveTunnelTargets(process.env);
    if (!targets.length) {
        sendEmpty(res, 404);
        return;
    }

    let body;
    try {
        body = await readEnvelopeBody(req, MAX_BODY_BYTES);
    } catch (error) {
        sendEmpty(res, error && error.statusCode === 413 ? 413 : 400);
        return;
    }

    const dsn = envelopeDsn(body);
    if (!dsn) {
        sendEmpty(res, 400);
        return;
    }
    const target = matchTarget(dsn, targets);
    if (!target) {
        sendEmpty(res, 403);
        return;
    }

    const upstream = await forwardEnvelope(target, body);
    if (!upstream) {
        sendEmpty(res, 502);
        return;
    }
    for (const name of RELAYED_RESPONSE_HEADERS) {
        const value = upstream.headers.get(name);
        if (value) {
            res.setHeader(name, value);
        }
    }
    sendEmpty(res, upstream.status);
}
