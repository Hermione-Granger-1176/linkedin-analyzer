import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LinkedInCleaner } from "../../../src/features/cleaning/cleaner.js";
import {
    loadMessagesState,
    terminateMessagesWorker,
} from "../../../src/features/export/messages-transport.js";
import { MessagesAnalytics } from "../../../src/features/messages/analytics.js";
import { captureError } from "../../../src/platform/observability/sentry.js";
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

// The shape the messages worker flattens its Maps and Sets into for transport.
// Every field serializeMessageState writes is here, including the two the
// dashboard never reads: a fixture that described a smaller worker than the real
// one would keep passing after the transport stopped carrying them across.
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
    events: [{ contactKey: `url:${ADA_URL}`, timestamp: 1735725600000 }],
    rowTimestamps: [1735725600000],
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

// What the worker sends for an export with no connections file: it calls
// buildConnectionState whether or not one was uploaded, and that always answers
// with a state, so an empty list is the absent case rather than a null.
const EMPTY_WORKER_CONNECTION_STATE = Object.freeze({ list: [] });

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

/**
 * Answer the request the worker was just given.
 * @param {object} payload - Worker payload, success flag and all
 * @param {number} [idOffset] - Shift applied to the request id, for stale replies
 */
function replyToRequest(payload, idOffset = 0) {
    const [request] = workerInstance.postMessage.mock.calls[0];
    workerInstance.emit("message", {
        data: { type: "processed", requestId: request.requestId + idOffset, payload },
    });
}

