import { afterEach, describe, expect, it, vi } from "vitest";

import { processPayload } from "../../../src/features/export/threads-worker.js";

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
     * @param {string} type - Event type
     * @param {object} [properties] - Extra event properties
     */
    function dispatch(type, properties) {
        const event = new Event(type);
        for (const [key, value] of Object.entries(properties || {})) {
            Object.defineProperty(event, key, { value });
        }
        globalThis.dispatchEvent(event);
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

    it("reports an invalid request payload", () => {
        spyOnPostMessage();
        dispatch("message", { data: { type: "threads", payload: {} } });

        const [message] = postMessageSpy.mock.calls[0];
        expect(message.payload.success).toBe(false);
        expect(message.payload.error).toContain("Missing messagesCsv payload");
    });

    it("forwards runtime error events", () => {
        spyOnPostMessage();
        dispatch("error", { error: new Error("threads-runtime") });

        const [message] = postMessageSpy.mock.calls[0];
        expect(message.payload.error).toContain("threads-runtime");
    });

    it("forwards string-only error events", () => {
        spyOnPostMessage();
        dispatch("error", { message: "threads-string-error" });

        expect(postMessageSpy.mock.calls[0][0].payload.error).toBe("threads-string-error");
    });

    it("falls back when an error event carries nothing", () => {
        spyOnPostMessage();
        dispatch("error");

        expect(postMessageSpy.mock.calls[0][0].payload.error).toBe(
            "Threads worker runtime failure.",
        );
    });

    it("forwards unhandled rejections", () => {
        spyOnPostMessage();
        dispatch("unhandledrejection", { reason: new Error("threads-rejection") });

        expect(postMessageSpy.mock.calls[0][0].payload.error).toContain("threads-rejection");
    });

    it("falls back for an opaque rejection reason", () => {
        spyOnPostMessage();
        dispatch("unhandledrejection", { reason: { kind: "opaque" } });

        expect(postMessageSpy.mock.calls[0][0].payload.error).toBe(
            "Threads worker runtime failure.",
        );
    });

    it("falls back when a rejection event carries no reason", () => {
        spyOnPostMessage();
        dispatch("unhandledrejection");

        expect(postMessageSpy.mock.calls[0][0].payload.error).toBe(
            "Threads worker runtime failure.",
        );
    });
});
