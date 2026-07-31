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

/**
 * Build a row between two contacts whose date cannot be parsed.
 * @param {{from: string, to: string, conversationId: string}} spec - Row spec
 * @returns {object} Message row
 */
function undatedBetween(spec) {
    return row({
        FROM: spec.from,
        "SENDER PROFILE URL": `https://www.linkedin.com/in/${spec.from}`,
        TO: spec.to,
        "RECIPIENT PROFILE URLS": `https://www.linkedin.com/in/${spec.to}`,
        DATE: "not a date",
        CONTENT: "undated",
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

    it("does not let undated rows decide who the account owner is", () => {
        const threads = selectRecentThreads([
            message({
                name: "ada",
                conversationId: "c1",
                date: "2026-01-01 10:00:00",
                body: "mine",
            }),
            message({
                name: "ada",
                conversationId: "c1",
                date: "2026-01-01 11:00:00",
                body: "hers",
                fromContact: true,
            }),
            message({
                name: "bob",
                conversationId: "c2",
                date: "2026-01-01 09:00:00",
                body: "mine too",
            }),
            // Ada talks to Carol in two more conversations than the owner
            // appears in, but none of those rows has a readable date.
            undatedBetween({ from: "ada", to: "carol", conversationId: "c3" }),
            undatedBetween({ from: "carol", to: "ada", conversationId: "c4" }),
        ]);

        const ada = threads.find((thread) => thread.name === "ada");
        expect(ada.messages.map((entry) => entry.direction)).toEqual(["sent", "received"]);
        expect(threads.some((thread) => thread.name === "carol")).toBe(false);
    });

    it("counts people, not threads, against the head limit", () => {
        const rows = [];
        // Nine one-to-one threads, most recent first.
        for (let index = 0; index < 9; index += 1) {
            rows.push(
                message({
                    name: `solo${index}`,
                    conversationId: `s${index}`,
                    date: `2026-03-${String(index + 1).padStart(2, "0")} 10:00:00`,
                    body: "hi",
                }),
                message({
                    name: `solo${index}`,
                    conversationId: `s${index}`,
                    date: `2026-03-${String(index + 1).padStart(2, "0")} 11:00:00`,
                    body: "hello",
                    fromContact: true,
                }),
            );
        }
        // A four-person group, more recent than all of them.
        rows.push(
            row({
                DATE: "2026-04-01 10:00:00",
                CONTENT: "group",
                "CONVERSATION ID": "g1",
                TO: "gina,greg,gail,gus",
                "RECIPIENT PROFILE URLS": [
                    "https://www.linkedin.com/in/gina",
                    "https://www.linkedin.com/in/greg",
                    "https://www.linkedin.com/in/gail",
                    "https://www.linkedin.com/in/gus",
                ].join(","),
            }),
        );

        const threads = selectRecentThreads(rows, { people: 10 });
        const names = threads.flatMap((thread) => thread.name.split(", "));

        expect(new Set(names).size).toBeLessThanOrEqual(10);
        // The group leads, then only as many one-to-one threads as still fit.
        expect(threads[0].name).toContain("gina");
        expect(names).toHaveLength(10);
    });

    it("skips a group larger than the whole budget and keeps taking smaller threads", () => {
        const threads = selectRecentThreads(
            [
                message({ name: "ada", conversationId: "c1", date: "2026-01-01 10:00:00", body: "mine" }),
                message({
                    name: "ada",
                    conversationId: "c1",
                    date: "2026-01-01 11:00:00",
                    body: "hers",
                    fromContact: true,
                }),
                row({
                    DATE: "2026-05-01 10:00:00",
                    CONTENT: "crowd",
                    "CONVERSATION ID": "g1",
                    TO: "gina,greg,gail",
                    "RECIPIENT PROFILE URLS": [
                        "https://www.linkedin.com/in/gina",
                        "https://www.linkedin.com/in/greg",
                        "https://www.linkedin.com/in/gail",
                    ].join(","),
                }),
            ],
            { people: 2 },
        );

        // The three-person group cannot fit a budget of two, but skipping it
        // must not also drop the older one-to-one thread that does fit.
        expect(threads.map((thread) => thread.name)).toEqual(["ada"]);
    });

    it("ranks people by their most recent message and caps the count", () => {        const rows = [];
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

    it("settles a single-conversation export from the connections list", () => {
        const rows = [
            message({ name: "ada", conversationId: "c1", date: "2026-01-01 10:00:00", body: "mine" }),
            message({
                name: "ada",
                conversationId: "c1",
                date: "2026-01-01 11:00:00",
                body: "hers",
                fromContact: true,
            }),
        ];

        // Nothing in the messages file separates the two people: one
        // conversation each, both send and both receive.
        const unaided = selectRecentThreads(rows);
        expect(unaided[0].messages.map((entry) => entry.direction)).toEqual([
            "unknown",
            "unknown",
        ]);

        // Ada is a connection; the account owner never is.
        const aided = selectRecentThreads(rows, {
            contactKeys: ["https://www.linkedin.com/in/ada"],
        });
        expect(aided).toHaveLength(1);
        expect(aided[0].name).toBe("ada");
        expect(aided[0].messages.map((entry) => entry.direction)).toEqual(["sent", "received"]);
    });

    it("leaves the tie unresolved when connections cannot separate the two", () => {
        const rows = [
            message({ name: "ada", conversationId: "c1", date: "2026-01-01 10:00:00", body: "mine" }),
            message({
                name: "ada",
                conversationId: "c1",
                date: "2026-01-01 11:00:00",
                body: "hers",
                fromContact: true,
            }),
        ];

        // Every candidate is a connection, which is not evidence about either.
        const both = selectRecentThreads(rows, {
            contactKeys: ["https://www.linkedin.com/in/ada", SELF_URL],
        });
        expect(both[0].messages.every((entry) => entry.direction === "unknown")).toBe(true);

        // An unrelated connections list says nothing either.
        const neither = selectRecentThreads(rows, {
            contactKeys: ["https://www.linkedin.com/in/zoe"],
        });
        expect(neither[0].messages.every((entry) => entry.direction === "unknown")).toBe(true);

        // And a non-array option is ignored rather than throwing.
        expect(selectRecentThreads(rows, { contactKeys: "nope" })).toHaveLength(1);
    });

    it("names the sender of a single received message, not the account owner", () => {        const threads = selectRecentThreads([
            message({
                name: "ada",
                conversationId: "c1",
                date: "2026-01-01 10:00:00",
                body: "hello",
                fromContact: true,
            }),
        ]);

        expect(threads).toHaveLength(1);
        expect(threads[0].name).toContain("ada");
        // Both people tie on every piece of evidence there is, so the export
        // refuses to call this received message "sent".
        expect(threads[0].messages[0].direction).toBe("unknown");
    });

    it("does not claim a direction for a single sent message either", () => {
        const threads = selectRecentThreads([
            message({ name: "ada", conversationId: "c1", date: "2026-01-01 10:00:00", body: "hi" }),
        ]);

        expect(threads[0].messages[0].direction).toBe("unknown");
        expect(threads[0].name).toContain("ada");
    });

    it("does not guess self from a received-only one-person conversation", () => {
        const rows = ["one", "two", "three"].map((body, index) =>
            message({
                name: "ada",
                conversationId: "c1",
                date: `2026-01-0${index + 1} 10:00:00`,
                body,
                fromContact: true,
            }),
        );

        const [thread] = selectRecentThreads(rows);

        expect(thread.messages.map((entry) => entry.direction)).toEqual([
            "unknown",
            "unknown",
            "unknown",
        ]);
    });

    it("does not guess self from a sent-only one-person conversation", () => {
        const rows = ["one", "two", "three"].map((body, index) =>
            message({
                name: "ada",
                conversationId: "c1",
                date: `2026-01-0${index + 1} 10:00:00`,
                body,
            }),
        );

        const [thread] = selectRecentThreads(rows);

        expect(thread.messages.every((entry) => entry.direction === "unknown")).toBe(true);
    });

    it("identifies self from a one-directional export across conversations", () => {
        const rows = ["ada", "bob", "cy"].map((name, index) =>
            message({
                name,
                conversationId: `c${index}`,
                date: `2026-01-0${index + 1} 10:00:00`,
                body: "hi",
            }),
        );

        const threads = selectRecentThreads(rows);

        expect(threads.map((thread) => thread.name)).toEqual(["cy", "bob", "ada"]);
        expect(threads.every((thread) => thread.messages[0].direction === "sent")).toBe(true);
    });

    it("keeps a conversation together when its first row names nobody", () => {
        const threads = selectRecentThreads([
            // The unattributable row comes first: grouping must not depend on
            // having already seen an attributable row in this conversation.
            row({
                DATE: "2026-01-01 10:00:00",
                CONTENT: "one",
                "CONVERSATION ID": "c1",
                TO: SELF_NAME,
                "RECIPIENT PROFILE URLS": SELF_URL,
            }),
            message({ name: "ada", conversationId: "c1", date: "2026-01-02 10:00:00", body: "two" }),
            message({ name: "bob", conversationId: "c2", date: "2026-01-01 09:00:00", body: "hi" }),
        ]);

        const ada = threads.find((thread) => thread.name === "ada");
        expect(ada.messageCount).toBe(2);
        expect(ada.messages.map((entry) => entry.body)).toEqual(["one", "two"]);
    });

    it("keeps one thread when a contact is renamed mid-conversation", () => {
        const threads = selectRecentThreads([
            // No profile URL on either row, so only the CONVERSATION ID says
            // these two displayed names are the same conversation.
            message({
                name: "Ada Lovelace",
                url: "",
                conversationId: "c1",
                date: "2026-01-01 10:00:00",
                body: "one",
            }),
            message({
                name: "Ada Byron",
                url: "",
                conversationId: "c1",
                date: "2026-01-02 10:00:00",
                body: "two",
            }),
            message({ name: "bob", conversationId: "c2", date: "2026-01-01 09:00:00", body: "hi" }),
        ]);

        const ada = threads.filter((thread) => thread.name.includes("Ada"));
        expect(ada).toHaveLength(1);
        expect(ada[0].messageCount).toBe(2);
        expect(ada[0].name).toBe("Ada Lovelace, Ada Byron");
    });

    it("keeps one thread when a conversation mixes named and URL-less rows", () => {
        const threads = selectRecentThreads([
            message({
                name: "Ada Lovelace",
                url: "https://www.linkedin.com/in/ada",
                conversationId: "c1",
                date: "2026-01-01 10:00:00",
                body: "one",
            }),
            // Same conversation, no URL and a different displayed name: only the
            // CONVERSATION ID ties these two rows together.
            message({
                name: "Ada L.",
                url: "",
                conversationId: "c1",
                date: "2026-01-02 10:00:00",
                body: "two",
            }),
            message({ name: "bob", conversationId: "c2", date: "2026-01-01 09:00:00", body: "hi" }),
        ]);

        const ada = threads.filter((thread) => thread.name.includes("Ada"));
        expect(ada).toHaveLength(1);
        expect(ada[0].messageCount).toBe(2);
        expect(ada[0].messages.map((entry) => entry.body)).toEqual(["one", "two"]);
    });

    it("resolves a renamed URL-less alias to the same person across conversations", () => {
        const adaUrl = "https://www.linkedin.com/in/ada";
        const threads = selectRecentThreads([
            message({
                name: "Ada Lovelace",
                url: adaUrl,
                conversationId: "c1",
                date: "2026-01-01 10:00:00",
                body: "one",
            }),
            // Renamed mid-conversation, and this display name never appears
            // anywhere carrying a profile URL.
            message({
                name: "Ada L.",
                url: "",
                conversationId: "c1",
                date: "2026-01-02 10:00:00",
                body: "two",
            }),
            // A separate conversation, under the URL only.
            message({
                name: "Ada Lovelace",
                url: adaUrl,
                conversationId: "c2",
                date: "2026-01-03 10:00:00",
                body: "three",
            }),
            message({ name: "bob", conversationId: "c3", date: "2026-01-01 08:00:00", body: "hi" }),
        ]);

        const ada = threads.filter((thread) => thread.name.includes("Ada"));
        expect(ada).toHaveLength(1);
        // One person, not a two-member group, and the URL survives.
        expect(ada[0].name).toBe("Ada Lovelace");
        expect(ada[0].url).toBe(adaUrl);
        expect(ada[0].messageCount).toBe(3);
        expect(ada[0].messages.map((entry) => entry.body)).toEqual(["one", "two", "three"]);
    });

    it("keeps an anonymous conversation instead of dropping it", () => {
        const threads = selectRecentThreads([
            message({ name: "ada", conversationId: "c1", date: "2026-01-01 10:00:00", body: "old" }),
            message({ name: "ada", conversationId: "c1", date: "2026-01-01 11:00:00", body: "old reply", fromContact: true }),
            row({
                FROM: "LinkedIn Member",
                "SENDER PROFILE URL": "",
                TO: SELF_NAME,
                "RECIPIENT PROFILE URLS": SELF_URL,
                DATE: "2026-02-01 10:00:00",
                CONTENT: "anonymous hello",
                "CONVERSATION ID": "c9",
            }),
        ]);

        const anonymous = threads.find((thread) => thread.name === "LinkedIn Member");
        expect(anonymous).toBeDefined();
        expect(anonymous.messages.map((entry) => entry.body)).toEqual(["anonymous hello"]);
        expect(anonymous.messages[0].direction).toBe("received");
        // Most recent, so it leads the document.
        expect(threads[0]).toBe(anonymous);
    });

    it("keeps two anonymous conversations apart", () => {
        const threads = selectRecentThreads([
            message({ name: "ada", conversationId: "c1", date: "2026-01-01 10:00:00", body: "mine" }),
            message({ name: "ada", conversationId: "c1", date: "2026-01-01 11:00:00", body: "hers", fromContact: true }),
            row({
                FROM: "LinkedIn Member",
                "SENDER PROFILE URL": "",
                TO: SELF_NAME,
                "RECIPIENT PROFILE URLS": SELF_URL,
                DATE: "2026-02-01 10:00:00",
                CONTENT: "first stranger",
                "CONVERSATION ID": "c8",
            }),
            row({
                FROM: "LinkedIn Member",
                "SENDER PROFILE URL": "",
                TO: SELF_NAME,
                "RECIPIENT PROFILE URLS": SELF_URL,
                DATE: "2026-02-02 10:00:00",
                CONTENT: "second stranger",
                "CONVERSATION ID": "c9",
            }),
        ]);

        const anonymous = threads.filter((thread) => thread.name === "LinkedIn Member");
        expect(anonymous).toHaveLength(2);
        expect(anonymous.flatMap((thread) => thread.messages.map((entry) => entry.body))).toEqual([
            "second stranger",
            "first stranger",
        ]);
    });

    it("still drops an anonymous row with no conversation to scope it to", () => {
        const threads = selectRecentThreads([
            message({ name: "ada", conversationId: "c1", date: "2026-01-01 10:00:00", body: "mine" }),
            message({ name: "ada", conversationId: "c1", date: "2026-01-01 11:00:00", body: "hers", fromContact: true }),
            row({
                FROM: "LinkedIn Member",
                "SENDER PROFILE URL": "",
                TO: SELF_NAME,
                "RECIPIENT PROFILE URLS": SELF_URL,
                DATE: "2026-02-01 10:00:00",
                CONTENT: "unattributable",
                "CONVERSATION ID": "",
            }),
        ]);

        expect(threads.some((thread) => thread.name === "LinkedIn Member")).toBe(false);
    });

    it("keeps a group conversation as its own thread", () => {
        const threads = selectRecentThreads([
            message({ name: "ada", conversationId: "c1", date: "2026-01-01 10:00:00", body: "solo" }),
            row({
                DATE: "2026-01-02 10:00:00",
                CONTENT: "group",
                "CONVERSATION ID": "c2",
                TO: "ada,bob",
                "RECIPIENT PROFILE URLS":
                    "https://www.linkedin.com/in/ada,https://www.linkedin.com/in/bob",
            }),
            message({ name: "cy", conversationId: "c3", date: "2026-01-01 09:00:00", body: "hi" }),
        ]);

        const group = threads.find((thread) => thread.name.includes(",") && thread.name.includes("bob"));
        expect(group.name).toBe("ada, bob");
        expect(group.messageCount).toBe(1);
        expect(group.url).toBe("");

        const solo = threads.find((thread) => thread.name === "ada");
        expect(solo.messageCount).toBe(1);
        expect(solo.messages.map((entry) => entry.body)).toEqual(["solo"]);
    });

    it("drops a conversation whose every row is self-only", () => {
        const threads = selectRecentThreads([
            message({ name: "ada", conversationId: "c1", date: "2026-01-01 10:00:00", body: "hi" }),
            row({
                DATE: "2026-01-02 10:00:00",
                CONTENT: "note to self",
                "CONVERSATION ID": "c2",
                TO: SELF_NAME,
                "RECIPIENT PROFILE URLS": SELF_URL,
            }),
            message({ name: "bob", conversationId: "c3", date: "2026-01-01 09:00:00", body: "yo" }),
        ]);

        expect(threads.map((thread) => thread.name).sort()).toEqual(["ada", "bob"]);
    });

    it("attributes a row whose sender is nameless and URL-less", () => {
        const threads = selectRecentThreads([
            message({ name: "ada", conversationId: "c1", date: "2026-01-01 10:00:00", body: "one" }),
            row({
                FROM: "",
                "SENDER PROFILE URL": "",
                TO: "ada",
                "RECIPIENT PROFILE URLS": "https://www.linkedin.com/in/ada",
                DATE: "2026-01-03 10:00:00",
                CONTENT: "two",
                "CONVERSATION ID": "c1",
            }),
            message({ name: "bob", conversationId: "c2", date: "2026-01-01 09:00:00", body: "hi" }),
        ]);

        const ada = threads.find((thread) => thread.name === "ada");
        expect(ada.messageCount).toBe(2);
    });

    it("fills in a correspondent's profile URL from a later conversation", () => {
        const contactUrl = "https://www.linkedin.com/in/ada";
        const threads = selectRecentThreads([
            // The URL-less conversation comes first, so the identity is completed
            // by a conversation seen later.
            message({
                name: "ada",
                url: "",
                conversationId: "c1",
                date: "2026-01-01 10:00:00",
                body: "one",
            }),
            message({
                name: "ada",
                url: contactUrl,
                conversationId: "c2",
                date: "2026-01-02 10:00:00",
                body: "two",
            }),
            message({ name: "bob", conversationId: "c3", date: "2026-01-01 09:00:00", body: "hi" }),
        ]);

        const ada = threads.filter((thread) => thread.name === "ada");
        expect(ada).toHaveLength(1);
        expect(ada[0].url).toBe(contactUrl);
    });

    it("replaces a placeholder name once a real one shows up", () => {
        const contactUrl = "https://www.linkedin.com/in/ada";
        const threads = selectRecentThreads([
            row({
                DATE: "2026-01-01 10:00:00",
                CONTENT: "one",
                "CONVERSATION ID": "c1",
                TO: "",
                "RECIPIENT PROFILE URLS": contactUrl,
            }),
            message({
                name: "Ada Lovelace",
                url: contactUrl,
                conversationId: "c2",
                date: "2026-01-02 10:00:00",
                body: "two",
            }),
            message({ name: "bob", conversationId: "c3", date: "2026-01-01 09:00:00", body: "hi" }),
        ]);

        const ada = threads.find((thread) => thread.name !== "bob");
        expect(ada.name).toBe("Ada Lovelace");
        expect(ada.messageCount).toBe(2);
    });

    it("falls back to a profile URL when a correspondent has no name", () => {
        const contactUrl = "https://www.linkedin.com/in/anonymous-person";
        const threads = selectRecentThreads([
            row({
                DATE: "2026-01-02 10:00:00",
                CONTENT: "hi",
                "CONVERSATION ID": "c1",
                TO: "",
                "RECIPIENT PROFILE URLS": contactUrl,
            }),
            message({ name: "bob", conversationId: "c2", date: "2026-01-01 09:00:00", body: "yo" }),
        ]);

        const anonymous = threads.find((thread) => thread.name !== "bob");
        expect(anonymous.name).toBe(contactUrl);
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
