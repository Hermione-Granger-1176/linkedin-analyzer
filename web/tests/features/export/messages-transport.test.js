import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LinkedInCleaner } from "../../../src/features/cleaning/cleaner.js";
import {
    loadMessagesState,
    terminateMessagesWorker,
} from "../../../src/features/export/messages-transport.js";
import { captureError } from "../../../src/platform/observability/sentry.js";
import { compactEvents } from "../../helpers/message-events.js";
import { createWorkerHarness } from "../../helpers/mock-worker.js";
import { expectFixedError, piiError } from "../../helpers/pii-sentinel.js";

vi.mock("../../../src/platform/observability/sentry.js", () => ({
    captureError: vi.fn(),
}));

const ADA_URL = "https://linkedin.com/in/ada";
const SAM_URL = "https://linkedin.com/in/sam";

const MESSAGES_CSV = [
    "CONVERSATION ID,FROM,TO,DATE,CONTENT,FOLDER,SENDER PROFILE URL,RECIPIENT PROFILE URLS",
    `c1,Sam Self,Ada Lovelace,2025-01-01 10:00:00 UTC,"Hello Ada",INBOX,${SAM_URL},${ADA_URL}`,
    `c1,Ada Lovelace,Sam Self,2025-01-02 10:00:00 UTC,"Hello Sam",INBOX,${ADA_URL},${SAM_URL}`,
    `c2,Sam Self,Bob Bookkeeper,2025-01-03 10:00:00 UTC,"Hello Bob",INBOX,${SAM_URL},https://linkedin.com/in/bob`,
].join("\n");

const CONNECTIONS_CSV = [
    "Notes:",
    "Export metadata",
    "",
    "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
    `Ada,Lovelace,${ADA_URL},,Analytical Engines,Mathematician,01 Jan 2024`,
    "Grace,Hopper,https://linkedin.com/in/grace,,Navy,Rear Admiral,02 Feb 2024",
].join("\n");

// The shape the messages worker flattens its Maps and Sets into. Every field
// serializeMessageState writes is included, even the two the dashboard does not
// read, so the fixture matches the real worker output.
const WORKER_MESSAGE_STATE = Object.freeze({
    contacts: [
        {
            key: `url:${ADA_URL}`,
            name: "Ada Lovelace",
            url: ADA_URL,
            count: 2,
            lastTimestamp: 1735725600000,
        },
    ],
    events: compactEvents([{ contactKey: `url:${ADA_URL}`, timestamp: 1735725600000 }]),
    rowTimestamps: Float64Array.of(1735725600000),
    skippedRows: 1,
    talkedNameKeys: ["ada lovelace"],
    talkedUrlKeys: [ADA_URL],
    latestTimestamp: 1735725600000,
    outreach: {
        totalConversations: 2,
        selfInitiated: 1,
        othersInitiated: 1,
        selfInitiatedReplied: 1,
        replyRate: 1,
        unansweredContacts: 0,
        sent: 2,
        received: 1,
        sentReceivedRatio: 2,
    },
});

const WORKER_CONNECTION_STATE = Object.freeze({
    list: [
        {
            name: "Grace Hopper",
            nameKey: "grace hopper",
            url: "https://linkedin.com/in/grace",
            company: "Navy",
            position: "Rear Admiral",
            connectedOnTimestamp: 1706832000000,
        },
    ],
});

// What the worker sends for an export with no connections file.
// buildConnectionState always returns a state, so an empty list means absent,
// not null.
const EMPTY_WORKER_CONNECTION_STATE = Object.freeze({ list: [] });

const harness = createWorkerHarness();

/**
 * Answer the worker request.
 * @param {object} payload - Worker payload, success flag and all
 * @param {number} [idOffset] - Shift applied to the request id, for stale replies
 */
function replyToRequest(payload, idOffset = 0) {
    const [request] = harness.instance.postMessage.mock.calls[0];
    harness.instance.emit("message", {
        data: { type: "processed", requestId: request.requestId + idOffset, payload },
    });
}

