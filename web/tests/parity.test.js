import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { LinkedInCleaner } from "../src/cleaner.js";

const fixtureBase = resolve(process.cwd(), "tests/fixtures");

async function readFixture(name) {
    return readFile(resolve(fixtureBase, name), "utf8");
}

// Cleaned dates are converted from UTC to the local timezone, so parity tests
// assert the format instead of an exact machine-dependent value.
const LOCAL_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

describe("web/python parity fixtures", () => {
    it("matches shared shares fixture contract", async () => {
        const csv = await readFixture("shares-parity.csv");
        const result = LinkedInCleaner.process(csv, "shares");

        expect(result.success).toBe(true);
        expect(result.cleanedData).toEqual([
            {
                Date: expect.stringMatching(LOCAL_DATETIME_PATTERN),
                ShareLink: "https://www.linkedin.com/feed/update/urn:li:share:1",
                ShareCommentary: 'He said "hi".\n\nNext "line" here.',
                SharedUrl: "https://example.com/post",
                MediaUrl: "",
                Visibility: "MEMBER_NETWORK",
            },
            {
                Date: expect.stringMatching(LOCAL_DATETIME_PATTERN),
                ShareLink: "https://www.linkedin.com/feed/update/urn:li:share:2",
                ShareCommentary: "Smart “quotes” and naïve emoji 📌 stay intact.",
                SharedUrl: "",
                MediaUrl: "",
                Visibility: "CONNECTIONS",
            },
        ]);
    });

    it("matches shared comments fixture contract", async () => {
        const csv = await readFixture("comments-parity.csv");
        const result = LinkedInCleaner.process(csv, "comments");

        expect(result.success).toBe(true);
        expect(result.cleanedData).toEqual([
            {
                Date: expect.stringMatching(LOCAL_DATETIME_PATTERN),
                Link: "https://www.linkedin.com/feed/update/urn:li:activity:1",
                Message: 'She wrote "great post" yesterday.\n📌 Naïve “smart quotes” line.',
            },
            {
                Date: expect.stringMatching(LOCAL_DATETIME_PATTERN),
                Link: "https://www.linkedin.com/feed/update/urn:li:activity:2",
                Message: 'Plain text with "doubled" quotes',
            },
        ]);
    });

    it("matches shared messages fixture contract", async () => {
        const csv = await readFixture("messages-parity.csv");
        const result = LinkedInCleaner.process(csv, "messages");

        expect(result.success).toBe(true);
        expect(result.cleanedData).toEqual([
            {
                FROM: "Ada",
                TO: "Bob",
                DATE: expect.stringMatching(LOCAL_DATETIME_PATTERN),
                CONTENT: 'He said "hello"',
                FOLDER: "INBOX",
                "CONVERSATION ID": "abc",
                "SENDER PROFILE URL": "https://linkedin.com/in/ada",
                "RECIPIENT PROFILE URLS": "https://linkedin.com/in/bob",
            },
        ]);
    });

    it("matches shared connections fixture contract", async () => {
        const csv = await readFixture("connections-parity.csv");
        const result = LinkedInCleaner.process(csv, "connections");

        expect(result.success).toBe(true);
        expect(result.cleanedData).toEqual([
            {
                "First Name": "Ada",
                "Last Name": "Lovelace",
                URL: "https://linkedin.com/in/ada",
                "Email Address": "",
                Company: "Analytical Engines",
                Position: "Mathematician",
                "Connected On": "2026-01-30",
            },
            {
                "First Name": "",
                "Last Name": "Builder",
                URL: "https://linkedin.com/in/bob",
                "Email Address": "",
                Company: "Builders Inc",
                Position: "Engineer",
                "Connected On": "2026-02-15",
            },
        ]);
    });
});
