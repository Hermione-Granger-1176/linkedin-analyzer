import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { LinkedInCleaner } from "../src/cleaner.js";

const fixtureBase = resolve(process.cwd(), "tests/fixtures");

async function readFixture(name) {
    return readFile(resolve(fixtureBase, name), "utf8");
}

describe("web/python parity fixtures", () => {
    it("matches shared messages fixture contract", async () => {
        const csv = await readFixture("messages-parity.csv");
        const result = LinkedInCleaner.process(csv, "messages");

        expect(result.success).toBe(true);
        expect(result.cleanedData).toEqual([
            {
                FROM: "Ada",
                TO: "Bob",
                DATE: expect.any(String),
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
