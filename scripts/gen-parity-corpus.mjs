/**
 * Generate the synthetic cross-runtime parity corpus.
 *
 * Writes one CSV per cleaner type under tests/fixtures/*-corpus.csv plus a
 * single tests/fixtures/parity-corpus-expected.json holding the cleaned output.
 * The corpus is deterministic (seeded PRNG) and exercises a broad slice of the
 * cleaning surface: quote/backslash escaping, formula-injection prefixes,
 * XML-illegal control characters, smart quotes/emoji/multibyte text, sentinel
 * missing values, impossible dates, long fields, a BOM header, and rows that
 * drop out because a required or all-optional column is missing.
 *
 * The expected output is produced by the web cleaner (web/src/cleaner.js). The
 * Python parity suite reads the same corpus and asserts its cleaned output
 * equals this expected file, so the two runtimes must agree cell for cell. A
 * cleaning change in one runtime without the other then fails `make test`.
 *
 * Date columns cleaned by cleanDate (Shares/Comments/Messages) use only
 * impossible or unparseable values so they pass through unchanged; a real UTC
 * timestamp would convert to the local timezone and make the checked-in
 * expected file machine dependent. Connections dates carry no timezone.
 *
 * Regenerate with: make gen-parity-corpus
 */

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LinkedInCleaner } from "../web/src/cleaner.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "..", "tests", "fixtures");
const ROWS_PER_TYPE = 220;
const BOM = "﻿";

/**
 * Deterministic 32-bit PRNG (mulberry32) so the corpus is byte-stable.
 * @param {number} seed - Initial seed.
 * @returns {() => number} Function returning floats in [0, 1).
 */
