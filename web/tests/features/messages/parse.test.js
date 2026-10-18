/**
 * Vitest tests for messages parsing on the page: the main-thread fallback, and
 * the worker lifecycle, where the worker is let go once it has answered unless
 * a newer request is already on its way.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { processFiles as processOnPage } from "../../../src/features/messages/parse.js";

vi.mock("../../../src/platform/observability/sentry.js", () => ({
    captureError: vi.fn(),
}));

const MESSAGES_CSV = [
    "CONVERSATION ID,FROM,TO,DATE,CONTENT,FOLDER,SENDER PROFILE URL,RECIPIENT PROFILE URLS",
    'abc,Ada,Bob,2025-01-01 10:00:00 UTC,"Hello there",INBOX,https://linkedin.com/in/ada,https://linkedin.com/in/bob',
].join("\n");

describe("processFiles main-thread fallback", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("keeps the messages and warns when Connections.csv will not read", async () => {
        vi.stubGlobal("Worker", undefined);
        vi.spyOn(FileReader.prototype, "readAsArrayBuffer").mockImplementation(function fail() {
            this.onerror();
        });

        const result = await processOnPage(MESSAGES_CSV, new Blob(["connections"]));

        expect(result.success).toBe(true);
        expect(result.totalInputRows).toBe(1);
        expect(result.connectionsData).toEqual([]);
        expect(result.connectionError).toBe("Unable to read Connections.csv.");
    });

    it("reports an unreadable messages file instead of rejecting", async () => {
        vi.stubGlobal("Worker", undefined);
        vi.spyOn(FileReader.prototype, "readAsArrayBuffer").mockImplementation(function fail() {
            this.onerror();
        });

        expect(await processOnPage(new Blob(["messages"]), "")).toEqual({
            success: false,
            error: "Unable to read messages.csv.",
        });
    });
});

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

    reply(requestId, payload = { success: true }) {
        const data = { type: "processed", requestId, payload };
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

    it("keeps the worker while an older request is still parsing", async () => {
        const { processFiles } = await loadParse();
        const first = processFiles("a", null);
        const second = processFiles("b", null);

        workers[0].reply(2);
        await expect(second).resolves.toEqual({ success: true });
        expect(workers[0].terminate).not.toHaveBeenCalled();

        workers[0].reply(1);
        await expect(first).resolves.toEqual({ success: true });
        expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    });

    it("falls back on every request when the worker answers a global failure", async () => {
        const { processFiles } = await loadParse();
        const first = processFiles("a", null);
        const second = processFiles("b", null);

        // Id 0 is the worker falling over outside any one request.
        workers[0].reply(0, { success: false, error: "Messages worker runtime failure." });

        await expect(first).resolves.not.toEqual({ success: true });
        await expect(second).resolves.not.toEqual({ success: true });
        expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    });

    it("gives a request queued behind a larger one its own budget after it", async () => {
        vi.useFakeTimers();
        try {
            const { processFiles } = await loadParse();
            // 4 MiB earns 50 seconds; the small request earns the 30 second base.
            const large = processFiles("x".repeat(4 * 1024 * 1024), null);
            const small = processFiles("b", null);

            // The small request's shorter budget does not cut the large one off.
            vi.advanceTimersByTime(31000);
            expect(workers[0].terminate).not.toHaveBeenCalled();
            workers[0].reply(1);
            await expect(large).resolves.toEqual({ success: true });

            // The small one is due 30 seconds after the large one was, at 80.
            vi.advanceTimersByTime(48000);
            expect(workers[0].terminate).not.toHaveBeenCalled();
            vi.advanceTimersByTime(2000);
            expect(workers[0].terminate).toHaveBeenCalledTimes(1);
            await expect(small).resolves.not.toEqual({ success: true });
        } finally {
            vi.useRealTimers();
        }
    });
});
