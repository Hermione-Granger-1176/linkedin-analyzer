import { afterEach, describe, expect, it, vi } from "vitest";

import { processPayload } from "../../../src/features/export/threads-worker.js";
import { PII_MARKER, piiError } from "../../helpers/pii-sentinel.js";

const MESSAGES_CSV = [
    "CONVERSATION ID,FROM,TO,DATE,CONTENT,FOLDER,SENDER PROFILE URL,RECIPIENT PROFILE URLS",
    'c1,Sam Self,Ada,2025-01-01 10:00:00 UTC,"Hello Ada",INBOX,https://linkedin.com/in/sam,https://linkedin.com/in/ada',
    'c1,Ada,Sam Self,2025-01-02 10:00:00 UTC,"Hi Sam",INBOX,https://linkedin.com/in/ada,https://linkedin.com/in/sam',
    'c2,Sam Self,Bob,2025-01-03 10:00:00 UTC,"Hello Bob",INBOX,https://linkedin.com/in/sam,https://linkedin.com/in/bob',
].join("\n");

describe("threads worker", () => {
    it("cleans the CSV and selects threads", () => {
        const result = processPayload({ messagesCsv: MESSAGES_CSV });

        expect(result.success).toBe(true);
        expect(result.error).toBeNull();
        expect(result.threads.map((thread) => thread.name)).toEqual(["Bob", "Ada"]);
        expect(result.threads[1].messages.map((entry) => entry.body)).toEqual([
            "Hello Ada",
            "Hi Sam",
        ]);
        expect(result.threads[1].messages.map((entry) => entry.direction)).toEqual([
            "sent",
            "received",
        ]);
    });

    it("honours the selection limits from the request", () => {
        const result = processPayload({
            messagesCsv: MESSAGES_CSV,
            people: 1,
            messagesPerPerson: 1,
        });

        expect(result.threads).toHaveLength(1);
        expect(result.threads[0].messages).toHaveLength(1);
    });

    it("breaks a self-detection tie with the contact keys from the request", () => {
        // One conversation, both directions: the messages file alone cannot say
        // which of the two is the account owner, so this is the case where the
        // connections list is the only evidence there is.
        const tiedCsv = [
            "CONVERSATION ID,FROM,TO,DATE,CONTENT,FOLDER,SENDER PROFILE URL,RECIPIENT PROFILE URLS",
            'c1,Sam Self,Ada,2025-01-01 10:00:00 UTC,"Hello Ada",INBOX,https://linkedin.com/in/sam,https://linkedin.com/in/ada',
            'c1,Ada,Sam Self,2025-01-02 10:00:00 UTC,"Hi Sam",INBOX,https://linkedin.com/in/ada,https://linkedin.com/in/sam',
        ].join("\n");

        const unaided = processPayload({ messagesCsv: tiedCsv });
        expect(unaided.threads[0].messages.map((entry) => entry.direction)).toEqual([
            "unknown",
            "unknown",
        ]);

        // Ada is a connection, and you are never in your own connections.
        const aided = processPayload({
            messagesCsv: tiedCsv,
            contactKeys: ["https://linkedin.com/in/ada"],
        });
        expect(aided.threads[0].messages.map((entry) => entry.direction)).toEqual([
            "sent",
            "received",
        ]);
    });

    it("keeps formula-prefixed and whitespace-led bodies verbatim", () => {
        // The spreadsheet cleaner quote-prefixes every one of these and trims the
        // rest, which is right for a workbook and wrong for a PDF.
        const bodies = [
            "+1, that works for me",
            "=hello, is this thing on?",
            "-10% is the best I can do",
            "@Ada could you take a look",
            "\tindented after a tab",
            "trailing spaces matter   ",
        ];
        const rows = bodies.map((body, index) =>
            [
                `c${index}`,
                "Sam Self",
                `Person${index}`,
                `2025-02-${String(index + 1).padStart(2, "0")} 10:00:00 UTC`,
                `"${body}"`,
                "INBOX",
                "https://linkedin.com/in/sam",
                `https://linkedin.com/in/person${index}`,
            ].join(","),
        );
        const csv = [
            "CONVERSATION ID,FROM,TO,DATE,CONTENT,FOLDER,SENDER PROFILE URL,RECIPIENT PROFILE URLS",
            ...rows,
        ].join("\n");

        const result = processPayload({ messagesCsv: csv, people: 10 });

        expect(result.success).toBe(true);
        const exported = result.threads
            .map((thread) => thread.messages[0].body)
            .sort((left, right) => left.localeCompare(right));
        expect(exported).toEqual([...bodies].sort((left, right) => left.localeCompare(right)));
        expect(exported.some((body) => body.startsWith("'"))).toBe(false);
    });

    it("keeps a body's own line breaks and control characters", () => {
        const csv = [
            "CONVERSATION ID,FROM,TO,DATE,CONTENT,FOLDER,SENDER PROFILE URL,RECIPIENT PROFILE URLS",
            'c1,Sam Self,Ada,2025-01-01 10:00:00 UTC,"line one\nline two",INBOX,https://linkedin.com/in/sam,https://linkedin.com/in/ada',
            'c2,Sam Self,Bob,2025-01-02 10:00:00 UTC,"she said ""yes"" twice",INBOX,https://linkedin.com/in/sam,https://linkedin.com/in/bob',
        ].join("\n");

        const result = processPayload({ messagesCsv: csv });
        const bodies = Object.fromEntries(
            result.threads.map((thread) => [thread.name, thread.messages[0].body]),
        );

        expect(bodies.Ada).toBe("line one\nline two");
        expect(bodies.Bob).toBe('she said "yes" twice');
    });

    it("reports an error for an unparseable CSV", () => {
        const result = processPayload({ messagesCsv: "not,a,valid,csv" });

        expect(result.success).toBe(false);
        expect(result.threads).toEqual([]);
        expect(result.error).toBeTruthy();
    });

    it("treats a non-string CSV as empty", () => {
        expect(processPayload({ messagesCsv: null }).success).toBe(false);
    });
});

