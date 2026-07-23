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

// Non-UTF-8 decode parity is out of scope for this harness: the web parity path
// is fed an already-decoded string, so encoding detection is not exercised here.

const CORPUS_TYPES = ["shares", "comments", "messages", "connections"];
const MALFORMED_OUTCOME_CATEGORIES = new Set([
    "accepted",
    "empty_input",
    "invalid_header",
    "parse_error",
]);

function normalizeCsvOutcome(result) {
    if (result.success) {
        return "accepted";
    }

    const error = result.error || "";
    if (/empty|no header rows after skip/i.test(error)) {
        return "empty_input";
    }
    if (
        /Could not parse CSV headers|Duplicate columns after header normalization|Missing columns:/i.test(
            error,
        )
    ) {
        return "invalid_header";
    }
    if (/CSV parsing error/i.test(error)) {
        return "parse_error";
    }
    throw new Error(`Unclassified web CSV outcome: ${JSON.stringify(error)}`);
}

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
            {
                Date: expect.stringMatching(LOCAL_DATETIME_PATTERN),
                ShareLink: "https://www.linkedin.com/feed/update/urn:li:share:4",
                ShareCommentary: "'=SUM(A1:B2)",
                SharedUrl: "",
                MediaUrl: "",
                Visibility: "MEMBER_NETWORK",
            },
            {
                // Impossible date passes through as raw text; pin it exactly.
                Date: "2026-02-30 10:00:00",
                ShareLink: "https://www.linkedin.com/feed/update/urn:li:share:5",
                ShareCommentary: "'@mention leads this",
                SharedUrl: "",
                MediaUrl: "",
                Visibility: "CONNECTIONS",
            },
            {
                Date: expect.stringMatching(LOCAL_DATETIME_PATTERN),
                ShareLink: "https://www.linkedin.com/feed/update/urn:li:share:6",
                // The BEL control character (\x07) is stripped so the export stays writable.
                ShareCommentary: "Bellchar removed",
                SharedUrl: "",
                MediaUrl: "",
                Visibility: "MEMBER_NETWORK",
            },
        ]);
    });

    it("matches shared comments fixture contract", async () => {
        const csv = await readFixture("comments-parity.csv");
        const result = LinkedInCleaner.process(csv, "comments");

        expect(result.success).toBe(true);
        // The "none" row is dropped (Message required, NONE is a sentinel).
        expect(result.cleanedData).toHaveLength(3);
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
            {
                Date: expect.stringMatching(LOCAL_DATETIME_PATTERN),
                Link: "https://www.linkedin.com/feed/update/urn:li:activity:4",
                Message: "'+1 first-token payload",
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
            {
                FROM: "Eve",
                TO: "Bob",
                // UTC is stripped, then the impossible date passes through as
                // raw text; pin it exactly.
                DATE: "2026-02-30 10:00:00",
                CONTENT: "'-2 plus 2",
                FOLDER: "ARCHIVE",
                "CONVERSATION ID": "ghi",
                "SENDER PROFILE URL": "",
                "RECIPIENT PROFILE URLS": "",
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
            {
                "First Name": "'=2+5",
                "Last Name": "'+Lovelace",
                URL: "",
                "Email Address": "",
                Company: "'-Analytical Co",
                Position: "'@Handle Corp",
                // Impossible "30 Feb 2026" date passes through as raw text.
                "Connected On": "30 Feb 2026",
            },
            {
                "First Name": "Bob",
                "Last Name": "Builder II",
                URL: "https://linkedin.com/in/bob2",
                "Email Address": "",
                Company: "Builders Inc",
                Position: "Engineer",
                "Connected On": "2026-09-15",
            },
        ]);
    });
});

describe("shared malformed CSV outcomes", () => {
    it("uses the stable outcome vocabulary", async () => {
        const manifest = JSON.parse(await readFixture("malformed-csv-outcomes.json"));

        expect(new Set(manifest.categories)).toEqual(MALFORMED_OUTCOME_CATEGORIES);
        expect(new Set(manifest.cases.map(({ boundary }) => boundary))).toEqual(
            new Set(["valid", "malformed"]),
        );
        expect(new Set(manifest.cases.map(({ id }) => id)).size).toBe(manifest.cases.length);
    });

    it("matches every web outcome in the shared manifest", async () => {
        const manifest = JSON.parse(await readFixture("malformed-csv-outcomes.json"));

        for (const testCase of manifest.cases) {
            const result = LinkedInCleaner.process(testCase.csv, testCase.fileType);
            expect(normalizeCsvOutcome(result), testCase.id).toBe(testCase.expected.web);
            expect(testCase.expected.web, testCase.id).toBe(testCase.expected.python);
        }
    });
});

describe("web/python synthetic corpus", () => {
    it.each(CORPUS_TYPES)("cleans the %s corpus to the shared expected output", async (type) => {
        const expected = JSON.parse(await readFixture("parity-corpus-expected.json"));
        const csv = await readFixture(`${type}-corpus.csv`);

        const result = LinkedInCleaner.process(csv, type);

        expect(result.success).toBe(true);
        expect(result.cleanedData).toEqual(expected[type]);
    });
});
