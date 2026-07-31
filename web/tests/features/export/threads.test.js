import { describe, expect, it } from "vitest";

import { selectRecentThreads } from "../../../src/features/export/threads.js";

const SELF_NAME = "Sam Self";
const SELF_URL = "https://www.linkedin.com/in/sam-self";

/**
 * Build a cleaned message row in the shape LinkedInCleaner produces.
 * @param {object} overrides - Field overrides
 * @returns {object} Message row
 */
function row(overrides) {
    return {
        FROM: SELF_NAME,
        TO: "",
        DATE: "2026-01-01 09:00:00",
        CONTENT: "",
        FOLDER: "INBOX",
        "CONVERSATION ID": "",
        "SENDER PROFILE URL": SELF_URL,
        "RECIPIENT PROFILE URLS": "",
        ...overrides,
    };
}

/**
 * Build a two-way exchange with one contact so self-detection has enough
 * cross-conversation evidence to identify the account owner.
 * @param {{name: string, url?: string, conversationId: string, date: string, body: string, fromContact?: boolean}} spec - Message spec
 * @returns {object} Message row
 */
function message(spec) {
    const contactUrl = spec.url === undefined ? `https://www.linkedin.com/in/${spec.name}` : spec.url;
    if (spec.fromContact) {
        return row({
            FROM: spec.name,
            "SENDER PROFILE URL": contactUrl,
            TO: SELF_NAME,
            "RECIPIENT PROFILE URLS": SELF_URL,
            DATE: spec.date,
            CONTENT: spec.body,
            "CONVERSATION ID": spec.conversationId,
        });
    }
    return row({
        TO: spec.name,
        "RECIPIENT PROFILE URLS": contactUrl,
        DATE: spec.date,
        CONTENT: spec.body,
        "CONVERSATION ID": spec.conversationId,
    });
}

