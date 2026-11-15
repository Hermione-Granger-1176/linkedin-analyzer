import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LinkedInCleaner } from "../../../src/features/cleaning/cleaner.js";
import {
    loadRecentThreads,
    terminateThreadsWorker,
} from "../../../src/features/export/threads-transport.js";
import { captureError } from "../../../src/platform/observability/sentry.js";
import { createWorkerHarness } from "../../helpers/mock-worker.js";
import { expectFixedError, piiError } from "../../helpers/pii-sentinel.js";

vi.mock("../../../src/platform/observability/sentry.js", () => ({
    captureError: vi.fn(),
}));

const MESSAGES_CSV = [
    "CONVERSATION ID,FROM,TO,DATE,CONTENT,FOLDER,SENDER PROFILE URL,RECIPIENT PROFILE URLS",
    'c1,Sam Self,Ada,2025-01-01 10:00:00 UTC,"Hello Ada",INBOX,https://linkedin.com/in/sam,https://linkedin.com/in/ada',
    'c2,Sam Self,Bob,2025-01-03 10:00:00 UTC,"Hello Bob",INBOX,https://linkedin.com/in/sam,https://linkedin.com/in/bob',
].join("\n");

// One conversation in both directions. The messages file alone cannot identify
// the account owner, so the connections file decides it.
const TIED_CSV = [
    "CONVERSATION ID,FROM,TO,DATE,CONTENT,FOLDER,SENDER PROFILE URL,RECIPIENT PROFILE URLS",
    'c1,Sam Self,Ada,2025-01-01 10:00:00 UTC,"Hello Ada",INBOX,https://linkedin.com/in/sam,https://linkedin.com/in/ada',
    'c1,Ada,Sam Self,2025-01-02 10:00:00 UTC,"Hi Sam",INBOX,https://linkedin.com/in/ada,https://linkedin.com/in/sam',
].join("\n");

// Ada has no connection date, so the cleaner drops her row. The contact keys
// are built from the raw parsed rows, so she still matches.
const CONNECTIONS_CSV = [
    "Notes:",
    "Export metadata",
    "",
    "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
    "Ada,,https://linkedin.com/in/ada,,Analytical Engines,Mathematician,",
].join("\n");

const harness = createWorkerHarness();

