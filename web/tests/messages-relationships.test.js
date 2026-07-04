/**
 * Vitest unit tests for the pure relationship queries over messages and
 * connections state. These were extracted from messages-insights.js and take
 * plain state objects, so they run without a DOM.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MessagesAnalytics } from "../src/messages-analytics.js";
import {
    getFadingConversations,
    getSilentConnections,
    getTopContactsInRange,
} from "../src/messages-relationships.js";

const DAY = 24 * 60 * 60 * 1000;
const nameKeyFor = (name) => MessagesAnalytics.normalizeName(name);

/**
 * Build a message-analytics state object with overridable pieces.
 * @param {object} parts - State fragments to merge
 * @returns {object} Message state accepted by the relationship queries
 */
function messageState(parts = {}) {
    return {
        events: [],
        contacts: new Map(),
        rowTimestamps: [],
        talkedUrlKeys: new Set(),
        talkedNameKeys: new Set(),
        ...parts,
    };
}

/**
 * Build a connection state object with overridable pieces.
 * @param {object} parts - State fragments to merge
 * @returns {object} Connection state accepted by the relationship queries
 */
function connectionState(parts = {}) {
    return {
        list: [],
        byUrl: new Map(),
        byName: new Map(),
        ...parts,
    };
}

describe("getTopContactsInRange", () => {
    it("aggregates counts and last-seen timestamps per contact", () => {
        const state = messageState({
            events: [
                { contactKey: "a", timestamp: 100 },
                { contactKey: "a", timestamp: 300 },
                { contactKey: "b", timestamp: 200 },
            ],
            contacts: new Map([
                ["a", { name: "Ada", url: "u/ada" }],
                ["b", { name: "Bob", url: "u/bob" }],
            ]),
            rowTimestamps: [100, 200, 300],
        });

        const result = getTopContactsInRange(state, null);
        expect(result.totalPeople).toBe(2);
        expect(result.totalMessages).toBe(3);
        expect(result.totalRows).toBe(3);
        expect(result.items[0]).toMatchObject({ key: "a", count: 2, lastTimestamp: 300 });
        expect(result.items[1]).toMatchObject({ key: "b", count: 1 });
    });

    it("labels contacts missing from the map as Unknown", () => {
        const state = messageState({
            events: [{ contactKey: "ghost", timestamp: 100 }],
            rowTimestamps: [100],
        });
        const result = getTopContactsInRange(state, null);
        expect(result.items[0]).toMatchObject({ name: "Unknown", url: "" });
    });

    it("filters events and rows before the range start", () => {
        const state = messageState({
            events: [
                { contactKey: "a", timestamp: 100 },
                { contactKey: "a", timestamp: 500 },
            ],
            contacts: new Map([["a", { name: "Ada", url: "u/ada" }]]),
            rowTimestamps: [100, 500],
        });
        const result = getTopContactsInRange(state, 300);
        expect(result.items[0].count).toBe(1);
        expect(result.totalRows).toBe(1);
    });

    it("breaks ties by count, then recency, then name", () => {
        const state = messageState({
            // Same count and same last timestamp forces the name tie-break.
            events: [
                { contactKey: "z", timestamp: 200 },
                { contactKey: "a", timestamp: 200 },
            ],
            contacts: new Map([
                ["z", { name: "Zoe", url: "u/zoe" }],
                ["a", { name: "Ada", url: "u/ada" }],
            ]),
            rowTimestamps: [200, 200],
        });
        const result = getTopContactsInRange(state, null);
        expect(result.items.map((item) => item.name)).toEqual(["Ada", "Zoe"]);
    });
});