describe("selectRecentThreads", () => {
    it("returns an empty list for empty and non-array input", () => {
        expect(selectRecentThreads([])).toEqual([]);
        expect(selectRecentThreads(null)).toEqual([]);
        expect(selectRecentThreads(undefined)).toEqual([]);
    });

    it("groups a conversation and orders its messages chronologically", () => {
        const threads = selectRecentThreads([
            message({ name: "ada", conversationId: "c1", date: "2026-01-03 10:00:00", body: "third" }),
            message({
                name: "ada",
                conversationId: "c1",
                date: "2026-01-01 10:00:00",
                body: "first",
                fromContact: true,
            }),
            message({ name: "ada", conversationId: "c1", date: "2026-01-02 10:00:00", body: "second" }),
        ]);

        expect(threads).toHaveLength(1);
        expect(threads[0].messageCount).toBe(3);
        expect(threads[0].messages.map((entry) => entry.body)).toEqual([
            "first",
            "second",
            "third",
        ]);
        expect(threads[0].lastTimestamp).toBe(new Date("2026-01-03T10:00:00").getTime());
    });

    it("marks direction from the detected self", () => {
        const threads = selectRecentThreads([
            message({ name: "ada", conversationId: "c1", date: "2026-01-01 10:00:00", body: "hi" }),
            message({
                name: "ada",
                conversationId: "c1",
                date: "2026-01-02 10:00:00",
                body: "hello",
                fromContact: true,
            }),
            message({ name: "bob", conversationId: "c2", date: "2026-01-01 11:00:00", body: "yo" }),
        ]);

        const ada = threads.find((thread) => thread.name === "ada");
        expect(ada.messages.map((entry) => entry.direction)).toEqual(["sent", "received"]);
    });

    it("falls back to the contact key when CONVERSATION ID is blank", () => {
        const threads = selectRecentThreads([
            message({ name: "ada", conversationId: "", date: "2026-01-01 10:00:00", body: "one" }),
            message({ name: "ada", conversationId: "", date: "2026-01-02 10:00:00", body: "two" }),
            message({ name: "bob", conversationId: "", date: "2026-01-03 10:00:00", body: "three" }),
        ]);

        expect(threads).toHaveLength(2);
        expect(threads.map((thread) => thread.name)).toEqual(["bob", "ada"]);
        expect(threads[1].messageCount).toBe(2);
    });

    it("folds a contact seen both with and without a profile URL into one thread", () => {
        const contactUrl = "https://www.linkedin.com/in/ada";
        const threads = selectRecentThreads([
            message({
                name: "ada",
                url: contactUrl,
                conversationId: "c1",
                date: "2026-01-01 10:00:00",
                body: "with url",
            }),
            message({
                name: "ada",
                url: "",
                conversationId: "c2",
                date: "2026-01-02 10:00:00",
                body: "without url",
            }),
            message({ name: "bob", conversationId: "c3", date: "2026-01-01 09:00:00", body: "hi" }),
        ]);

        const ada = threads.filter((thread) => thread.name === "ada");
        expect(ada).toHaveLength(1);
        expect(ada[0].url).toBe(contactUrl);
        expect(ada[0].messageCount).toBe(2);
        expect(ada[0].messages.map((entry) => entry.body)).toEqual(["with url", "without url"]);
    });

    it("keeps a conversation together when a later row drops the correspondent", () => {
        const threads = selectRecentThreads([
            message({ name: "ada", conversationId: "c1", date: "2026-01-01 10:00:00", body: "one" }),
            // A self-only row: no identifiable correspondent, but the conversation
            // id ties it back to the same thread.
            row({
                DATE: "2026-01-02 10:00:00",
                CONTENT: "two",
                "CONVERSATION ID": "c1",
                TO: SELF_NAME,
                "RECIPIENT PROFILE URLS": SELF_URL,
            }),
            message({ name: "bob", conversationId: "c2", date: "2026-01-01 09:00:00", body: "hi" }),
        ]);

        const ada = threads.find((thread) => thread.name === "ada");
        expect(ada.messageCount).toBe(2);
        expect(ada.messages.map((entry) => entry.body)).toEqual(["one", "two"]);
    });

    it("drops rows with no identifiable correspondent at all", () => {
        const threads = selectRecentThreads([
            message({ name: "ada", conversationId: "c1", date: "2026-01-01 10:00:00", body: "one" }),
            message({ name: "bob", conversationId: "c2", date: "2026-01-01 09:00:00", body: "two" }),
            row({ DATE: "2026-01-05 10:00:00", CONTENT: "orphan", TO: "", "CONVERSATION ID": "" }),
        ]);

        expect(threads.map((thread) => thread.name).sort()).toEqual(["ada", "bob"]);
        expect(threads.every((thread) => thread.messageCount === 1)).toBe(true);
    });

    it("skips rows whose date cannot be parsed", () => {
        const threads = selectRecentThreads([
            message({ name: "ada", conversationId: "c1", date: "2026-01-01 10:00:00", body: "kept" }),
            message({ name: "ada", conversationId: "c1", date: "not a date", body: "dropped" }),
            message({ name: "bob", conversationId: "c2", date: "2026-01-01 09:00:00", body: "hi" }),
        ]);

        const ada = threads.find((thread) => thread.name === "ada");
        expect(ada.messageCount).toBe(1);
        expect(ada.messages.map((entry) => entry.body)).toEqual(["kept"]);
    });

    it("ranks people by their most recent message and caps the count", () => {
        const rows = [];
        for (let index = 0; index < 14; index += 1) {
            rows.push(
                message({
                    name: `person${index}`,
                    conversationId: `c${index}`,
                    date: `2026-01-${String(index + 1).padStart(2, "0")} 10:00:00`,
                    body: `body ${index}`,
                }),
            );
        }

        const threads = selectRecentThreads(rows);

        expect(threads).toHaveLength(10);
        expect(threads[0].name).toBe("person13");
        expect(threads[9].name).toBe("person4");
    });

    it("honours a custom people limit", () => {
        const rows = [];
        for (let index = 0; index < 5; index += 1) {
            rows.push(
                message({
                    name: `person${index}`,
                    conversationId: `c${index}`,
                    date: `2026-01-0${index + 1} 10:00:00`,
                    body: "hi",
                }),
            );
        }

        expect(selectRecentThreads(rows, { people: 2 })).toHaveLength(2);
    });

    it("keeps only the last messages of each person", () => {
        const rows = [];
        for (let index = 0; index < 9; index += 1) {
            rows.push(
                message({
                    name: "ada",
                    conversationId: "c1",
                    date: `2026-01-0${index + 1} 10:00:00`,
                    body: `body ${index}`,
                }),
            );
        }
        rows.push(
            message({ name: "bob", conversationId: "c2", date: "2026-01-01 09:00:00", body: "hi" }),
        );

        const [ada] = selectRecentThreads(rows);

        expect(ada.messageCount).toBe(9);
        expect(ada.messages).toHaveLength(5);
        expect(ada.messages.map((entry) => entry.body)).toEqual([
            "body 4",
            "body 5",
            "body 6",
            "body 7",
            "body 8",
        ]);
    });

    it("honours a custom per-person message limit", () => {
        const rows = [
            message({ name: "ada", conversationId: "c1", date: "2026-01-01 10:00:00", body: "a" }),
            message({ name: "ada", conversationId: "c1", date: "2026-01-02 10:00:00", body: "b" }),
            message({ name: "bob", conversationId: "c2", date: "2026-01-01 09:00:00", body: "hi" }),
        ];

        const [ada] = selectRecentThreads(rows, { messagesPerPerson: 1 });

        expect(ada.messages.map((entry) => entry.body)).toEqual(["b"]);
    });

    it("ignores unusable option values", () => {
        const rows = [
            message({ name: "ada", conversationId: "c1", date: "2026-01-01 10:00:00", body: "a" }),
            message({ name: "bob", conversationId: "c2", date: "2026-01-02 10:00:00", body: "b" }),
        ];

        expect(
            selectRecentThreads(rows, { people: 0, messagesPerPerson: Number.NaN }),
        ).toHaveLength(2);
        expect(selectRecentThreads(rows, { people: "many" })).toHaveLength(2);
    });

    it("keeps message bodies untruncated", () => {
        const body = "x".repeat(20000);
        const threads = selectRecentThreads([
            message({ name: "ada", conversationId: "c1", date: "2026-01-01 10:00:00", body }),
            message({ name: "bob", conversationId: "c2", date: "2026-01-01 09:00:00", body: "hi" }),
        ]);

        expect(threads.find((thread) => thread.name === "ada").messages[0].body).toHaveLength(20000);
    });

    it("keeps identical timestamps in row order", () => {
        const threads = selectRecentThreads([
            message({ name: "ada", conversationId: "c1", date: "2026-01-01 10:00:00", body: "one" }),
            message({ name: "ada", conversationId: "c1", date: "2026-01-01 10:00:00", body: "two" }),
            message({ name: "bob", conversationId: "c2", date: "2026-01-01 09:00:00", body: "hi" }),
        ]);

        expect(threads.find((thread) => thread.name === "ada").messages.map((m) => m.body)).toEqual([
            "one",
            "two",
        ]);
    });
});