describe("threads worker listeners", () => {
    let postMessageSpy;

    /**
     * Spy on the worker's postMessage, aliased to globalThis under jsdom.
     * @returns {import("vitest").MockInstance} The spy
     */
    function spyOnPostMessage() {
        postMessageSpy = vi.spyOn(globalThis, "postMessage").mockImplementation(() => {});
        return postMessageSpy;
    }

    /**
     * Dispatch an event onto the worker global.
     *
     * Cancelable, like the real `error` and `unhandledrejection` events, so a
     * handler that fails to cancel one is visible as `defaultPrevented`.
     * @param {string} type - Event type
     * @param {object} [properties] - Extra event properties
     * @returns {Event} The dispatched event
     */
    function dispatch(type, properties) {
        const event = new Event(type, { cancelable: true });
        for (const [key, value] of Object.entries(properties || {})) {
            Object.defineProperty(event, key, { value });
        }
        globalThis.dispatchEvent(event);
        return event;
    }

    /**
     * Serve one thread request, so the worker has an active id to answer under.
     *
     * `activeRequestId` is module-level state that outlives a test. Setting it
     * explicitly is what lets each failure test assert the id it is answered
     * under rather than inheriting whichever one the previous test left behind.
     * @param {number} requestId - Request id to serve
     */
    function serveRequest(requestId) {
        dispatch("message", {
            data: { type: "threads", requestId, payload: { messagesCsv: MESSAGES_CSV } },
        });
    }

    /**
     * Assert a posted failure payload carries nothing of the user's.
     * @param {object} message - Posted worker message
     */
    function expectFixedFailure(message) {
        expect(message.payload.success).toBe(false);
        expect(message.payload.threads).toEqual([]);
        expect(message.payload.error).toBe("Threads worker runtime failure.");
        expect(JSON.stringify(message)).not.toContain(PII_MARKER);
    }

    afterEach(() => {
        postMessageSpy.mockRestore();
    });

    it("ignores messages that are not thread requests", () => {
        spyOnPostMessage();
        dispatch("message", { data: { type: "process" } });

        expect(postMessageSpy).not.toHaveBeenCalled();
    });

    it("answers a thread request with the selection", () => {
        spyOnPostMessage();
        dispatch("message", {
            data: { type: "threads", requestId: 7, payload: { messagesCsv: MESSAGES_CSV } },
        });

        expect(postMessageSpy).toHaveBeenCalledOnce();
        const [message] = postMessageSpy.mock.calls[0];
        expect(message).toMatchObject({ type: "threads", requestId: 7 });
        expect(message.payload.success).toBe(true);
        expect(message.payload.threads).toHaveLength(2);
    });

    it("reports an invalid request payload under the id it arrived with", () => {
        spyOnPostMessage();
        dispatch("message", { data: { type: "threads", requestId: 12, payload: {} } });

        const [message] = postMessageSpy.mock.calls[0];
        // Answering under id 0 would leave the main thread waiting out its whole
        // size-scaled watchdog, which for a large stored CSV looks like a hang.
        expect(message.requestId).toBe(12);
        expect(message.payload.success).toBe(false);
        expect(message.payload.error).toContain("Missing messagesCsv payload");
    });

    it("answers a runtime error under the active request id without its text", () => {
        spyOnPostMessage();
        dispatch("message", {
            data: { type: "threads", requestId: 21, payload: { messagesCsv: MESSAGES_CSV } },
        });
        const event = dispatch("error", { error: piiError("worker-runtime") });

        // Uncancelled, the browser reports this event itself, and that report
        // goes to the console carrying whatever the error holds.
        expect(event.defaultPrevented).toBe(true);
        const [message] = postMessageSpy.mock.calls[1];
        expect(message.requestId).toBe(21);
        expectFixedFailure(message);
    });

    it("never forwards the text of a string-only error event", () => {
        spyOnPostMessage();
        serveRequest(41);
        const event = dispatch("error", { message: `boom ${PII_MARKER}` });

        expect(event.defaultPrevented).toBe(true);
        const [message] = postMessageSpy.mock.calls[1];
        expect(message.requestId).toBe(41);
        expectFixedFailure(message);
    });

    it("answers an error event that carries nothing", () => {
        spyOnPostMessage();
        serveRequest(42);
        const event = dispatch("error");

        expect(event.defaultPrevented).toBe(true);
        const [message] = postMessageSpy.mock.calls[1];
        expect(message.requestId).toBe(42);
        expectFixedFailure(message);
    });

    it("never forwards the reason of an unhandled rejection", () => {
        spyOnPostMessage();
        serveRequest(43);
        const event = dispatch("unhandledrejection", { reason: piiError("worker-rejection") });

        expect(event.defaultPrevented).toBe(true);
        const [message] = postMessageSpy.mock.calls[1];
        expect(message.requestId).toBe(43);
        expectFixedFailure(message);
    });

    it("never forwards an opaque rejection reason", () => {
        spyOnPostMessage();
        serveRequest(44);
        const event = dispatch("unhandledrejection", {
            reason: { kind: "opaque", body: PII_MARKER },
        });

        expect(event.defaultPrevented).toBe(true);
        const [message] = postMessageSpy.mock.calls[1];
        expect(message.requestId).toBe(44);
        expectFixedFailure(message);
    });

    it("answers a rejection event that carries no reason", () => {
        spyOnPostMessage();
        serveRequest(45);
        const event = dispatch("unhandledrejection");

        expect(event.defaultPrevented).toBe(true);
        const [message] = postMessageSpy.mock.calls[1];
        expect(message.requestId).toBe(45);
        expectFixedFailure(message);
    });

    it("never forwards the text of a failure thrown while answering", () => {
        spyOnPostMessage();
        postMessageSpy.mockImplementationOnce(() => {
            throw piiError("post");
        });
        dispatch("message", {
            data: { type: "threads", requestId: 31, payload: { messagesCsv: MESSAGES_CSV } },
        });

        const [message] = postMessageSpy.mock.calls[1];
        expect(message.requestId).toBe(31);
        expectFixedFailure(message);
    });
});
