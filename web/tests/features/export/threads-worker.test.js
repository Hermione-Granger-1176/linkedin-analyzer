import { afterEach, describe, expect, it, vi } from "vitest";

import { LinkedInCleaner } from "../../../src/features/cleaning/cleaner.js";
import { processPayload } from "../../../src/features/export/threads-worker.js";
import { PII_MARKER, piiError } from "../../helpers/pii-sentinel.js";
import { storedUpload } from "../../helpers/stored-upload.js";

const MESSAGES_CSV = [
    "CONVERSATION ID,FROM,TO,DATE,CONTENT,FOLDER,SENDER PROFILE URL,RECIPIENT PROFILE URLS",
    'c1,Sam Self,Ada,2025-01-01 10:00:00 UTC,"Hello Ada",INBOX,https://linkedin.com/in/sam,https://linkedin.com/in/ada',
    'c1,Ada,Sam Self,2025-01-02 10:00:00 UTC,"Hi Sam",INBOX,https://linkedin.com/in/ada,https://linkedin.com/in/sam',
    'c2,Sam Self,Bob,2025-01-03 10:00:00 UTC,"Hello Bob",INBOX,https://linkedin.com/in/sam,https://linkedin.com/in/bob',
].join("\n");

// One conversation, both directions: the messages file alone cannot say which
// of the two is the account owner, so this is the case where the connections
// list is the only evidence there is.
const TIED_CSV = [
    "CONVERSATION ID,FROM,TO,DATE,CONTENT,FOLDER,SENDER PROFILE URL,RECIPIENT PROFILE URLS",
    'c1,Sam Self,Ada,2025-01-01 10:00:00 UTC,"Hello Ada",INBOX,https://linkedin.com/in/sam,https://linkedin.com/in/ada',
    'c1,Ada,Sam Self,2025-01-02 10:00:00 UTC,"Hi Sam",INBOX,https://linkedin.com/in/ada,https://linkedin.com/in/sam',
].join("\n");

const CONNECTIONS_HEADER =
    "First Name,Last Name,URL,Email Address,Company,Position,Connected On";

/**
 * Build a connections export naming Ada, with the date column as given.
 * @param {string} connectedOn - Value of the "Connected On" cell
 * @returns {string} Connections CSV, preamble and all
 */
function adaConnectionsCsv(connectedOn) {
    return [
        "Notes:",
        "Export metadata",
        "",
        CONNECTIONS_HEADER,
        `Ada,,https://linkedin.com/in/ada,,Analytical Engines,Mathematician,${connectedOn}`,
    ].join("\n");
}

/**
 * Read the direction chip of every message in the first thread.
 * @param {{threads: object[]}} result - Worker result
 * @returns {string[]} Directions, oldest message first
 */
function directions(result) {
    return result.threads[0].messages.map((entry) => entry.direction);
}

