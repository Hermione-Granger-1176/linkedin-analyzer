// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { generateLargeExport, parseArgs } from "../../../scripts/fixtures/gen-large-export.mjs";
import { LinkedInCleaner } from "../../src/features/cleaning/cleaner.js";
import { MessagesAnalytics } from "../../src/features/messages/analytics.js";

const FILES = {
    "messages.csv": "messages",
    "Connections.csv": "connections",
    "Shares.csv": "shares",
    "Comments.csv": "comments",
};
const root = mkdtempSync(join(tmpdir(), "gen-large-export-test-"));

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("gen-large-export", () => {
    const dir = join(root, "one");
    const results = generateLargeExport({ sizeMb: 1, dir });

    it("writes every file near its share of the requested size", () => {
        const total = Object.values(results).reduce((sum, { bytes }) => sum + bytes, 0);
        expect(Object.keys(results).sort()).toEqual(Object.keys(FILES).sort());
        expect(total).toBeGreaterThanOrEqual(1024 * 1024);
        expect(total).toBeLessThan(1.01 * 1024 * 1024);
    });

    it("produces files the cleaner accepts in full", () => {
        for (const [file, type] of Object.entries(FILES)) {
            const result = LinkedInCleaner.process(readFileSync(join(dir, file), "utf8"), type);
            expect(result.success, file).toBe(true);
            expect(result.rowCount, file).toBe(results[file].rows);
        }
    });

    it("produces messages with one self account and same-name contacts", () => {
        const csv = readFileSync(join(dir, "messages.csv"), "utf8");
        const { cleanedData } = LinkedInCleaner.process(csv, "messages");

        const state = MessagesAnalytics.buildMessageState(cleanedData);

        const contacts = [...state.contacts.values()];
        expect(contacts.length).toBeGreaterThan(100);
        expect(contacts.some((contact) => contact.name === "Avery Quinn")).toBe(false);
        const byName = new Map();
        contacts.forEach((contact) => {
            byName.set(contact.name, (byName.get(contact.name) || 0) + 1);
        });
        expect([...byName.values()].some((count) => count > 1)).toBe(true);
        // Japanese kana, so the UTF-8 decoder sees multi-byte text.
        expect(csv).toMatch(/[\u3040-\u30ff]/);
        expect(csv).toContain('""');
    });

    it("writes the same bytes for the same size", () => {
        const again = join(root, "two");
        generateLargeExport({ sizeMb: 1, dir: again });
        for (const file of Object.keys(FILES)) {
            const same = readFileSync(join(again, file)).equals(readFileSync(join(dir, file)));
            expect(same, file).toBe(true);
        }
    });

    it("refuses to write inside the repository or with a bad size", () => {
        expect(() => generateLargeExport({ sizeMb: 1, dir: resolve("web/tests") })).toThrow(
            /inside the repository/,
        );
        expect(() => generateLargeExport({ sizeMb: 0, dir })).toThrow(/positive/);
    });

    it("parses CLI options with a temp-directory default", () => {
        expect(parseArgs(["--size-mb", "30", "--dir", "/x"])).toEqual({ sizeMb: 30, dir: "/x" });
        const defaultDir = join(tmpdir(), "linkedin-analyzer-export-5mb");
        expect(parseArgs(["--size-mb", "5"]).dir).toBe(defaultDir);
        expect(() => parseArgs(["--bogus"])).toThrow(/invalid option/);
    });
});