describe("getSilentConnections", () => {
    it("returns connections with no messages by url or name", () => {
        const connections = connectionState({
            list: [
                { name: "Ada", url: "u/ada", nameKey: "ada", connectedOnTimestamp: 10 },
                { name: "Bob", url: "u/bob", nameKey: "bob", connectedOnTimestamp: 20 },
            ],
        });
        const messages = messageState({
            talkedUrlKeys: new Set(["u/ada"]),
        });
        const silent = getSilentConnections(messages, connections);
        expect(silent.map((connection) => connection.name)).toEqual(["Bob"]);
    });

    it("treats a name match as not silent", () => {
        const connections = connectionState({
            list: [{ name: "Bob", url: "", nameKey: "bob", connectedOnTimestamp: 20 }],
        });
        const messages = messageState({ talkedNameKeys: new Set(["bob"]) });
        expect(getSilentConnections(messages, connections)).toEqual([]);
    });

    it("orders two never-dated connections by name", () => {
        const connections = connectionState({
            list: [
                { name: "Zoe", url: "u/zoe", nameKey: "zoe", connectedOnTimestamp: null },
                { name: "Ada", url: "u/ada", nameKey: "ada", connectedOnTimestamp: null },
            ],
        });
        const silent = getSilentConnections(messageState(), connections);
        expect(silent.map((connection) => connection.name)).toEqual(["Ada", "Zoe"]);
    });

    it("sorts by connected date, pushing null dates last, then by name", () => {
        const connections = connectionState({
            list: [
                { name: "Zoe", url: "u/zoe", nameKey: "zoe", connectedOnTimestamp: null },
                { name: "Ada", url: "u/ada", nameKey: "ada", connectedOnTimestamp: 50 },
                // Same timestamp as Ada forces the name tie-break.
                { name: "Cy", url: "u/cy", nameKey: "cy", connectedOnTimestamp: 50 },
            ],
        });
        const silent = getSilentConnections(messageState(), connections);
        expect(silent.map((connection) => connection.name)).toEqual(["Ada", "Cy", "Zoe"]);
    });
});

describe("getFadingConversations", () => {
    let nowSpy;

    beforeEach(() => {
        nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000 * DAY);
    });

    afterEach(() => {
        nowSpy.mockRestore();
    });

    it("returns connected contacts with no message in the last 30 days", () => {
        const contacts = new Map([
            ["a", { name: "Ada", url: "u/ada", lastTimestamp: 1_000 * DAY - 45 * DAY }],
        ]);
        const messages = messageState({ contacts });
        const connections = connectionState({
            byUrl: new Map([["u/ada", { url: "u/ada", company: "Acme" }]]),
        });
        const fading = getFadingConversations(messages, connections);
        expect(fading).toHaveLength(1);
        expect(fading[0]).toMatchObject({ name: "Ada", daysSince: 45, company: "Acme" });
    });

    it("matches by normalized name when the url is absent", () => {
        const contacts = new Map([
            ["a", { name: "Ada Lovelace", url: "", lastTimestamp: 1_000 * DAY - 40 * DAY }],
        ]);
        const messages = messageState({ contacts });
        const connections = connectionState({
            byName: new Map([
                [nameKeyFor("Ada Lovelace"), { url: "u/ada", company: "Acme" }],
            ]),
        });
        const fading = getFadingConversations(messages, connections);
        expect(fading.map((item) => item.name)).toEqual(["Ada Lovelace"]);
    });

    it("skips contacts without a matching connection", () => {
        const contacts = new Map([
            ["a", { name: "Stranger", url: "u/none", lastTimestamp: 1_000 * DAY - 90 * DAY }],
        ]);
        const messages = messageState({ contacts });
        expect(getFadingConversations(messages, connectionState())).toEqual([]);
    });

    it("skips contacts messaged within the last 30 days", () => {
        const contacts = new Map([
            ["a", { name: "Recent", url: "u/recent", lastTimestamp: 1_000 * DAY - 5 * DAY }],
        ]);
        const messages = messageState({ contacts });
        const connections = connectionState({
            byUrl: new Map([["u/recent", { url: "u/recent", company: "Acme" }]]),
        });
        expect(getFadingConversations(messages, connections)).toEqual([]);
    });

    it("sorts by most-recent contact, then by name", () => {
        const sharedTs = 1_000 * DAY - 60 * DAY;
        const contacts = new Map([
            ["z", { name: "Zoe", url: "u/zoe", lastTimestamp: sharedTs }],
            ["a", { name: "Ada", url: "u/ada", lastTimestamp: sharedTs }],
        ]);
        const messages = messageState({ contacts });
        const connections = connectionState({
            byUrl: new Map([
                ["u/zoe", { url: "u/zoe", company: "Z" }],
                ["u/ada", { url: "u/ada", company: "A" }],
            ]),
        });
        const fading = getFadingConversations(messages, connections);
        expect(fading.map((item) => item.name)).toEqual(["Ada", "Zoe"]);
    });
});
