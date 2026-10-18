/**
 * Serve validated requests in a worker that processes uploaded data.
 *
 * Post fixed parser or runtime failure messages. Cancel global failure
 * events to prevent the browser from logging uploaded values.
 *
 * Global failures use ID 0. Request IDs start at 1, allowing the export
 * transport to distinguish a worker failure that permits fallback from
 * a parse failure for a specific request.
 */

/** @typedef {import("../app/worker-contracts.ts").RequestId} RequestId */

/** Id a global failure is answered under; no request is ever posted with it. */
export const GLOBAL_FAILURE_ID = 0;

/**
 * @template {{requestId: RequestId}} Request
 * @typedef {object} WorkerService
 * @property {string} requestType - Message type the worker answers; other messages are ignored
 * @property {(message: unknown) => import("../app/worker-contracts.ts").RequestParseResult<Request>} parse - Request parser
 * @property {(request: Request) => Promise<void>} handle - Serves a valid request and posts its reply
 * @property {(requestId: RequestId, error: string) => void} postFailure - Posts a failure reply carrying fixed text
 * @property {string} runtimeFailure - Fixed text for anything thrown
 */

/**
 * Start serving requests, and return the message handler so tests can drive it.
 * @template {{requestId: RequestId}} Request
 * @param {WorkerService<Request>} service - What the worker answers and how
 * @returns {(data: unknown) => Promise<void>} Answers one raw message
 */
export function serveWorker(service) {
    const { requestType, parse, handle, postFailure, runtimeFailure } = service;

    /** @param {unknown} data - Raw message data */
    const handleMessage = async (data) => {
        if (
            !data ||
            typeof data !== "object" ||
            /** @type {{type?: unknown}} */ (data).type !== requestType
        ) {
            return;
        }
        const parsed = parse(data);
        if (!parsed.valid) {
            postFailure(parsed.requestId, parsed.error);
            return;
        }
        try {
            await handle(parsed.value);
        } catch {
            postFailure(parsed.requestId, runtimeFailure);
        }
    };

    /** @param {Event} event - Failure event */
    const answerFailure = (event) => {
        event.preventDefault();
        postFailure(GLOBAL_FAILURE_ID, runtimeFailure);
    };

    // Every caller is a worker module; the guard only keeps a bare import safe.
    /* v8 ignore next 5 */
    if (typeof self !== "undefined") {
        self.addEventListener("message", (event) => handleMessage(event.data));
        self.addEventListener("error", answerFailure);
        self.addEventListener("unhandledrejection", answerFailure);
    }
    return handleMessage;
}
