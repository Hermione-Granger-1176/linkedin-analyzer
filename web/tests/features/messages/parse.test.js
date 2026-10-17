/**
 * Vitest tests for the Messages screen's worker lifecycle: the worker is let
 * go once it has answered, unless a newer request is already on its way.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** @type {{postMessage: import("vitest").Mock, terminate: import("vitest").Mock, listeners: Record<string, Function[]>}[]} */
let workers = [];

/** Stand-in Worker that records what it is sent and lets a test reply. */
class FakeWorker {
    constructor() {
        this.listeners = {};
        this.postMessage = vi.fn();
        this.terminate = vi.fn();
        workers.push(this);
    }

    addEventListener(type, listener) {
        (this.listeners[type] ||= []).push(listener);
    }

    removeEventListener(type, listener) {
        this.listeners[type] = (this.listeners[type] || []).filter((item) => item !== listener);
    }

    reply(requestId) {
        const data = { type: "processed", requestId, payload: { success: true } };
        [...(this.listeners.message || [])].forEach((listener) => listener({ data }));
    }
}

/**
 * Load a fresh copy of the module, so each test starts without a worker.
 * @returns {Promise<typeof import("../../../src/features/messages/parse.js")>}
 */
function loadParse() {
    vi.resetModules();
    return import("../../../src/features/messages/parse.js");
}

describe("messages parse worker lifecycle", () => {
    beforeEach(() => {
        workers = [];
        vi.stubGlobal("Worker", FakeWorker);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("terminates the worker once it has answered", async () => {
        const { processFiles } = await loadParse();
        const pending = processFiles("a", null);
        workers[0].reply(1);
        await expect(pending).resolves.toEqual({ success: true });
        expect(workers[0].terminate).toHaveBeenCalledTimes(1);

        // The next parse starts a fresh worker.
        const next = processFiles("b", null);
        expect(workers).toHaveLength(2);
        workers[1].reply(2);
        await next;
    });

    it("keeps the worker while a newer request is on its way", async () => {
        const { processFiles } = await loadParse();
        const first = processFiles("a", null);
        const second = processFiles("b", null);
        expect(workers).toHaveLength(1);

        workers[0].reply(1);
        await first;
        expect(workers[0].terminate).not.toHaveBeenCalled();

        workers[0].reply(2);
        await expect(second).resolves.toEqual({ success: true });
        expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    });
});
