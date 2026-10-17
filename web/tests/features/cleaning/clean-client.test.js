import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAIN_THREAD_MAX_FILE_BYTES } from "../../../src/shared/limits.js";

const mocks = vi.hoisted(() => ({
    runCleanJob: vi.fn(),
    captureError: vi.fn(),
}));

vi.mock("../../../src/features/cleaning/clean-job.js", () => ({
    runCleanJob: mocks.runCleanJob,
}));

vi.mock("../../../src/platform/observability/sentry.js", () => ({
    captureError: mocks.captureError,
}));

const PAYLOAD = { fileType: "shares", output: "preview", source: "a,b", key: "shares:1" };
const OK = { success: true, error: null, rowCount: 1, previewRows: [["x"]], blob: null };
const FAILED = {
    success: false,
    error: "Unable to parse file.",
    rowCount: 0,
    previewRows: [],
    blob: null,
};

/** @type {FakeWorker[]} */
let workers = [];

class FakeWorker {
    constructor() {
        this.listeners = {};
        this.posted = [];
        this.terminate = vi.fn();
        workers.push(this);
    }

    addEventListener(type, listener) {
        this.listeners[type] = listener;
    }

    postMessage(message) {
        this.posted.push(message);
    }

    emit(type, data) {
        this.listeners[type]({ data });
    }

    reply(requestId, payload = OK) {
        this.emit("message", { type: "cleaned", requestId, payload });
    }
}

/**
 * Load a fresh copy of the client, so each test starts without a worker.
 * @returns {Promise<typeof import("../../../src/features/cleaning/clean-client.js")>}
 */
function loadClient() {
    vi.resetModules();
    return import("../../../src/features/cleaning/clean-client.js");
}

describe("clean client", () => {
    beforeEach(() => {
        workers = [];
        mocks.runCleanJob.mockReset();
        mocks.captureError.mockReset();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it("runs on the main thread where Workers are missing", async () => {
        vi.stubGlobal("Worker", undefined);
        mocks.runCleanJob.mockResolvedValue(OK);
        const { requestClean } = await loadClient();
        await expect(requestClean(PAYLOAD)).resolves.toEqual(OK);
        expect(mocks.runCleanJob).toHaveBeenCalledWith(PAYLOAD);
    });

    it.each([
        // A stand-in reporting the size keeps the test from allocating a Blob.
        ["a Blob", { size: MAIN_THREAD_MAX_FILE_BYTES + 1 }],
        // repeat() builds a rope, so this long string stays cheap.
        ["text", "x".repeat(MAIN_THREAD_MAX_FILE_BYTES + 1)],
    ])("refuses %s above the main-thread limit without running the job", async (_, source) => {
        vi.stubGlobal("Worker", undefined);
        const { requestClean } = await loadClient();
        const reply = await requestClean({ ...PAYLOAD, source });
        expect(reply).toMatchObject({ success: false, rowCount: 0, blob: null });
        expect(reply.error).toContain("too large to clean without background workers");
        expect(mocks.runCleanJob).not.toHaveBeenCalled();
    });

    it("reports a fixed error when the main-thread job throws", async () => {
        vi.stubGlobal("Worker", undefined);
        mocks.runCleanJob.mockRejectedValue(new Error("row with a name in it"));
        const { requestClean } = await loadClient();
        await expect(requestClean(PAYLOAD)).resolves.toEqual(FAILED);
        expect(mocks.captureError).toHaveBeenCalledWith(new Error("Unable to parse file."), {
            module: "clean",
            operation: "main-thread-clean",
        });
    });

    it("falls back to the main thread when the worker cannot start", async () => {
        vi.stubGlobal(
            "Worker",
            class {
                constructor() {
                    throw new Error("blocked");
                }
            },
        );
        mocks.runCleanJob.mockResolvedValue(OK);
        const { requestClean } = await loadClient();
        await expect(requestClean(PAYLOAD)).resolves.toEqual(OK);
        expect(mocks.captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "clean",
            operation: "worker-init",
        });
    });

    it("posts the request and settles on its own reply", async () => {
        vi.stubGlobal("Worker", FakeWorker);
        const { requestClean } = await loadClient();
        const result = requestClean(PAYLOAD);
        const [worker] = workers;
        expect(worker.posted).toEqual([{ type: "clean", requestId: 1, payload: PAYLOAD }]);
        worker.emit("message", { type: "other" });
        worker.reply(99);
        worker.reply(1);
        await expect(result).resolves.toEqual(OK);
        // A late reply with nothing in flight is ignored.
        worker.reply(1);
        // The worker is reused for the next request.
        const next = requestClean(PAYLOAD);
        expect(workers).toHaveLength(1);
        worker.reply(2);
        await expect(next).resolves.toEqual(OK);
    });

    it("fails a request that a newer one supersedes", async () => {
        vi.stubGlobal("Worker", FakeWorker);
        const { requestClean } = await loadClient();
        const first = requestClean(PAYLOAD);
        const second = requestClean(PAYLOAD);
        await expect(first).resolves.toEqual(FAILED);
        workers[0].reply(2);
        await expect(second).resolves.toEqual(OK);
    });

    it("terminates the worker on a timeout and starts a new one next time", async () => {
        vi.useFakeTimers();
        vi.stubGlobal("Worker", FakeWorker);
        const { requestClean } = await loadClient();
        const result = requestClean({ ...PAYLOAD, output: "xlsx" });
        vi.runOnlyPendingTimers();
        await expect(result).resolves.toEqual(FAILED);
        expect(workers[0].terminate).toHaveBeenCalled();
        expect(mocks.captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "clean",
            operation: "worker-timeout",
        });
        requestClean(PAYLOAD);
        expect(workers).toHaveLength(2);
    });

    it("fails and terminates on a worker error event", async () => {
        vi.stubGlobal("Worker", FakeWorker);
        const { requestClean } = await loadClient();
        const result = requestClean(PAYLOAD);
        workers[0].emit("error");
        // A second error from the same worker finds nothing left to tear down.
        workers[0].emit("error");
        await expect(result).resolves.toEqual(FAILED);
        expect(workers[0].terminate).toHaveBeenCalledTimes(1);
        expect(workers[0].terminate).toHaveBeenCalled();
        expect(mocks.captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "clean",
            operation: "worker-error",
        });
    });

    it("fails when the request cannot be posted", async () => {
        vi.stubGlobal("Worker", FakeWorker);
        const { requestClean } = await loadClient();
        requestClean(PAYLOAD);
        workers[0].postMessage = () => {
            throw new Error("DataCloneError");
        };
        await expect(requestClean(PAYLOAD)).resolves.toEqual(FAILED);
        expect(workers[0].terminate).toHaveBeenCalled();
    });
});
