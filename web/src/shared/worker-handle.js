/**
 * One long-lived worker and its watchdog, owned by a screen or client.
 *
 * The screens and clients that talk to a worker each carried the same
 * lifecycle: create it lazily with its three listeners, terminate it, and arm or
 * clear one watchdog timer. What a reply means stays with each owner; this is
 * only the plumbing around it.
 */

/**
 * @typedef {object} WorkerHandleOptions
 * @property {() => Worker} create - Construct the worker
 * @property {(event: MessageEvent) => void} onMessage - Reply listener
 * @property {(event: ErrorEvent|MessageEvent) => void} onError - `error` and `messageerror` listener
 * @property {(error: unknown) => void} [onStartError] - Called when construction throws
 */

/**
 * @typedef {object} WorkerHandle
 * @property {() => Worker|null} ensure - The worker, created on first use; null when workers are unavailable or blocked
 * @property {() => Worker|null} current - The worker if one is running, without creating it
 * @property {() => void} terminate - Terminate the worker and clear the watchdog; safe to repeat
 * @property {(ms: number, onTimeout: () => void) => void} watch - Arm the watchdog, replacing any armed one
 * @property {() => void} unwatch - Clear the watchdog
 */

/**
 * Create a lazily started worker with one watchdog.
 * @param {WorkerHandleOptions} options - How to build the worker and where its events go
 * @returns {WorkerHandle}
 */
export function createWorkerHandle(options) {
    const { create, onMessage, onError, onStartError } = options;
    /** @type {Worker|null} */
    let worker = null;
    /** @type {number|null} */
    let timeoutId = null;

    const unwatch = () => {
        if (timeoutId === null) {
            return;
        }
        window.clearTimeout(timeoutId);
        timeoutId = null;
    };

    return {
        ensure() {
            if (worker || typeof Worker === "undefined") {
                return worker;
            }
            try {
                worker = create();
                worker.addEventListener("message", onMessage);
                worker.addEventListener("error", onError);
                worker.addEventListener("messageerror", onError);
            } catch (error) {
                worker = null;
                if (onStartError) {
                    onStartError(error);
                }
            }
            return worker;
        },
        current: () => worker,
        terminate() {
            unwatch();
            if (worker) {
                // Detached as well as terminated, so the handlers, and whatever
                // they close over, are not kept alive by the dead worker.
                worker.removeEventListener("message", onMessage);
                worker.removeEventListener("error", onError);
                worker.removeEventListener("messageerror", onError);
                worker.terminate();
                worker = null;
            }
        },
        watch(ms, onTimeout) {
            unwatch();
            timeoutId = window.setTimeout(() => {
                timeoutId = null;
                onTimeout();
            }, ms);
        },
        unwatch,
    };
}