describe("loadMessagesState", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
        harness.install();
    });

    afterEach(() => {
        terminateMessagesWorker();
        vi.restoreAllMocks();
        vi.useRealTimers();
        harness.uninstall();
    });

    it("returns nothing for blank input without starting a worker", async () => {
        expect(await loadMessagesState("")).toBeNull();
        expect(await loadMessagesState(null, CONNECTIONS_CSV)).toBeNull();
        expect(harness.instance).toBeNull();
    });

    it("starts no worker for a run that has already been cancelled", async () => {
        expect(await loadMessagesState(MESSAGES_CSV, "", { isCancelled: () => true })).toBeNull();
        expect(harness.instance).toBeNull();
    });

    it("hydrates the worker's payload and terminates the worker", async () => {
        const pending = loadMessagesState(MESSAGES_CSV, CONNECTIONS_CSV);
        const worker = harness.instance;
        const [request] = worker.postMessage.mock.calls[0];

        expect(request.type).toBe("process");
        expect(request.payload).toEqual({
            messagesCsv: MESSAGES_CSV,
            connectionsCsv: CONNECTIONS_CSV,
        });

        replyToRequest({
            success: true,
            messageState: WORKER_MESSAGE_STATE,
            connectionState: WORKER_CONNECTION_STATE,
        });

        const state = await pending;
        // The Maps and Sets the dashboard reads, rebuilt from the arrays the
        // worker had to flatten them into.
        expect(state.messageState.contacts).toBeInstanceOf(Map);
        expect(state.messageState.contacts.get(`url:${ADA_URL}`).name).toBe("Ada Lovelace");
        expect(state.messageState.talkedNameKeys).toBeInstanceOf(Set);
        expect(state.messageState.talkedUrlKeys.has(ADA_URL)).toBe(true);
        expect(state.messageState.skippedRows).toBe(1);
        expect(state.messageState.outreach.replyRate).toBe(1);
        expect(state.connectionState.byName.get("grace hopper").company).toBe("Navy");
        expect(state.connectionState.byUrl.size).toBe(1);
        expect(worker.terminate).toHaveBeenCalled();
    });

    it("carries an empty connection state when the worker parsed no connections", async () => {
        const pending = loadMessagesState(MESSAGES_CSV, "");
        replyToRequest({
            success: true,
            messageState: WORKER_MESSAGE_STATE,
            connectionState: EMPTY_WORKER_CONNECTION_STATE,
        });

        const state = await pending;
        expect(state.connectionState.list).toEqual([]);
        expect(state.connectionState.byUrl.size).toBe(0);
    });

    it("carries no connection state when a reply leaves it out entirely", async () => {
        // A reply without connectionState leaves it null. The contract does not
        // normalize payload fields, and the real worker always sends the field.
        const pending = loadMessagesState(MESSAGES_CSV, "");
        replyToRequest({ success: true, messageState: WORKER_MESSAGE_STATE });

        expect((await pending).connectionState).toBeNull();
    });

    it("treats a non-string connections file as no connections file", async () => {
        const pending = loadMessagesState(MESSAGES_CSV, undefined);
        const [request] = harness.instance.postMessage.mock.calls[0];

        expect(request.payload.connectionsCsv).toBe("");
        replyToRequest({
            success: true,
            messageState: WORKER_MESSAGE_STATE,
            connectionState: EMPTY_WORKER_CONNECTION_STATE,
        });
        await pending;
    });

    it("reads stored upload Blobs on the main thread", async () => {
        harness.uninstall();

        const state = await loadMessagesState(new Blob([MESSAGES_CSV]), new Blob([CONNECTIONS_CSV]));

        expect(state.messageState.rowTimestamps).toHaveLength(3);
        expect(state.connectionState.list).toHaveLength(2);
    });

    it("returns nothing on the main thread when a stored upload cannot be read", async () => {
        harness.uninstall();
        vi.spyOn(FileReader.prototype, "readAsArrayBuffer").mockImplementation(function fail() {
            this.onerror();
        });

        expect(await loadMessagesState(new Blob([MESSAGES_CSV]), "")).toBeNull();
    });

    it("keeps the messages on the main thread when only the connections file cannot be read", async () => {
        harness.uninstall();
        vi.spyOn(FileReader.prototype, "readAsArrayBuffer").mockImplementation(function fail() {
            this.onerror();
        });

        const state = await loadMessagesState(MESSAGES_CSV, new Blob([CONNECTIONS_CSV]));

        expect(state.messageState.rowTimestamps).toHaveLength(3);
        expect(state.connectionState).toBeNull();
    });

    it("builds the state on the main thread when the platform has no worker", async () => {
        // Builds the state on the main thread, from the same parse, when Workers
        // are missing.
        harness.uninstall();

        const state = await loadMessagesState(MESSAGES_CSV, CONNECTIONS_CSV);

        expect(state.messageState.contacts).toBeInstanceOf(Map);
        expect(state.messageState.contacts.size).toBeGreaterThan(0);
        expect(state.messageState.rowTimestamps).toHaveLength(3);
        expect(state.connectionState.list.map((connection) => connection.name)).toEqual([
            "Ada Lovelace",
            "Grace Hopper",
        ]);
    });

    it("keeps the dashboard when only the connections file will not parse", async () => {
        // An optional file costs the lists that need it, not the whole page.
        harness.uninstall();

        const state = await loadMessagesState(MESSAGES_CSV, "not,a,connections,export");

        expect(state.messageState.contacts.size).toBeGreaterThan(0);
        expect(state.connectionState).toBeNull();
    });

    it("returns nothing on the main thread when the messages file will not parse", async () => {
        harness.uninstall();

        expect(await loadMessagesState("not,a,messages,export", "")).toBeNull();
    });

    it("refuses the main-thread fallback for very large exports", async () => {
        // Exports above the size ceiling are not parsed on the UI thread. The
        // dashboard is dropped instead.
        harness.uninstall();
        const huge = `${MESSAGES_CSV}\n${"# padding\n".repeat(600000)}`;

        expect(huge.length).toBeGreaterThan(5 * 1024 * 1024);
        expect(await loadMessagesState(huge, "")).toBeNull();
    });

    it("counts the connections file against the fallback ceiling too", async () => {
        // The ceiling is the sum of both files, since the fallback parses both.
        // Neither file alone exceeds it, but together they do.
        harness.uninstall();
        const padding = "# padding\n".repeat(320000);
        const messages = `${MESSAGES_CSV}\n${padding}`;
        const contacts = `${CONNECTIONS_CSV}\n${padding}`;

        expect(messages.length).toBeLessThan(5 * 1024 * 1024);
        expect(contacts.length).toBeLessThan(5 * 1024 * 1024);
        expect(messages.length + contacts.length).toBeGreaterThan(5 * 1024 * 1024);
        expect(await loadMessagesState(messages, contacts)).toBeNull();
    });

    it("still builds on the main thread just under the fallback ceiling", async () => {
        // Positive control for the test above: same padded shape, under the
        // ceiling. Without it, a null could mean the padding broke the parser.
        harness.uninstall();
        const padded = `${MESSAGES_CSV}\n${"# padding\n".repeat(10)}`;

        expect(padded.length).toBeLessThan(5 * 1024 * 1024);
        expect((await loadMessagesState(padded, "")).messageState.contacts.size).toBeGreaterThan(0);
    });

    it("does not re-parse on the main thread when a run is cancelled across the worker", async () => {
        // The worker answered nothing usable, but by then the user had asked to
        // stop: falling back would redo the abandoned work on the UI thread.
        let cancelled = false;
        const pending = loadMessagesState(MESSAGES_CSV, "", {
            isCancelled: () => cancelled,
        });
        cancelled = true;
        harness.instance.emit("error", { type: "error" });

        expect(await pending).toBeNull();
    });

    it("does not re-parse on the main thread when the worker answers with no state", async () => {
        // A success with no state means the worker found no messages. Parsing
        // again on the main thread would repeat the same parse.
        const pending = loadMessagesState(MESSAGES_CSV, "");
        replyToRequest({ success: true, messageState: null });

        expect(await pending).toBeNull();
    });

    it("settles a reply whose payload the contract parser emptied", async () => {
        // The parser nulls a payload that is not a plain object, so the reply
        // carries nothing. Reading through it would throw inside a listener and
        // leave the request to time out. No timer is advanced, so a hang fails
        // the test.
        vi.useFakeTimers();
        const pending = loadMessagesState(MESSAGES_CSV, "");
        const [request] = harness.instance.postMessage.mock.calls[0];
        harness.instance.emit("message", {
            data: { type: "processed", requestId: request.requestId, payload: "not an object" },
        });
        vi.useRealTimers();

        // Null, not FAILED: a malformed envelope says nothing about whether the
        // file can be parsed, so the small export still falls back.
        expect((await pending).messageState.contacts.size).toBeGreaterThan(0);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "messages-message-parse",
            requestId: expect.any(Number),
        });
    });

    it("does not re-parse on the main thread when the worker reports failure", async () => {
        // The worker already parsed this CSV and reported failure. Parsing again
        // on the main thread would reach the same answer.
        const pending = loadMessagesState(MESSAGES_CSV, "");
        replyToRequest({ success: false, error: "bad csv" });

        expect(await pending).toBeNull();
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "messages-worker-failure",
            requestId: expect.any(Number),
        });
    });

    it("falls back when a failure envelope names no request it was given", async () => {
        // An unknown request id does not count as a parse failure for this file,
        // so the small-file fallback runs.
        vi.useFakeTimers();
        const pending = loadMessagesState(MESSAGES_CSV, "");
        replyToRequest({ success: false, error: "invalid request" }, 99);
        vi.useRealTimers();

        // Expects two contacts from the full main-thread parse. The worker
        // fixture carries only one.
        expect((await pending).messageState.contacts.size).toBe(2);
        expect(harness.instance.terminate).toHaveBeenCalled();
    });

    it("answers a crash the same way whichever of its two routes lands first", async () => {
        // A crash reaches the main thread as a failure envelope under id 0 and as
        // an error event on the Worker object. The two may arrive in either
        // order, and the outcome must not depend on which arrives first.
        const postCrashEnvelope = (worker) => {
            worker.emit("message", {
                data: {
                    type: "processed",
                    requestId: 0,
                    payload: { success: false, error: "runtime failure" },
                },
            });
        };
        const propagateErrorEvent = (worker) => {
            worker.emit("error", { type: "error", error: new Error("worker blew up") });
        };

        const outcomes = [];
        for (const routes of [
            [postCrashEnvelope, propagateErrorEvent],
            [propagateErrorEvent, postCrashEnvelope],
        ]) {
            const pending = loadMessagesState(MESSAGES_CSV, "");
            const worker = harness.instance;
            for (const route of routes) {
                route(worker);
            }
            outcomes.push(await pending);
        }

        // Both routes fall back to the main thread.
        expect(outcomes.map((state) => state.messageState.contacts.size)).toEqual([2, 2]);
    });

    it("ignores stale successes for other requests and invalid envelopes", async () => {
        const pending = loadMessagesState(MESSAGES_CSV, "");

        harness.instance.emit("message", { data: { type: "nope" } });
        replyToRequest(
            { success: true, messageState: { ...WORKER_MESSAGE_STATE, contacts: [] } },
            99,
        );
        replyToRequest({ success: true, messageState: WORKER_MESSAGE_STATE });

        expect((await pending).messageState.contacts.size).toBe(1);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "messages-message-parse",
            requestId: expect.any(Number),
        });
    });

    it("falls back to the main thread when the worker errors", async () => {
        const pending = loadMessagesState(MESSAGES_CSV, CONNECTIONS_CSV);
        harness.instance.emit("error", { type: "error", error: new Error("worker blew up") });

        expect((await pending).messageState.contacts.size).toBeGreaterThan(0);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "messages-worker-error-event",
            requestId: expect.any(Number),
        });
    });

    it("cancels a worker error event so the browser cannot report it", async () => {
        const preventDefault = vi.fn();
        const pending = loadMessagesState(MESSAGES_CSV, "");
        // An uncancelled error event is logged by the browser, with the worker's
        // message. Here that message could hold text from the messages CSV.
        harness.instance.emit("error", { type: "error", error: piiError("worker"), preventDefault });
        await pending;

        expect(preventDefault).toHaveBeenCalled();
    });

    it("falls back to the main thread when the watchdog fires", async () => {
        vi.useFakeTimers();
        const pending = loadMessagesState(MESSAGES_CSV, "");
        vi.advanceTimersByTime(30001);
        vi.useRealTimers();

        expect((await pending).messageState.contacts.size).toBeGreaterThan(0);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "messages-worker-timeout",
            requestId: expect.any(Number),
        });
    });

    it("scales the watchdog with the size of both files", async () => {
        // The budget is 30s base plus 5s per whole megabyte of both files. The
        // padding is on the connections side, so a budget scaled only to the
        // messages file would fail this test.
        vi.useFakeTimers();
        const threeMb = `${CONNECTIONS_CSV}\n${"# padding\n".repeat(320000)}`;
        expect(threeMb.length).toBeGreaterThan(3 * 1024 * 1024);
        expect(threeMb.length).toBeLessThan(4 * 1024 * 1024);

        const pending = loadMessagesState(MESSAGES_CSV, threeMb);

        vi.advanceTimersByTime(44999);
        expect(captureError).not.toHaveBeenCalled();

        vi.advanceTimersByTime(2);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "messages-worker-timeout",
            requestId: expect.any(Number),
        });

        vi.useRealTimers();
        await pending;
    });

    it("scales the watchdog with the messages file as well", async () => {
        // The other half of the test above. The padding is on the messages side,
        // so the budget must count that file too.
        vi.useFakeTimers();
        const threeMb = `${MESSAGES_CSV}\n${"# padding\n".repeat(320000)}`;
        expect(threeMb.length).toBeGreaterThan(3 * 1024 * 1024);
        expect(threeMb.length).toBeLessThan(4 * 1024 * 1024);

        const pending = loadMessagesState(threeMb, "");

        vi.advanceTimersByTime(44999);
        expect(captureError).not.toHaveBeenCalled();

        vi.advanceTimersByTime(2);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "messages-worker-timeout",
            requestId: expect.any(Number),
        });

        vi.useRealTimers();
        await pending;
    });

    it("falls back to the main thread when posting to the worker throws", async () => {
        harness.postMessageError = new Error("clone failed");

        const state = await loadMessagesState(MESSAGES_CSV, "");

        expect(state.messageState.contacts.size).toBeGreaterThan(0);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "messages-worker-post-message",
            requestId: expect.any(Number),
        });
    });

    it("falls back to the main thread when the worker cannot be constructed", async () => {
        harness.constructorError = new Error("no workers here");

        const state = await loadMessagesState(MESSAGES_CSV, "");

        expect(state.messageState.contacts.size).toBeGreaterThan(0);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "init-messages-worker",
        });
    });

    it("ends an earlier request rather than letting two share the worker", async () => {
        // A new request ends the earlier one, so the two never share the
        // module-level watchdog and settle hook.
        const first = loadMessagesState(MESSAGES_CSV, "");
        const worker = harness.instance;
        const second = loadMessagesState(MESSAGES_CSV, "");
        const [, secondRequest] = worker.postMessage.mock.calls;

        worker.emit("message", {
            data: {
                type: "processed",
                requestId: secondRequest[0].requestId,
                payload: { success: true, messageState: WORKER_MESSAGE_STATE },
            },
        });

        // The cancelled request resolves to null and does not run on the UI thread.
        expect(await first).toBeNull();
        expect((await second).messageState.contacts.size).toBe(1);
    });

    it("leaves the worker alone for a request that was cancelled, not answered", async () => {
        // Await the cancelled request before replying to the newer request.
        // The cancelled request must not terminate the worker the newer one uses.
        const cancelled = loadMessagesState(MESSAGES_CSV, "");
        const worker = harness.instance;
        const pending = loadMessagesState(MESSAGES_CSV, "");

        expect(await cancelled).toBeNull();
        expect(worker.terminate).not.toHaveBeenCalled();

        const [, second] = worker.postMessage.mock.calls;
        worker.emit("message", {
            data: {
                type: "processed",
                requestId: second[0].requestId,
                payload: { success: true, messageState: WORKER_MESSAGE_STATE },
            },
        });

        expect((await pending).messageState.contacts.size).toBe(1);
    });

    it("settles a terminated request instead of leaving it pending", async () => {
        vi.useFakeTimers();
        const pending = loadMessagesState(MESSAGES_CSV, "");
        const worker = harness.instance;
        expect(worker.postMessage).toHaveBeenCalled();

        terminateMessagesWorker();
        // No timer is advanced and no event is emitted. Termination removes every
        // listener, so cancelling alone settles the request.
        expect(await pending).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
        expect(captureError).not.toHaveBeenCalled();
        vi.useRealTimers();
    });

    it("detaches a cancelled request from the worker it was listening to", async () => {
        const pending = loadMessagesState(MESSAGES_CSV, "");
        const worker = harness.instance;

        terminateMessagesWorker();
        await pending;

        expect(worker.listeners.get("message")).toEqual([]);
        expect(worker.listeners.get("error")).toEqual([]);
        expect(worker.listeners.get("messageerror")).toEqual([]);

        // A late answer from a worker that was already killed changes nothing.
        replyToRequest({ success: true, messageState: WORKER_MESSAGE_STATE });
        expect(await pending).toBeNull();
    });

    it("tolerates a second termination with nothing in flight", async () => {
        const pending = loadMessagesState(MESSAGES_CSV, "");
        terminateMessagesWorker();
        await pending;

        expect(() => terminateMessagesWorker()).not.toThrow();
        expect(harness.instance.terminate).toHaveBeenCalledTimes(1);
    });

    it("runs a fresh request after a cancelled one", async () => {
        const cancelled = loadMessagesState(MESSAGES_CSV, "");
        terminateMessagesWorker();
        expect(await cancelled).toBeNull();

        const pending = loadMessagesState(MESSAGES_CSV, "");
        replyToRequest({ success: true, messageState: WORKER_MESSAGE_STATE });

        expect((await pending).messageState.contacts.size).toBe(1);
    });

    it("never reports the error a worker failure event carried", async () => {
        const thrown = piiError("worker");
        const pending = loadMessagesState(MESSAGES_CSV, "");
        harness.instance.emit("messageerror", { type: "messageerror", error: thrown });
        await pending;

        expectFixedError(captureError.mock.calls[0][0], thrown);
    });

    it("never reports the error a failed postMessage carried", async () => {
        harness.postMessageError = piiError("clone");

        await loadMessagesState(MESSAGES_CSV, "");

        expectFixedError(captureError.mock.calls[0][0], harness.postMessageError);
    });

    it("never reports what a failed main-thread parse carried", async () => {
        const thrown = piiError("main-thread");
        harness.uninstall();
        vi.spyOn(LinkedInCleaner, "process").mockImplementation(() => {
            throw thrown;
        });

        expect(await loadMessagesState(MESSAGES_CSV, CONNECTIONS_CSV)).toBeNull();

        const [reported, context] = captureError.mock.calls[0];
        expectFixedError(reported, thrown);
        expect(context).toEqual({
            module: "pdf-export",
            operation: "messages-main-thread-parse",
        });
    });
});
