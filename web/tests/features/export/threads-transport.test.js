import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LinkedInCleaner } from "../../../src/features/cleaning/cleaner.js";
import {
    loadRecentThreads,
    terminateThreadsWorker,
} from "../../../src/features/export/threads-transport.js";
import { captureError } from "../../../src/platform/observability/sentry.js";
import { expectFixedError, piiError } from "../../helpers/pii-sentinel.js";

vi.mock("../../../src/platform/observability/sentry.js", () => ({
    captureError: vi.fn(),
}));

const MESSAGES_CSV = [
    "CONVERSATION ID,FROM,TO,DATE,CONTENT,FOLDER,SENDER PROFILE URL,RECIPIENT PROFILE URLS",
    'c1,Sam Self,Ada,2025-01-01 10:00:00 UTC,"Hello Ada",INBOX,https://linkedin.com/in/sam,https://linkedin.com/in/ada',
    'c2,Sam Self,Bob,2025-01-03 10:00:00 UTC,"Hello Bob",INBOX,https://linkedin.com/in/sam,https://linkedin.com/in/bob',
].join("\n");

// One conversation, both directions, so the messages file alone cannot say who
// the account owner is: the case the connections file exists to settle.
const TIED_CSV = [
    "CONVERSATION ID,FROM,TO,DATE,CONTENT,FOLDER,SENDER PROFILE URL,RECIPIENT PROFILE URLS",
    'c1,Sam Self,Ada,2025-01-01 10:00:00 UTC,"Hello Ada",INBOX,https://linkedin.com/in/sam,https://linkedin.com/in/ada',
    'c1,Ada,Sam Self,2025-01-02 10:00:00 UTC,"Hi Sam",INBOX,https://linkedin.com/in/ada,https://linkedin.com/in/sam',
].join("\n");