describe("threads worker", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("cleans the CSV and selects threads", async () => {
        const result = await processPayload({ messagesCsv: MESSAGES_CSV });

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

    it("honours the selection limits from the request", async () => {
        const result = await processPayload({
            messagesCsv: MESSAGES_CSV,
            people: 1,
            messagesPerPerson: 1,
        });

        expect(result.threads).toHaveLength(1);
        expect(result.threads[0].messages).toHaveLength(1);
    });

    it("breaks a self-detection tie with the connections file from the request", async () => {
        const unaided = await processPayload({ messagesCsv: TIED_CSV });
        expect(directions(unaided)).toEqual(["unknown", "unknown"]);

        // Ada is a connection, and you are never in your own connections. The
        // keys are derived here rather than posted in: parsing this file is the
        // last piece of export work that used to run on the UI thread.
        const aided = await processPayload({
            messagesCsv: TIED_CSV,
            connectionsCsv: adaConnectionsCsv("01 Jan 2024"),
        });
        expect(directions(aided)).toEqual(["sent", "received"]);
    });

    it("keeps a connection whose export recorded no connection date", async () => {
        // The spreadsheet cleaner drops a row with no "Connected On", which is
        // right for the connections dashboard and wrong here: somebody you are
        // connected to is still not you whether or not the export recorded when
        // it happened. Deriving these keys from cleaned rows loses Ada, and the
        // tie goes back to "unknown".
        const undated = adaConnectionsCsv("");
        expect(LinkedInCleaner.process(undated, "connections").cleanedData).toHaveLength(0);

        const result = await processPayload({ messagesCsv: TIED_CSV, connectionsCsv: undated });

        expect(directions(result)).toEqual(["sent", "received"]);
    });

    it("leaves the tie unresolved when the connections file will not parse", async () => {
        const result = await processPayload({
            messagesCsv: TIED_CSV,
            connectionsCsv: "not,a,connections,export",
        });

        expect(result.success).toBe(true);
        expect(directions(result)).toEqual(["unknown", "unknown"]);
    });

    it("treats a non-string connections file as absent", async () => {
        const result = await processPayload({ messagesCsv: TIED_CSV, connectionsCsv: 7 });

        expect(result.success).toBe(true);
        expect(directions(result)).toEqual(["unknown", "unknown"]);
    });

    it("keeps the thread selection when the connections parse throws", async () => {
        // A tiebreak is a nicety: losing it costs a direction chip, not the
        // section. Nothing the parse threw may reach the reply either, since it
        // was reading the user's own connections when it failed.
        const parseCSV = LinkedInCleaner.parseCSV;
        vi.spyOn(LinkedInCleaner, "parseCSV").mockImplementation((text, fileType) => {
            if (fileType === "connections") {
                throw piiError("connections");
            }
            return parseCSV.call(LinkedInCleaner, text, fileType);
        });

        const result = await processPayload({
            messagesCsv: TIED_CSV,
            connectionsCsv: adaConnectionsCsv("01 Jan 2024"),
        });

        expect(result.success).toBe(true);
        expect(directions(result)).toEqual(["unknown", "unknown"]);
        expect(JSON.stringify(result)).not.toContain(PII_MARKER);
    });

    it("reads stored upload Blobs for both files", async () => {
        const result = await processPayload({
            messagesCsv: new Blob([TIED_CSV]),
            connectionsCsv: new Blob([adaConnectionsCsv("01 Jan 2024")]),
        });

        expect(directions(result)).toEqual(["sent", "received"]);
    });

    it("streams a stored messages upload to the same threads as its text", async () => {
        const parseCSV = vi.spyOn(LinkedInCleaner, "parseCSV");
        const fromText = await processPayload({ messagesCsv: MESSAGES_CSV });
        parseCSV.mockClear();

        const streamed = await processPayload({ messagesCsv: storedUpload(MESSAGES_CSV) });

        expect(streamed).toEqual(fromText);
        // The stream builds the rows itself; no whole-text parse runs.
        expect(parseCSV).not.toHaveBeenCalled();
    });

    it("restarts a stored messages upload that is not UTF-8 as windows-1252", async () => {
        // 0xE9 alone is invalid UTF-8 and "é" in windows-1252.
        const bytes = Uint8Array.from(
            MESSAGES_CSV.replace("Hello Bob", "Caf\u0000").split(""),
            (char) => (char === "\u0000" ? 0xe9 : char.charCodeAt(0)),
        );

        const result = await processPayload({ messagesCsv: storedUpload(bytes) });

        expect(result.success).toBe(true);
        expect(result.threads[0].messages.map((entry) => entry.body)).toContain("Café");
    });

    it("parses a stored upload whole when it streams as another file type", async () => {
        const shares =
            "Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility\n2025-01-01,x,y,,,PUBLIC";

        const result = await processPayload({ messagesCsv: storedUpload(shares) });

        expect(result.success).toBe(false);
        expect(result.threads).toEqual([]);
        expect(result.error).toContain("missing required Messages columns");
    });

    it("keeps the thread selection when the connections file cannot be read", async () => {
        const messagesCsv = await new Blob([TIED_CSV]).text();
        vi.spyOn(FileReader.prototype, "readAsArrayBuffer").mockImplementation(function fail() {
            this.onerror();
        });

        const result = await processPayload({
            messagesCsv,
            connectionsCsv: new Blob([adaConnectionsCsv("01 Jan 2024")]),
        });

        expect(result.success).toBe(true);
        expect(directions(result)).toEqual(["unknown", "unknown"]);
    });

    it("keeps formula-prefixed and whitespace-led bodies verbatim", async () => {
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

        const result = await processPayload({ messagesCsv: csv, people: 10 });

        expect(result.success).toBe(true);
        const exported = result.threads
            .map((thread) => thread.messages[0].body)
            .sort((left, right) => left.localeCompare(right));
        expect(exported).toEqual([...bodies].sort((left, right) => left.localeCompare(right)));
        expect(exported.some((body) => body.startsWith("'"))).toBe(false);
    });

    it("keeps a body's own line breaks and control characters", async () => {
        const csv = [
            "CONVERSATION ID,FROM,TO,DATE,CONTENT,FOLDER,SENDER PROFILE URL,RECIPIENT PROFILE URLS",
            'c1,Sam Self,Ada,2025-01-01 10:00:00 UTC,"line one\nline two",INBOX,https://linkedin.com/in/sam,https://linkedin.com/in/ada',
            'c2,Sam Self,Bob,2025-01-02 10:00:00 UTC,"she said ""yes"" twice",INBOX,https://linkedin.com/in/sam,https://linkedin.com/in/bob',
        ].join("\n");

        const result = await processPayload({ messagesCsv: csv });
        const bodies = Object.fromEntries(
            result.threads.map((thread) => [thread.name, thread.messages[0].body]),
        );

        expect(bodies.Ada).toBe("line one\nline two");
        expect(bodies.Bob).toBe('she said "yes" twice');
    });

    it("reports a fixed error for an unparseable CSV", async () => {
        // The only test of the one string this worker is allowed to emit, and
        // truthiness was all it used to ask for. This worker holds the raw
        // messages CSV, so returning the head of it as the "error" would have
        // put message text across the worker boundary and still passed.
        const result = await processPayload({ messagesCsv: `not,a,valid,csv ${PII_MARKER}` });

        expect(result.success).toBe(false);
        expect(result.threads).toEqual([]);
        expect(result.error).toBe("This file is missing required Messages columns: FROM, TO, DATE, CONTENT.");
        expect(JSON.stringify(result)).not.toContain(PII_MARKER);
    });

    it("treats a non-string CSV as empty", async () => {
        expect((await processPayload({ messagesCsv: null })).success).toBe(false);
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
     * @returns {Promise<void>} Resolves once the request is answered
     */
    async function serveRequest(requestId) {
        dispatch("message", {
            data: { type: "threads", requestId, payload: { messagesCsv: MESSAGES_CSV } },
        });
        await vi.waitFor(() => expect(postMessageSpy).toHaveBeenCalled());
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

    it("ignores messages that are not thread requests", async () => {
        spyOnPostMessage();
        dispatch("message", { data: { type: "process" } });

        expect(postMessageSpy).not.toHaveBeenCalled();
    });

    it("answers a thread request with the selection", async () => {
        spyOnPostMessage();
        dispatch("message", {
            data: { type: "threads", requestId: 7, payload: { messagesCsv: MESSAGES_CSV } },
        });

        await vi.waitFor(() => expect(postMessageSpy).toHaveBeenCalledOnce());
        const [message] = postMessageSpy.mock.calls[0];
        expect(message).toMatchObject({ type: "threads", requestId: 7 });
        expect(message.payload.success).toBe(true);
        expect(message.payload.threads).toHaveLength(2);
    });

    it("reports an invalid request payload under the id it arrived with", async () => {
        spyOnPostMessage();
        dispatch("message", { data: { type: "threads", requestId: 12, payload: {} } });

        const [message] = postMessageSpy.mock.calls[0];
        // Answering under id 0 would leave the main thread waiting out its whole
        // size-scaled watchdog, which for a large stored CSV looks like a hang.
        expect(message.requestId).toBe(12);
        expect(message.payload.success).toBe(false);
        expect(message.payload.error).toContain("Missing messagesCsv payload");
    });

    it("answers a runtime error under the active request id without its text", async () => {
        spyOnPostMessage();
        await serveRequest(21);
        const event = dispatch("error", { error: piiError("worker-runtime") });

        // Uncancelled, the browser reports this event itself, and that report
        // goes to the console carrying whatever the error holds.
        expect(event.defaultPrevented).toBe(true);
        const [message] = postMessageSpy.mock.calls[1];
        expect(message.requestId).toBe(21);
        expectFixedFailure(message);
    });

    it("never forwards the text of a string-only error event", async () => {
        spyOnPostMessage();
        await serveRequest(41);
        const event = dispatch("error", { message: `boom ${PII_MARKER}` });

        expect(event.defaultPrevented).toBe(true);
        const [message] = postMessageSpy.mock.calls[1];
        expect(message.requestId).toBe(41);
        expectFixedFailure(message);
    });

    it("answers an error event that carries nothing", async () => {
        spyOnPostMessage();
        await serveRequest(42);
        const event = dispatch("error");

        expect(event.defaultPrevented).toBe(true);
        const [message] = postMessageSpy.mock.calls[1];
        expect(message.requestId).toBe(42);
        expectFixedFailure(message);
    });

    it("never forwards the reason of an unhandled rejection", async () => {
        spyOnPostMessage();
        await serveRequest(43);
        const event = dispatch("unhandledrejection", { reason: piiError("worker-rejection") });

        expect(event.defaultPrevented).toBe(true);
        const [message] = postMessageSpy.mock.calls[1];
        expect(message.requestId).toBe(43);
        expectFixedFailure(message);
    });

    it("never forwards an opaque rejection reason", async () => {
        spyOnPostMessage();
        await serveRequest(44);
        const event = dispatch("unhandledrejection", {
            reason: { kind: "opaque", body: PII_MARKER },
        });

        expect(event.defaultPrevented).toBe(true);
        const [message] = postMessageSpy.mock.calls[1];
        expect(message.requestId).toBe(44);
        expectFixedFailure(message);
    });

    it("answers a rejection event that carries no reason", async () => {
        spyOnPostMessage();
        await serveRequest(45);
        const event = dispatch("unhandledrejection");

        expect(event.defaultPrevented).toBe(true);
        const [message] = postMessageSpy.mock.calls[1];
        expect(message.requestId).toBe(45);
        expectFixedFailure(message);
    });

    it("never forwards the text of a failure thrown while answering", async () => {
        spyOnPostMessage();
        postMessageSpy.mockImplementationOnce(() => {
            throw piiError("post");
        });
        dispatch("message", {
            data: { type: "threads", requestId: 31, payload: { messagesCsv: MESSAGES_CSV } },
        });

        await vi.waitFor(() => expect(postMessageSpy).toHaveBeenCalledTimes(2));
        const [message] = postMessageSpy.mock.calls[1];
        expect(message.requestId).toBe(31);
        expectFixedFailure(message);
    });
});
