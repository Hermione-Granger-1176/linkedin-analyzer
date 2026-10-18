/**
 * Serve one kind of request in a worker.
 *
 * Every worker that holds an upload is handed the user's own text, so every
 * failure inside it is assumed to carry some of it: a row, a name, a profile
 * URL or a message body. Two rules follow. The only failure text that leaves
 * the worker is a fixed string: the request parser's own message for a request
 * it rejects, or the worker's runtime failure literal for anything thrown. And
 * every global failure event is cancelled, so the browser's own reporting,
 * which writes the original message to the console, never runs.
 *
 * A global failure is answered under id 0, never under the id of the request
 * being served. Real ids start at 1, so the page can tell a worker that fell
 * over, which says nothing about the file, from one that answered that it
 * could not read it: the export transports fall back to the main thread on the
 * first and give up on the second. Cancelling the event also stops it reaching
 * the page as an `error` event on the Worker, so this reply is the only signal.
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
