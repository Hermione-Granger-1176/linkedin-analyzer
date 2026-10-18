import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorkerHandle } from "../../src/shared/worker-handle.js";

/** Stand-in Worker that records its listeners. */
class FakeWorker {
    constructor() {
        /** @type {Record<string, Function>} */
        this.listeners = {};
        this.terminate = vi.fn();
    }

    addEventListener(type, listener) {
        this.listeners[type] = listener;
    }

    removeEventListener(type, listener) {
        if (this.listeners[type] === listener) {
            delete this.listeners[type];
        }
    }
}

/**
 * Build a handle over FakeWorker.
 * @param {Partial<import("../../src/shared/worker-handle.js").WorkerHandleOptions>} [overrides] - Option overrides
 */
function handleWith(overrides = {}) {
    const onMessage = vi.fn();
    const onError = vi.fn();
    const handle = createWorkerHandle({
        create: () => /** @type {Worker} */ (/** @type {unknown} */ (new FakeWorker())),
        onMessage,
        onError,
        ...overrides,
    });
    return { handle, onMessage, onError };
}

describe("createWorkerHandle", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it("creates the worker once, wires its three listeners, and reuses it", () => {
        vi.stubGlobal("Worker", FakeWorker);
        const { handle, onMessage, onError } = handleWith();
        expect(handle.current()).toBeNull();

        const worker = /** @type {FakeWorker} */ (/** @type {unknown} */ (handle.ensure()));
        expect(handle.ensure()).toBe(worker);
        expect(handle.current()).toBe(worker);
        expect(worker.listeners).toEqual({
            message: onMessage,
            error: onError,
            messageerror: onError,
        });
    });

    it("returns null where Workers are missing", () => {
        vi.stubGlobal("Worker", undefined);
        const create = vi.fn();
        const { handle } = handleWith({ create });
        expect(handle.ensure()).toBeNull();
        expect(create).not.toHaveBeenCalled();
    });

    it("reports a worker that cannot start, and tolerates no reporter", () => {
        vi.stubGlobal("Worker", FakeWorker);
        const failure = new Error("blocked");
        const onStartError = vi.fn();
        const throwing = () => {
            throw failure;
        };
        expect(handleWith({ create: throwing, onStartError }).handle.ensure()).toBeNull();
        expect(onStartError).toHaveBeenCalledWith(failure);
        expect(handleWith({ create: throwing }).handle.ensure()).toBeNull();
    });

    it("terminates and detaches the worker, and is safe to repeat", () => {
        vi.stubGlobal("Worker", FakeWorker);
        const { handle } = handleWith();
        const worker = /** @type {FakeWorker} */ (/** @type {unknown} */ (handle.ensure()));
        handle.terminate();
        handle.terminate();
        expect(worker.terminate).toHaveBeenCalledTimes(1);
        expect(worker.listeners).toEqual({});
        expect(handle.current()).toBeNull();
    });

    it("fires the watchdog once, replaces an armed one, and clears on unwatch or terminate", () => {
        vi.useFakeTimers();
        const { handle } = handleWith();
        const first = vi.fn();
        const second = vi.fn();
        handle.watch(100, first);
        handle.watch(200, second);
        vi.advanceTimersByTime(250);
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);

        const unwatched = vi.fn();
        handle.watch(100, unwatched);
        handle.unwatch();
        handle.unwatch();
        const terminated = vi.fn();
        handle.watch(100, terminated);
        handle.terminate();
        vi.advanceTimersByTime(200);
        expect(unwatched).not.toHaveBeenCalled();
        expect(terminated).not.toHaveBeenCalled();
    });
});
