import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    loadRecentThreads,
    terminateThreadsWorker,
} from "../../../src/features/export/threads-transport.js";
import { captureError } from "../../../src/platform/observability/sentry.js";

vi.mock("../../../src/platform/observability/sentry.js", () => ({
    captureError: vi.fn(),
}));

const MESSAGES_CSV = [
    "CONVERSATION ID,FROM,TO,DATE,CONTENT,FOLDER,SENDER PROFILE URL,RECIPIENT PROFILE URLS",
    'c1,Sam Self,Ada,2025-01-01 10:00:00 UTC,"Hello Ada",INBOX,https://linkedin.com/in/sam,https://linkedin.com/in/ada',
    'c2,Sam Self,Bob,2025-01-03 10:00:00 UTC,"Hello Bob",INBOX,https://linkedin.com/in/sam,https://linkedin.com/in/bob',
].join("\n");

let workerInstance = null;
let constructorError = null;
let postMessageError = null;

class MockWorker {
    constructor() {
        if (constructorError) {
            throw constructorError;
        }
        this.listeners = new Map();
        this.terminate = vi.fn();
        this.postMessage = vi.fn(() => {
            if (postMessageError) {
                throw postMessageError;
            }
        });
        workerInstance = this;
    }

    addEventListener(type, callback) {
        const existing = this.listeners.get(type) || [];
        existing.push(callback);
        this.listeners.set(type, existing);
    }

    removeEventListener(type, callback) {
        const existing = this.listeners.get(type) || [];
        this.listeners.set(
            type,
            existing.filter((entry) => entry !== callback),
        );
    }

    emit(type, event) {
        for (const callback of [...(this.listeners.get(type) || [])]) {
            callback(event);
        }
    }
}

describe("loadRecentThreads", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
        workerInstance = null;
        constructorError = null;
        postMessageError = null;
        globalThis.Worker = MockWorker;
    });

    afterEach(() => {
        terminateThreadsWorker();
        vi.useRealTimers();
        delete globalThis.Worker;
    });

    it("returns nothing for blank input without starting a worker", async () => {
        expect(await loadRecentThreads("")).toEqual([]);
        expect(await loadRecentThreads(null)).toEqual([]);
        expect(workerInstance).toBeNull();
    });

    it("resolves with the worker's threads and terminates it", async () => {
        const pending = loadRecentThreads(MESSAGES_CSV, { people: 3, messagesPerPerson: 2 });
        const worker = workerInstance;
        const [request] = worker.postMessage.mock.calls[0];

        expect(request.type).toBe("threads");
        expect(request.payload).toMatchObject({
            messagesCsv: MESSAGES_CSV,
            people: 3,
            messagesPerPerson: 2,
        });

        worker.emit("message", {
            data: {
                type: "threads",
                requestId: request.requestId,
                payload: { success: true, threads: [{ name: "Ada", messages: [] }] },
            },
        });

        expect(await pending).toEqual([{ name: "Ada", messages: [] }]);
        expect(worker.terminate).toHaveBeenCalled();
    });

    it("ignores responses for other requests and invalid envelopes", async () => {
        const pending = loadRecentThreads(MESSAGES_CSV);
        const worker = workerInstance;
        const [request] = worker.postMessage.mock.calls[0];

        worker.emit("message", { data: { type: "nope" } });
        worker.emit("message", {
            data: { type: "threads", requestId: request.requestId + 99, payload: {} },
        });
        worker.emit("message", {
            data: {
                type: "threads",
                requestId: request.requestId,
                payload: { success: true, threads: [] },
            },
        });

        expect(await pending).toEqual([]);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "threads-message-parse",
            requestId: request.requestId,
        });
    });

    it("falls back to the main thread when the worker reports failure", async () => {
        const pending = loadRecentThreads(MESSAGES_CSV);
        const worker = workerInstance;
        const [request] = worker.postMessage.mock.calls[0];

        worker.emit("message", {
            data: {
                type: "threads",
                requestId: request.requestId,
                payload: { success: false, error: "bad csv" },
            },
        });

        expect((await pending).map((thread) => thread.name)).toEqual(["Bob", "Ada"]);
    });

    it("falls back to the main thread when the worker errors", async () => {
        const pending = loadRecentThreads(MESSAGES_CSV);
        workerInstance.emit("error", { type: "error", error: new Error("worker blew up") });

        expect((await pending).map((thread) => thread.name)).toEqual(["Bob", "Ada"]);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "threads-worker-error-event",
            requestId: expect.any(Number),
        });
    });

    it("reports a synthetic error when the event carries none", async () => {
        const pending = loadRecentThreads(MESSAGES_CSV);
        workerInstance.emit("messageerror", { type: "messageerror" });
        await pending;

        expect(captureError.mock.calls[0][0].message).toContain("messageerror");
    });

    it("falls back to the main thread when the worker times out", async () => {
        vi.useFakeTimers();
        const pending = loadRecentThreads(MESSAGES_CSV);
        vi.advanceTimersByTime(60000);
        vi.useRealTimers();

        expect((await pending).map((thread) => thread.name)).toEqual(["Bob", "Ada"]);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "threads-worker-timeout",
            requestId: expect.any(Number),
        });
    });

    it("falls back to the main thread when posting to the worker throws", async () => {
        postMessageError = new Error("clone failed");

        expect((await loadRecentThreads(MESSAGES_CSV)).map((thread) => thread.name)).toEqual([
            "Bob",
            "Ada",
        ]);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "threads-worker-post-message",
            requestId: expect.any(Number),
        });
    });

    it("falls back to the main thread when the worker cannot be constructed", async () => {
        constructorError = new Error("no workers here");

        expect((await loadRecentThreads(MESSAGES_CSV)).map((thread) => thread.name)).toEqual([
            "Bob",
            "Ada",
        ]);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "init-threads-worker",
        });
    });

    it("selects on the main thread when workers are unavailable", async () => {
        delete globalThis.Worker;

        expect((await loadRecentThreads(MESSAGES_CSV)).map((thread) => thread.name)).toEqual([
            "Bob",
            "Ada",
        ]);
    });

    it("returns nothing on the main thread when the CSV cannot be parsed", async () => {
        delete globalThis.Worker;

        expect(await loadRecentThreads("not,a,valid,csv")).toEqual([]);
    });

    it("skips the main-thread fallback for very large exports", async () => {
        delete globalThis.Worker;
        const huge = `${MESSAGES_CSV}\n${"# padding\n".repeat(600000)}`;

        expect(huge.length).toBeGreaterThan(5 * 1024 * 1024);
        expect(await loadRecentThreads(huge)).toEqual([]);
    });
});