describe("loadRecentThreads", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
        harness.install();
    });

    afterEach(() => {
        terminateThreadsWorker();
        vi.useRealTimers();
        vi.restoreAllMocks();
        harness.uninstall();
    });

    it("returns nothing for blank input without starting a worker", async () => {
        expect(await loadRecentThreads("", "")).toEqual([]);
        expect(await loadRecentThreads(null, "")).toEqual([]);
        expect(harness.instance).toBeNull();
    });

    it("resolves with the worker's threads and terminates it", async () => {
        const pending = loadRecentThreads(MESSAGES_CSV, "", { people: 3, messagesPerPerson: 2 });
        const worker = harness.instance;
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
        // The raw connections source goes to the worker for the account-owner tiebreak.
        // Spies on both parser entry points. The cleaner calls its local parseCSV
        // binding, not the exported method.
        const parseCSV = vi.spyOn(LinkedInCleaner, "parseCSV");
        const processFile = vi.spyOn(LinkedInCleaner, "process");
        const pending = loadRecentThreads(MESSAGES_CSV, CONNECTIONS_CSV);
        const worker = harness.instance;
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
        expect(processFile).not.toHaveBeenCalled();
    });

    it("scales the watchdog with the connections file as well", async () => {
        // The worker reads both files, so the timeout scales with the connections
        // file too. Scaling by the messages export alone would time out early on
        // a large connections export.
        vi.useFakeTimers();
        const threeMbConnections = `${CONNECTIONS_CSV}\n${"# padding\n".repeat(320000)}`;
        expect(threeMbConnections.length).toBeGreaterThan(3 * 1024 * 1024);
        expect(threeMbConnections.length).toBeLessThan(4 * 1024 * 1024);

        const pending = loadRecentThreads(MESSAGES_CSV, threeMbConnections);

        // 30s base plus 5s per whole megabyte: 45s here, against 30s for the
        // messages file alone.
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
        expect(harness.instance).toBeNull();
    });

    it("ends an earlier request rather than letting two share the worker", async () => {
        // A new request ends the earlier one, so the two never share the
        // module-level watchdog and settle hook.
        const first = loadRecentThreads(MESSAGES_CSV, "");
        const worker = harness.instance;
        const second = loadRecentThreads(MESSAGES_CSV, "");
        const [, secondRequest] = worker.postMessage.mock.calls;

        worker.emit("message", {
            data: {
                type: "threads",
                requestId: secondRequest[0].requestId,
                payload: { success: true, threads: [{ name: "Ada", messages: [] }] },
            },
        });

        // The cancelled request resolves to an empty result and does not run on the UI thread.
        expect(await first).toEqual([]);
        expect(await second).toEqual([{ name: "Ada", messages: [] }]);
    });

    it("ignores stale successes for other requests and invalid envelopes", async () => {
        const pending = loadRecentThreads(MESSAGES_CSV, "");
        const worker = harness.instance;
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
        // the page to reach the same answer, so the section is dropped.
        const pending = loadRecentThreads(MESSAGES_CSV, "");
        const worker = harness.instance;
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

    it("falls back when a failure envelope names no request it was given", async () => {
        // A failure for an unknown request does not count as this file failing,
        // so the small-file fallback runs.
        vi.useFakeTimers();
        const pending = loadRecentThreads(MESSAGES_CSV, "");
        const worker = harness.instance;
        const [request] = worker.postMessage.mock.calls[0];

        worker.emit("message", {
            data: {
                type: "threads",
                requestId: request.requestId + 99,
                payload: { success: false, error: "invalid request" },
            },
        });
        vi.useRealTimers();

        expect((await pending).map((thread) => thread.name)).toEqual(["Bob", "Ada"]);
        expect(worker.terminate).toHaveBeenCalled();
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "threads-worker-failure",
            requestId: request.requestId,
        });
    });

    it("falls back to the main thread when the worker errors", async () => {
        const pending = loadRecentThreads(MESSAGES_CSV, "");
        harness.instance.emit("error", { type: "error", error: new Error("worker blew up") });

        expect((await pending).map((thread) => thread.name)).toEqual(["Bob", "Ada"]);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "threads-worker-error-event",
            requestId: expect.any(Number),
        });
    });

    it("reports a fixed error when the event carries none", async () => {
        const pending = loadRecentThreads(MESSAGES_CSV, "");
        harness.instance.emit("messageerror", { type: "messageerror" });
        await pending;

        expect(captureError.mock.calls[0][0].message).toBe("Threads worker failed during export.");
    });

    it("never reports the error a worker failure event carried", async () => {
        const thrown = piiError("worker");
        const pending = loadRecentThreads(MESSAGES_CSV, "");
        harness.instance.emit("error", { type: "error", error: thrown });
        await pending;

        expectFixedError(captureError.mock.calls[0][0], thrown);
    });

    it("cancels a worker error event so the browser cannot report it", async () => {
        const preventDefault = vi.fn();
        const pending = loadRecentThreads(MESSAGES_CSV, "");
        // An uncancelled error event is logged by the browser, with the worker's
        // message. Here that message could hold text from the messages CSV.
        harness.instance.emit("error", { type: "error", error: piiError("worker"), preventDefault });
        await pending;

        expect(preventDefault).toHaveBeenCalled();
    });

    it("never reports the error a failed postMessage carried", async () => {
        harness.postMessageError = piiError("clone");

        await loadRecentThreads(MESSAGES_CSV, "");

        expectFixedError(captureError.mock.calls[0][0], harness.postMessageError);
    });

    it("settles a terminated request instead of leaving it pending", async () => {
        vi.useFakeTimers();
        const pending = loadRecentThreads(MESSAGES_CSV, "");
        const worker = harness.instance;
        expect(worker.postMessage).toHaveBeenCalled();

        terminateThreadsWorker();
        // No timer is advanced and no event is emitted. Termination removes every
        // listener, so cancelling alone settles the request.
        const threads = await pending;

        expect(threads).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
    });

    it("does not re-parse on the main thread after a cancellation", async () => {
        const pending = loadRecentThreads(MESSAGES_CSV, "");
        terminateThreadsWorker();

        // A cancelled request does not fall back to the main thread, which would
        // redo the parse the user cancelled.
        expect(await pending).toEqual([]);
        expect(captureError).not.toHaveBeenCalled();
    });

    it("detaches a cancelled request from the worker it was listening to", async () => {
        const pending = loadRecentThreads(MESSAGES_CSV, "");
        const worker = harness.instance;
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
        expect(harness.instance.terminate).toHaveBeenCalledTimes(1);
    });

    it("runs a fresh request after a cancelled one", async () => {
        const cancelled = loadRecentThreads(MESSAGES_CSV, "");
        terminateThreadsWorker();
        expect(await cancelled).toEqual([]);

        const pending = loadRecentThreads(MESSAGES_CSV, "");
        const worker = harness.instance;
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
        harness.postMessageError = new Error("clone failed");

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
        harness.constructorError = new Error("no workers here");

        expect((await loadRecentThreads(MESSAGES_CSV, "")).map((thread) => thread.name)).toEqual([
            "Bob",
            "Ada",
        ]);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "init-threads-worker",
        });
    });

    it("reads stored upload Blobs on the main thread", async () => {
        harness.uninstall();

        const threads = await loadRecentThreads(new Blob([MESSAGES_CSV]), new Blob([CONNECTIONS_CSV]));

        expect(threads.map((thread) => thread.name)).toEqual(["Bob", "Ada"]);
    });

    it("returns no threads on the main thread when a stored upload cannot be read", async () => {
        harness.uninstall();
        vi.spyOn(FileReader.prototype, "readAsArrayBuffer").mockImplementation(function fail() {
            this.onerror();
        });

        expect(await loadRecentThreads(new Blob([MESSAGES_CSV]), "")).toEqual([]);
    });

    it("keeps the threads on the main thread when only the connections file cannot be read", async () => {
        harness.uninstall();
        vi.spyOn(FileReader.prototype, "readAsArrayBuffer").mockImplementation(function fail() {
            this.onerror();
        });

        const threads = await loadRecentThreads(MESSAGES_CSV, new Blob([CONNECTIONS_CSV]));

        expect(threads.map((thread) => thread.name)).toEqual(["Bob", "Ada"]);
    });

    it("selects on the main thread when workers are unavailable", async () => {
        harness.uninstall();

        expect((await loadRecentThreads(MESSAGES_CSV, "")).map((thread) => thread.name)).toEqual([
            "Bob",
            "Ada",
        ]);
    });

    it("breaks the tie on the main thread with the same keys the worker derives", async () => {
        // The fallback derives the same tiebreak keys as the worker, and keeps
        // rows without a connection date.
        harness.uninstall();

        const unaided = await loadRecentThreads(TIED_CSV, "");
        expect(unaided[0].messages.map((entry) => entry.direction)).toEqual([
            "unknown",
            "unknown",
        ]);

        const aided = await loadRecentThreads(TIED_CSV, CONNECTIONS_CSV);
        expect(aided[0].messages.map((entry) => entry.direction)).toEqual(["sent", "received"]);
    });

    it("never reports what an unparseable connections file carried on the main thread", async () => {
        harness.uninstall();
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
        harness.uninstall();

        expect(await loadRecentThreads("not,a,valid,csv", "")).toEqual([]);
    });

    it("skips the main-thread fallback for very large exports", async () => {
        harness.uninstall();
        const huge = `${MESSAGES_CSV}\n${"# padding\n".repeat(600000)}`;

        expect(huge.length).toBeGreaterThan(5 * 1024 * 1024);
        expect(await loadRecentThreads(huge, "")).toEqual([]);
    });

    it("counts the connections file against the fallback ceiling too", async () => {
        // The fallback parses both files, so the ceiling counts the connections
        // file too.
        harness.uninstall();
        const hugeContacts = `${CONNECTIONS_CSV}\n${"# padding\n".repeat(600000)}`;

        expect(MESSAGES_CSV.length).toBeLessThan(5 * 1024 * 1024);
        expect(hugeContacts.length).toBeGreaterThan(5 * 1024 * 1024);
        expect(await loadRecentThreads(MESSAGES_CSV, hugeContacts)).toEqual([]);
    });

    it("still selects on the main thread just under the fallback ceiling", async () => {
        // Positive control for the test above: same padded shape, under the
        // ceiling. Without it, an empty result could mean the padding broke the parser.
        harness.uninstall();
        const padded = `${MESSAGES_CSV}\n${"# padding\n".repeat(10)}`;

        expect(padded.length).toBeLessThan(5 * 1024 * 1024);
        expect((await loadRecentThreads(padded, "")).map((thread) => thread.name)).toEqual([
            "Bob",
            "Ada",
        ]);
    });

    it("scales the watchdog with the size of the export", async () => {
        // The shared budget from messages/format.js: a 30s base plus 5s per
        // whole megabyte, which is 45s here. A timeout on a small CSV cannot tell
        // a constant from a scaled budget, so this test uses a size that crosses
        // the 30s base.
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