function mulberry32(seed) {
    let state = seed >>> 0;
    return () => {
        state |= 0;
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const LONG_FIELD = "L".repeat(300);

// Plain-text payloads routed through trim/clean_value style columns. Each is
// designed to clean identically in both runtimes.
const TEXT_PAYLOADS = [
    "Ada Lovelace",
    "  padded value  ",
    "Cafe resume naive facade",
    "Smart “quotes” stay",
    "emoji 📌🚀 tail",
    "line one\nline two",
    "=SUM(A1:B2)",
    "+1 leads here",
    "-danger flag",
    "@handle mention",
    "tab\tinside value",
    LONG_FIELD,
    "ctrl ab\u0007cd end",
    "interior\u0001break",
    "\u000bleading vtab",
    "form\u000cfeed mid",
];

// Values that clean to empty (missing sentinels) or otherwise drop a row when
// they land in a required column.
const SENTINEL_PAYLOADS = ["NA", "NULL", "#N/A", "<NA>", "none", "NaN", "  "];

// clean_empty_field columns (URLs, emails): a mix of real values and blanks.
const EMPTY_FIELD_PAYLOADS = [
    "https://example.com/profile/1",
    "https://linkedin.com/in/sample",
    "",
    "NA",
    "person@example.com",
    "  ",
];

// cleanDate columns: impossible or unparseable so output is timezone stable.
const INVALID_DATE_PAYLOADS = [
    "2026-02-30 10:00:00",
    "2026-13-05 09:00:00",
    "2026-06-31 12:00:00",
    "2026-02-30 10:00:00 UTC",
    "1999-01-01",
    "sometime later",
];

// cleanConnectionsDate columns: valid English dates (no timezone) plus an
// impossible one that passes through unchanged.
const CONNECTION_DATE_PAYLOADS = [
    "30 Jan 2026",
    "15 September 2026",
    "01 Dec 2025",
    "07 Mar 2024",
    "30 Feb 2026",
];

// Content payloads for cleanMessagesContent (default-parsed types). Interior
// quotes are written with RFC doubling so the parser yields a single quote.
const CONTENT_PAYLOADS = [
    "plain content body",
    'says "hi" once',
    "Smart “quotes” and cafe",
    "emoji 📌 payload",
    "=cmd injection",
    "ctrl body ab\u0007cd tail",
    LONG_FIELD,
    "multi\nline body",
];

// Message payloads for cleanCommentsMessage (comments use backslash escaping).
// Interior quotes are written as \" so both parsers collapse them to a quote.
const COMMENT_PAYLOADS = [
    "plain comment",
    'wrote "great post" today',
    "Smart “quotes” cafe naive",
    "emoji 🚀 reply",
    "+formula lead",
    "ctrl comment ab\u0007cd",
    LONG_FIELD,
    "multi\nline comment",
];

/**
 * Pick a deterministic element from a pool.
 * @param {() => number} rand - PRNG.
 * @param {Array<string>} pool - Candidate values.
 * @returns {string} Selected value.
 */
function pick(rand, pool) {
    return pool[Math.floor(rand() * pool.length)];
}

/**
 * Encode one field for a default (RFC 4180) CSV: quote when it contains a
 * delimiter, quote, or newline, doubling any interior quote.
 * @param {string} value - Raw field value.
 * @returns {string} CSV-encoded field.
 */
function encDefault(value) {
    if (/[",\n\r]/.test(value)) {
        return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
}

/**
 * Encode one field for the comments CSV (backslash escape char): quote when it
 * contains a delimiter, quote, or newline, escaping interior quotes with a
 * backslash to match pandas escapechar and the web comments parser.
 * @param {string} value - Raw field value.
 * @returns {string} CSV-encoded field.
 */
function encComments(value) {
    if (/[",\n\r]/.test(value)) {
        return `"${value.replace(/"/g, '\\"')}"`;
    }
    return value;
}

/**
 * Join encoded fields into one CSV line.
 * @param {Array<string>} fields - Raw field values.
 * @param {(value: string) => string} enc - Field encoder.
 * @returns {string} CSV row text.
 */
function row(fields, enc) {
    return fields.map(enc).join(",");
}

/**
 * Build the Shares corpus CSV text.
 * @returns {string} CSV text.
 */
function buildShares() {
    const rand = mulberry32(101);
    const header = `${BOM}Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility`;
    const lines = [header];
    for (let i = 0; i < ROWS_PER_TYPE; i += 1) {
        // Every 11th row drops out via a missing required column.
        const requiredMissing = i % 11 === 0;
        const date = requiredMissing
            ? pick(rand, SENTINEL_PAYLOADS)
            : pick(rand, INVALID_DATE_PAYLOADS);
        const link = `https://www.linkedin.com/feed/update/urn:li:share:${i}`;
        const commentary = pick(rand, CONTENT_PAYLOADS);
        lines.push(
            row(
                [
                    date,
                    link,
                    commentary,
                    pick(rand, EMPTY_FIELD_PAYLOADS),
                    pick(rand, EMPTY_FIELD_PAYLOADS),
                    pick(rand, ["MEMBER_NETWORK", "CONNECTIONS", "PUBLIC"]),
                ],
                encDefault,
            ),
        );
    }
    lines.push("");
    return lines.join("\n");
}

/**
 * Build the Comments corpus CSV text.
 * @returns {string} CSV text.
 */
function buildComments() {
    const rand = mulberry32(202);
    const lines = ["Date,Link,Message"];
    for (let i = 0; i < ROWS_PER_TYPE; i += 1) {
        const requiredMissing = i % 9 === 0;
        const date = pick(rand, INVALID_DATE_PAYLOADS);
        const link = `https://www.linkedin.com/feed/update/urn:li:activity:${i}`;
        const message = requiredMissing
            ? pick(rand, SENTINEL_PAYLOADS)
            : pick(rand, COMMENT_PAYLOADS);
        lines.push(row([date, link, message], encComments));
    }
    lines.push("");
    return lines.join("\n");
}

/**
 * Build the Messages corpus CSV text.
 * @returns {string} CSV text.
 */
function buildMessages() {
    const rand = mulberry32(303);
    const lines = [
        "CONVERSATION ID,FROM,TO,DATE,CONTENT,FOLDER,SENDER PROFILE URL,RECIPIENT PROFILE URLS",
    ];
    for (let i = 0; i < ROWS_PER_TYPE; i += 1) {
        const requiredMissing = i % 13 === 0;
        const from = requiredMissing ? pick(rand, SENTINEL_PAYLOADS) : pick(rand, TEXT_PAYLOADS);
        const content = pick(rand, CONTENT_PAYLOADS);
        lines.push(
            row(
                [
                    `conv-${i}`,
                    from,
                    pick(rand, TEXT_PAYLOADS),
                    pick(rand, INVALID_DATE_PAYLOADS),
                    content,
                    pick(rand, ["INBOX", "ARCHIVE", "SENT"]),
                    pick(rand, EMPTY_FIELD_PAYLOADS),
                    pick(rand, EMPTY_FIELD_PAYLOADS),
                ],
                encDefault,
            ),
        );
    }
    lines.push("");
    return lines.join("\n");
}

/**
 * Build the Connections corpus CSV text (three skip rows before the header).
 * @returns {string} CSV text.
 */
function buildConnections() {
    const rand = mulberry32(404);
    const lines = [
        "Notes:",
        '"When exporting your connections, ..."',
        "",
        "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
    ];
    for (let i = 0; i < ROWS_PER_TYPE; i += 1) {
        // Every 8th row drops because all of First/Last/URL are missing.
        const allMissing = i % 8 === 0;
        const first = allMissing ? pick(rand, SENTINEL_PAYLOADS) : pick(rand, TEXT_PAYLOADS);
        const last = allMissing ? "" : pick(rand, TEXT_PAYLOADS);
        const url = allMissing ? "" : pick(rand, EMPTY_FIELD_PAYLOADS);
        lines.push(
            row(
                [
                    first,
                    last,
                    url,
                    pick(rand, EMPTY_FIELD_PAYLOADS),
                    pick(rand, TEXT_PAYLOADS),
                    pick(rand, TEXT_PAYLOADS),
                    pick(rand, CONNECTION_DATE_PAYLOADS),
                ],
                encDefault,
            ),
        );
    }
    lines.push("");
    return lines.join("\n");
}

const BUILDERS = {
    shares: buildShares,
    comments: buildComments,
    messages: buildMessages,
    connections: buildConnections,
};

/**
 * Generate the corpus CSVs and the shared expected-output JSON.
 * @returns {void}
 */
function main() {
    const expected = {};
    for (const [type, build] of Object.entries(BUILDERS)) {
        const csv = build();
        writeFileSync(resolve(FIXTURES, `${type}-corpus.csv`), csv, "utf8");

        const result = LinkedInCleaner.process(csv, type);
        if (!result.success) {
            throw new Error(`Corpus for ${type} failed to clean: ${result.error}`);
        }
        if (!result.cleanedData.length) {
            throw new Error(`Corpus for ${type} produced no rows`);
        }
        expected[type] = result.cleanedData;
    }

    writeFileSync(
        resolve(FIXTURES, "parity-corpus-expected.json"),
        `${JSON.stringify(expected, null, 2)}\n`,
        "utf8",
    );

    const counts = Object.entries(expected)
        .map(([type, rows]) => `${type}=${rows.length}`)
        .join(", ");
    console.error(`Wrote parity corpus: ${counts}`);
}

main();