describe("loadMessagesState", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
        workerInstance = null;
        constructorError = null;
        postMessageError = null;
        globalThis.Worker = MockWorker;
    });

    afterEach(() => {
        terminateMessagesWorker();
        vi.restoreAllMocks();
        vi.useRealTimers();
        delete globalThis.Worker;
    });

    it("returns nothing for blank input without starting a worker", async () => {
        expect(await loadMessagesState("")).toBeNull();
        expect(await loadMessagesState(null, CONNECTIONS_CSV)).toBeNull();
        expect(workerInstance).toBeNull();
    });

    it("starts no worker for a run that has already been cancelled", async () => {
        expect(await loadMessagesState(MESSAGES_CSV, "", { isCancelled: () => true })).toBeNull();
        expect(workerInstance).toBeNull();
    });

    it("hydrates the worker's payload and terminates the worker", async () => {
        const pending = loadMessagesState(MESSAGES_CSV, CONNECTIONS_CSV);
        const worker = workerInstance;
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
        // The messages contract passes its payload through without normalizing
        // the fields on it, so this arm answers for a reply the real worker does
        // not send: the dashboard still gets a state it can read.
        const pending = loadMessagesState(MESSAGES_CSV, "");
        replyToRequest({ success: true, messageState: WORKER_MESSAGE_STATE });

        expect((await pending).connectionState).toBeNull();
    });

    it("treats a non-string connections file as no connections file", async () => {
        const pending = loadMessagesState(MESSAGES_CSV, undefined);
        const [request] = workerInstance.postMessage.mock.calls[0];

        expect(request.payload.connectionsCsv).toBe("");
        replyToRequest({
            success: true,
            messageState: WORKER_MESSAGE_STATE,
            connectionState: EMPTY_WORKER_CONNECTION_STATE,
        });
        await pending;
    });

    it("builds the state on the main thread when the platform has no worker", async () => {
        // The bug this module exists to fix: borrowing the Messages screen's
        // fallback answered with cleaned rows and left the state to its caller,
        // so the dashboard quietly disappeared on any browser without workers.
        delete globalThis.Worker;

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
        delete globalThis.Worker;

        const state = await loadMessagesState(MESSAGES_CSV, "not,a,connections,export");

        expect(state.messageState.contacts.size).toBeGreaterThan(0);
        expect(state.connectionState).toBeNull();
    });

    it("returns nothing on the main thread when the messages file will not parse", async () => {
        delete globalThis.Worker;

        expect(await loadMessagesState("not,a,messages,export", "")).toBeNull();
    });

    it("returns nothing on the main thread when the file yields no state", async () => {
        delete globalThis.Worker;
        vi.spyOn(MessagesAnalytics, "buildMessageState").mockReturnValue(null);

        expect(await loadMessagesState(MESSAGES_CSV, CONNECTIONS_CSV)).toBeNull();
    });

    it("refuses the main-thread fallback for very large exports", async () => {
        // Re-parsing this on the UI thread would freeze the page, so the export
        // drops the dashboard rather than blocking on it.
        delete globalThis.Worker;
        const huge = `${MESSAGES_CSV}\n${"# padding\n".repeat(600000)}`;

        expect(huge.length).toBeGreaterThan(5 * 1024 * 1024);
        expect(await loadMessagesState(huge, "")).toBeNull();
    });

    it("still builds on the main thread just under the fallback ceiling", async () => {
        // The positive control for the test above: same padded shape, only
        // shorter. Without this, a null there could equally mean the padding
        // broke the parser, and deleting the size guard would not fail.
        delete globalThis.Worker;
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
        workerInstance.emit("error", { type: "error" });

        expect(await pending).toBeNull();
    });

    it("does not re-parse on the main thread when the worker answers with no state", async () => {
        // A success carrying no state is the worker saying this file holds no
        // messages, and it said so from the same parse of the same bytes the
        // main thread would have to redo.
        const pending = loadMessagesState(MESSAGES_CSV, "");
        replyToRequest({ success: true, messageState: null });

        expect(await pending).toBeNull();
    });

    it("settles a reply whose payload the contract parser emptied", async () => {
        // The parser accepts the envelope and nulls a payload that is not a
        // plain object, so an otherwise well-formed reply can arrive with
        // nothing on it. Reading through that would throw inside a listener,
        // where nothing is waiting to catch it, and leave the request to time
        // out; no timer is advanced here, so a hang fails the test.
        vi.useFakeTimers();
        const pending = loadMessagesState(MESSAGES_CSV, "");
        const [request] = workerInstance.postMessage.mock.calls[0];
        workerInstance.emit("message", {
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
        // The worker has already run this exact CSV through this exact code and
        // reported that it cannot parse it; the main thread would only freeze
        // the page to reach the same answer.
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
        // The worker answers under the request's own id when it read the request
        // and the parse is what failed, and under id zero when it fell over
        // before or outside of that. Only the first is evidence about the file.
        // This one never touched the CSV, so the small export is still parsed
        // here rather than dropped, which is what the test above pins for a
        // failure the worker did attribute to its request.
        //
        // It settles at once either way: no timer is advanced, so a request left
        // to sit out its watchdog fails this test.
        vi.useFakeTimers();
        const pending = loadMessagesState(MESSAGES_CSV, "");
        replyToRequest({ success: false, error: "invalid request" }, 99);
        vi.useRealTimers();

        // Two contacts, because the main thread parsed the whole file: the
        // worker fixture elsewhere in this suite carries only the first.
        expect((await pending).messageState.contacts.size).toBe(2);
        expect(workerInstance.terminate).toHaveBeenCalled();
    });

    it("answers a crash the same way whichever of its two routes lands first", async () => {
        // A crash inside this worker reaches the main thread twice over: as the
        // posted failure envelope under id zero, and as a propagated error event
        // on the Worker object, which this worker does not cancel. Nothing in
        // the spec orders the two, so what the export does must not depend on
        // which one wins.
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
            const worker = workerInstance;
            for (const route of routes) {
                route(worker);
            }
            outcomes.push(await pending);
        }

        // Both fall back, because neither route said anything about the file.
        expect(outcomes.map((state) => state.messageState.contacts.size)).toEqual([2, 2]);
    });

    it("ignores stale successes for other requests and invalid envelopes", async () => {
        const pending = loadMessagesState(MESSAGES_CSV, "");

        workerInstance.emit("message", { data: { type: "nope" } });
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
        workerInstance.emit("error", { type: "error", error: new Error("worker blew up") });

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
        // An uncancelled error event on a Worker is reported by the browser
        // itself, and that report reaches the console with the worker's own
        // message - here, text parsed straight out of the messages CSV.
        workerInstance.emit("error", { type: "error", error: piiError("worker"), preventDefault });
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
        // The Messages screen's own budget for this same worker: 30s base plus
        // 5s per whole megabyte of the two files it parses. Scaled to the
        // messages export alone, the watchdog fired early on a large
        // connections file and sent a parse the worker was still doing to the
        // UI thread, so the padding here is on the connections side.
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

    it("falls back to the main thread when posting to the worker throws", async () => {
        postMessageError = new Error("clone failed");

        const state = await loadMessagesState(MESSAGES_CSV, "");

        expect(state.messageState.contacts.size).toBeGreaterThan(0);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "messages-worker-post-message",
            requestId: expect.any(Number),
        });
    });

    it("falls back to the main thread when the worker cannot be constructed", async () => {
        constructorError = new Error("no workers here");

        const state = await loadMessagesState(MESSAGES_CSV, "");

        expect(state.messageState.contacts.size).toBeGreaterThan(0);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "init-messages-worker",
        });
    });

    it("ends an earlier request rather than letting two share the worker", async () => {
        // Both requests would otherwise own the same module-level watchdog and
        // settle hook, and whichever the worker answered first would clear the
        // other's, leaving that promise pending for the life of the page.
        const first = loadMessagesState(MESSAGES_CSV, "");
        const worker = workerInstance;
        const second = loadMessagesState(MESSAGES_CSV, "");
        const [, secondRequest] = worker.postMessage.mock.calls;

        worker.emit("message", {
            data: {
                type: "processed",
                requestId: secondRequest[0].requestId,
                payload: { success: true, messageState: WORKER_MESSAGE_STATE },
            },
        });

        // The cancelled one resolves rather than hanging, and does not re-run
        // the abandoned work on the UI thread.
        expect(await first).toBeNull();
        expect((await second).messageState.contacts.size).toBe(1);
    });

    it("settles a terminated request instead of leaving it pending", async () => {
        vi.useFakeTimers();
        const pending = loadMessagesState(MESSAGES_CSV, "");
        const worker = workerInstance;
        expect(worker.postMessage).toHaveBeenCalled();

        terminateMessagesWorker();
        // No timer is advanced and no event is emitted: terminating removed
        // every one of them, so cancellation alone has to end the request. Left
        // pending, its frame keeps the raw messages CSV alive for the life of
        // the page.
        expect(await pending).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
        expect(captureError).not.toHaveBeenCalled();
        vi.useRealTimers();
    });

    it("detaches a cancelled request from the worker it was listening to", async () => {
        const pending = loadMessagesState(MESSAGES_CSV, "");
        const worker = workerInstance;

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
        expect(workerInstance.terminate).toHaveBeenCalledTimes(1);
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
        workerInstance.emit("messageerror", { type: "messageerror", error: thrown });
        await pending;

        expectFixedError(captureError.mock.calls[0][0], thrown);
    });

    it("never reports the error a failed postMessage carried", async () => {
        postMessageError = piiError("clone");

        await loadMessagesState(MESSAGES_CSV, "");

        expectFixedError(captureError.mock.calls[0][0], postMessageError);
    });

    it("never reports what a failed main-thread parse carried", async () => {
        const thrown = piiError("main-thread");
        delete globalThis.Worker;
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
