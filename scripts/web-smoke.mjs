import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MS = 10_000;

const REQUIRED_APP_HEADERS = [
    {
        name: "content-security-policy",
        validate: (value) =>
            value.includes("default-src 'self'") && value.includes("report-uri /api/csp-report"),
    },
    {
        name: "x-content-type-options",
        validate: (value) => value.toLowerCase() === "nosniff",
    },
    {
        name: "referrer-policy",
        validate: (value) => value.toLowerCase() === "strict-origin-when-cross-origin",
    },
    {
        name: "permissions-policy",
        validate: (value) => value.includes("camera=()"),
    },
    {
        name: "cross-origin-opener-policy",
        validate: (value) => value.toLowerCase() === "same-origin",
    },
];

/**
 * Normalize and validate a web app base URL.
 * @param {string} rawUrl - URL passed on the command line.
 * @returns {URL} Normalized URL ending at the origin or configured path.
 */
export function normalizeBaseUrl(rawUrl) {
    if (!rawUrl) {
        throw new Error("A URL is required.");
    }
    const url = new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error("URL must use http or https.");
    }
    return url;
}

/**
 * Read a response header case-insensitively.
 * @param {Headers} headers - Fetch response headers.
 * @param {string} name - Header name.
 * @returns {string} Header value, or an empty string when missing.
 */
function getHeader(headers, name) {
    return headers && typeof headers.get === "function" ? headers.get(name) || "" : "";
}

/**
 * Return an informative message for any caught JavaScript value.
 * @param {unknown} error - Caught value.
 * @returns {string} Human-readable error message.
 */
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Fetch with a bounded timeout.
 * @param {Function} fetchImpl - Fetch implementation.
 * @param {URL} url - Request URL.
 * @param {object} init - Fetch options.
 * @param {number} timeoutMs - Timeout in milliseconds.
 * @returns {Promise<Response>} Fetch response.
 */
async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Validate app shell response headers.
 * @param {Response} response - App shell response.
 * @param {URL} baseUrl - Base URL under test.
 * @returns {string[]} Validation failures.
 */
function validateAppHeaders(response, baseUrl) {
    const failures = [];
    for (const header of REQUIRED_APP_HEADERS) {
        const value = getHeader(response.headers, header.name);
        if (!value) {
            failures.push(`missing header ${header.name}`);
            continue;
        }
        if (!header.validate(value)) {
            failures.push(`unexpected header ${header.name}: ${value}`);
        }
    }
    const hsts = getHeader(response.headers, "strict-transport-security");
    if (baseUrl.protocol === "https:" && !hsts) {
        failures.push("missing header strict-transport-security");
    }
    return failures;
}

/**
 * Run a lightweight HTTP smoke check against the deployed web app.
 * @param {string} rawUrl - Web app base URL.
 * @param {object} [options] - Optional fetch and timeout overrides.
 * @param {Function} [options.fetchImpl=fetch] - Fetch implementation.
 * @param {number} [options.timeoutMs=10000] - Timeout per request.
 * @returns {Promise<{ok: boolean, url: string}>} Smoke result.
 */
export async function runWebSmoke(
    rawUrl,
    { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
    const baseUrl = normalizeBaseUrl(rawUrl);
    if (typeof fetchImpl !== "function") {
        throw new Error("No fetch implementation is available.");
    }

    const failures = [];
    const appUrl = new URL(baseUrl);
    if (!appUrl.pathname.endsWith("/")) {
        appUrl.pathname += "/";
    }
    let appResponse;
    try {
        appResponse = await fetchWithTimeout(fetchImpl, appUrl, { method: "GET" }, timeoutMs);
    } catch (error) {
        failures.push(`app shell request failed: ${errorMessage(error)}`);
    }

    if (appResponse) {
        if (appResponse.status < 200 || appResponse.status >= 400) {
            failures.push(`app shell returned HTTP ${appResponse.status}`);
        }
        failures.push(...validateAppHeaders(appResponse, baseUrl));
        const body = await appResponse.text();
        if (!body.includes('id="appMain"') || !body.includes('id="screen-home"')) {
            failures.push("app shell markers were not found");
        }
    }

    const reportUrl = new URL("/api/csp-report", baseUrl);
    try {
        const reportResponse = await fetchWithTimeout(
            fetchImpl,
            reportUrl,
            {
                method: "POST",
                headers: { "content-type": "application/csp-report" },
                body: JSON.stringify({
                    "csp-report": {
                        "violated-directive": "script-src",
                        "blocked-uri": "inline",
                    },
                }),
            },
            timeoutMs,
        );
        if (reportResponse.status !== 204) {
            failures.push(`/api/csp-report returned HTTP ${reportResponse.status}`);
        }
    } catch (error) {
        failures.push(`csp report request failed: ${errorMessage(error)}`);
    }

    if (failures.length) {
        throw new Error(`Web smoke check failed:\n- ${failures.join("\n- ")}`);
    }
    return { ok: true, url: baseUrl.toString() };
}

async function main(argv) {
    try {
        const result = await runWebSmoke(argv[2]);
        console.log(`OK: web smoke check passed for ${result.url}`);
    } catch (error) {
        console.error(errorMessage(error));
        process.exitCode = 1;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main(process.argv);
}