// Ada carries no connection date, which the cleaner drops the whole row for.
// Both paths derive their keys from the parsed rows, so both still find her.
const CONNECTIONS_CSV = [
    "Notes:",
    "Export metadata",
    "",
    "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
    "Ada,,https://linkedin.com/in/ada,,Analytical Engines,Mathematician,",
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
        vi.restoreAllMocks();
        delete globalThis.Worker;
    });

    it("returns nothing for blank input without starting a worker", async () => {
        expect(await loadRecentThreads("", "")).toEqual([]);
        expect(await loadRecentThreads(null, "")).toEqual([]);
        expect(workerInstance).toBeNull();
    });

    it("resolves with the worker's threads and terminates it", async () => {
        const pending = loadRecentThreads(MESSAGES_CSV, "", { people: 3, messagesPerPerson: 2 });
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

    it("sends the raw connections file to the worker and parses nothing here", async () => {
        // Without it the worker cannot tell which side of a single conversation
        // is the account owner, and every direction chip in the exported
        // document reads "unknown". Deriving the keys on this side instead is
        // the whole-file parse that kept the Escape key from reaching its own
        // handler, so the file travels raw and the worker does the reading.
        const parseCSV = vi.spyOn(LinkedInCleaner, "parseCSV");
        const pending = loadRecentThreads(MESSAGES_CSV, CONNECTIONS_CSV);
        const worker = workerInstance;
        const [request] = worker.postMessage.mock.calls[0];

        expect(request.payload.connectionsCsv).toBe(CONNECTIONS_CSV);
        expect(request.payload.contactKeys).toBeUndefined();

        worker.emit("message", {
            data: {
                type: "threads",
                requestId: request.requestId,
                payload: { success: true, threads: [] },
            },
        });
        await pending;

        expect(parseCSV).not.toHaveBeenCalled();
    });

    it("scales the watchdog with the connections file as well", async () => {
        // The worker reads both files now, so a budget scaled to the messages
        // export alone would fire early on a large connections export and send
        // a parse the worker was still doing to the UI thread instead.
        vi.useFakeTimers();
        const threeMbConnections = `${CONNECTIONS_CSV}\n${"# padding\n".repeat(320000)}`;
        expect(threeMbConnections.length).toBeGreaterThan(3 * 1024 * 1024);
        expect(threeMbConnections.length).toBeLessThan(4 * 1024 * 1024);

        const pending = loadRecentThreads(MESSAGES_CSV, threeMbConnections);

        // 30s base plus 5s per whole megabyte: 45s, where the messages file
        // alone would have bought 30s.
        vi.advanceTimersByTime(30001);
        expect(captureError).not.toHaveBeenCalled();

        vi.advanceTimersByTime(15000);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "threads-worker-timeout",
            requestId: expect.any(Number),
        });

        vi.useRealTimers();
        await pending;
    });

    it("starts no worker for a run that has already been cancelled", async () => {
        expect(await loadRecentThreads(MESSAGES_CSV, "", { isCancelled: () => true })).toEqual([]);
        expect(workerInstance).toBeNull();
    });

    it("ends an earlier request rather than letting two share the worker", async () => {
        // Both requests would otherwise own the same module-level watchdog and
        // settle hook, and whichever the worker answered first would clear the
        // other's - leaving that promise pending for the life of the page.
        const first = loadRecentThreads(MESSAGES_CSV, "");
        const worker = workerInstance;
        const second = loadRecentThreads(MESSAGES_CSV, "");
        const [, secondRequest] = worker.postMessage.mock.calls;

        worker.emit("message", {
            data: {
                type: "threads",
                requestId: secondRequest[0].requestId,
                payload: { success: true, threads: [{ name: "Ada", messages: [] }] },
            },
        });

        // The cancelled one resolves rather than hanging, and does not re-run
        // the abandoned work on the UI thread.
        expect(await first).toEqual([]);
        expect(await second).toEqual([{ name: "Ada", messages: [] }]);
    });

    it("ignores stale successes for other requests and invalid envelopes", async () => {
        const pending = loadRecentThreads(MESSAGES_CSV, "");
        const worker = workerInstance;
        const [request] = worker.postMessage.mock.calls[0];

        worker.emit("message", { data: { type: "nope" } });
        worker.emit("message", {
            data: {
                type: "threads",
                requestId: request.requestId + 99,
                payload: { success: true, threads: [{ name: "Stale" }] },
            },
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

    it("does not re-parse on the main thread when the worker reports failure", async () => {
        // The worker has already run this exact code over this exact CSV and
        // said it cannot yield threads. Re-running it on the UI thread freezes
        // the page to reach the same answer, so the section is simply dropped.
        const pending = loadRecentThreads(MESSAGES_CSV, "");
        const worker = workerInstance;
        const [request] = worker.postMessage.mock.calls[0];

        worker.emit("message", {
            data: {
                type: "threads",
                requestId: request.requestId,
                payload: { success: false, error: "bad csv" },
            },
        });

        expect(await pending).toEqual([]);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "threads-worker-failure",
            requestId: request.requestId,
        });
    });

    it("treats a failure envelope as terminal even under another request id", async () => {
        vi.useFakeTimers();
        const pending = loadRecentThreads(MESSAGES_CSV, "");
        const worker = workerInstance;
        const [request] = worker.postMessage.mock.calls[0];

        // A worker that could not read the request cannot echo its id in every
        // browser; the single in-flight request must still end here rather than
        // sitting out the watchdog.
        worker.emit("message", {
            data: {
                type: "threads",
                requestId: request.requestId + 99,
                payload: { success: false, error: "invalid request" },
            },
        });
        vi.useRealTimers();

        expect(await pending).toEqual([]);
        expect(worker.terminate).toHaveBeenCalled();
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "threads-worker-failure",
            requestId: request.requestId,
        });
    });

    it("falls back to the main thread when the worker errors", async () => {
        const pending = loadRecentThreads(MESSAGES_CSV, "");
        workerInstance.emit("error", { type: "error", error: new Error("worker blew up") });

        expect((await pending).map((thread) => thread.name)).toEqual(["Bob", "Ada"]);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "threads-worker-error-event",
            requestId: expect.any(Number),
        });
    });

    it("reports a fixed error when the event carries none", async () => {
        const pending = loadRecentThreads(MESSAGES_CSV, "");
        workerInstance.emit("messageerror", { type: "messageerror" });
        await pending;

        expect(captureError.mock.calls[0][0].message).toBe("Threads worker failed.");
    });

    it("never reports the error a worker failure event carried", async () => {
        const thrown = piiError("worker");
        const pending = loadRecentThreads(MESSAGES_CSV, "");
        workerInstance.emit("error", { type: "error", error: thrown });
        await pending;

        expectFixedError(captureError.mock.calls[0][0], thrown);
    });

    it("cancels a worker error event so the browser cannot report it", async () => {
        const preventDefault = vi.fn();
        const pending = loadRecentThreads(MESSAGES_CSV, "");
        // An uncancelled error event on a Worker is reported by the browser
        // itself, and that report reaches the console with the worker's own
        // message - here, text parsed straight out of the messages CSV.
        workerInstance.emit("error", { type: "error", error: piiError("worker"), preventDefault });
        await pending;

        expect(preventDefault).toHaveBeenCalled();
    });

    it("never reports the error a failed postMessage carried", async () => {
        postMessageError = piiError("clone");

        await loadRecentThreads(MESSAGES_CSV, "");

        expectFixedError(captureError.mock.calls[0][0], postMessageError);
    });

    it("settles a terminated request instead of leaving it pending", async () => {
        vi.useFakeTimers();
        const pending = loadRecentThreads(MESSAGES_CSV, "");
        const worker = workerInstance;
        expect(worker.postMessage).toHaveBeenCalled();

        terminateThreadsWorker();
        // No timer is advanced and no event is emitted: terminating removed
        // every one of them, so cancellation alone has to end the request.
        // Left pending, loadRecentThreads() never returns and its frame keeps
        // the whole raw messages CSV alive for the life of the page.
        const threads = await pending;

        expect(threads).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
    });

    it("does not re-parse on the main thread after a cancellation", async () => {
        const pending = loadRecentThreads(MESSAGES_CSV, "");
        terminateThreadsWorker();

        // The main-thread fallback would answer with these threads; redoing the
        // parse is exactly the work the user cancelled.
        expect(await pending).toEqual([]);
        expect(captureError).not.toHaveBeenCalled();
    });

    it("detaches a cancelled request from the worker it was listening to", async () => {
        const pending = loadRecentThreads(MESSAGES_CSV, "");
        const worker = workerInstance;
        const [request] = worker.postMessage.mock.calls[0];

        terminateThreadsWorker();
        await pending;

        expect(worker.listeners.get("message")).toEqual([]);
        expect(worker.listeners.get("error")).toEqual([]);
        expect(worker.listeners.get("messageerror")).toEqual([]);

        // A late answer from a worker that was already killed changes nothing.
        worker.emit("message", {
            data: {
                type: "threads",
                requestId: request.requestId,
                payload: { success: true, threads: [{ name: "Late" }] },
            },
        });
        expect(await pending).toEqual([]);
    });

    it("tolerates a second termination with nothing in flight", async () => {
        const pending = loadRecentThreads(MESSAGES_CSV, "");
        terminateThreadsWorker();
        await pending;

        expect(() => terminateThreadsWorker()).not.toThrow();
        expect(workerInstance.terminate).toHaveBeenCalledTimes(1);
    });

    it("runs a fresh request after a cancelled one", async () => {
        const cancelled = loadRecentThreads(MESSAGES_CSV, "");
        terminateThreadsWorker();
        expect(await cancelled).toEqual([]);

        const pending = loadRecentThreads(MESSAGES_CSV, "");
        const worker = workerInstance;
        const [request] = worker.postMessage.mock.calls[0];
        worker.emit("message", {
            data: {
                type: "threads",
                requestId: request.requestId,
                payload: { success: true, threads: [{ name: "Ada" }] },
            },
        });

        expect(await pending).toEqual([{ name: "Ada" }]);
    });

    it("falls back to the main thread when the worker times out", async () => {
        vi.useFakeTimers();
        const pending = loadRecentThreads(MESSAGES_CSV, "");
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

        expect((await loadRecentThreads(MESSAGES_CSV, "")).map((thread) => thread.name)).toEqual([
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

        expect((await loadRecentThreads(MESSAGES_CSV, "")).map((thread) => thread.name)).toEqual([
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

        expect((await loadRecentThreads(MESSAGES_CSV, "")).map((thread) => thread.name)).toEqual([
            "Bob",
            "Ada",
        ]);
    });

    it("breaks the tie on the main thread with the same keys the worker derives", async () => {
        // The fallback has to answer with the document the worker would have
        // produced, tiebreak included: a browser with no worker is not a browser
        // that deserves every direction chip reading "unknown". Ada's row
        // carries no connection date, so a fallback that cleaned rather than
        // parsed would drop her and lose the tie.
        delete globalThis.Worker;

        const unaided = await loadRecentThreads(TIED_CSV, "");
        expect(unaided[0].messages.map((entry) => entry.direction)).toEqual([
            "unknown",
            "unknown",
        ]);

        const aided = await loadRecentThreads(TIED_CSV, CONNECTIONS_CSV);
        expect(aided[0].messages.map((entry) => entry.direction)).toEqual(["sent", "received"]);
    });

    it("never reports what an unparseable connections file carried on the main thread", async () => {
        delete globalThis.Worker;
        const thrown = piiError("connections");
        const parseCSV = LinkedInCleaner.parseCSV;
        vi.spyOn(LinkedInCleaner, "parseCSV").mockImplementation((text, fileType) => {
            if (fileType === "connections") {
                throw thrown;
            }
            return parseCSV.call(LinkedInCleaner, text, fileType);
        });

        // The tiebreak goes; the section it would have labelled stays.
        const threads = await loadRecentThreads(TIED_CSV, CONNECTIONS_CSV);
        expect(threads[0].messages.map((entry) => entry.direction)).toEqual([
            "unknown",
            "unknown",
        ]);

        const [reported, context] = captureError.mock.calls[0];
        expectFixedError(reported, thrown);
        expect(context).toEqual({
            module: "pdf-export",
            operation: "contact-keys-main-thread-parse",
        });
    });

    it("returns nothing on the main thread when the CSV cannot be parsed", async () => {
        delete globalThis.Worker;

        expect(await loadRecentThreads("not,a,valid,csv", "")).toEqual([]);
    });

    it("skips the main-thread fallback for very large exports", async () => {
        delete globalThis.Worker;
        const huge = `${MESSAGES_CSV}\n${"# padding\n".repeat(600000)}`;

        expect(huge.length).toBeGreaterThan(5 * 1024 * 1024);
        expect(await loadRecentThreads(huge, "")).toEqual([]);
    });

    it("still selects on the main thread just under the fallback ceiling", async () => {
        // The positive control for the test above: same padded shape, only
        // shorter. Without this, an empty result there could equally mean the
        // padding broke the parser, and deleting the size guard would not fail.
        delete globalThis.Worker;
        const padded = `${MESSAGES_CSV}\n${"# padding\n".repeat(10)}`;

        expect(padded.length).toBeLessThan(5 * 1024 * 1024);
        expect((await loadRecentThreads(padded, "")).map((thread) => thread.name)).toEqual([
            "Bob",
            "Ada",
        ]);
    });

    it("scales the watchdog with the size of the export", async () => {
        // The shared budget from messages/format.js: a 30s base plus 5s per
        // whole megabyte, which is 45s here. The only other timeout test
        // advances 60s against a three-line CSV, so it would pass for a
        // constant, and the base is asserted through a size that crosses it.
        vi.useFakeTimers();
        const threeMb = `${MESSAGES_CSV}\n${"# padding\n".repeat(320000)}`;
        expect(threeMb.length).toBeGreaterThan(3 * 1024 * 1024);
        expect(threeMb.length).toBeLessThan(4 * 1024 * 1024);

        const pending = loadRecentThreads(threeMb, "");

        vi.advanceTimersByTime(44999);
        expect(captureError).not.toHaveBeenCalled();

        vi.advanceTimersByTime(2);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "threads-worker-timeout",
            requestId: expect.any(Number),
        });

        vi.useRealTimers();
        await pending;
    });
});
