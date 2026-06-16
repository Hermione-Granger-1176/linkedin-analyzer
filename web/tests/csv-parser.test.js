import { describe, expect, it } from "vitest";

import {
    CSV_OPTIONS_COMMENTS,
    CSV_OPTIONS_DEFAULT,
    isRowEmpty,
    parseCsvRows,
} from "../src/csv-parser.js";

describe("parseCsvRows escape handling (comments options)", () => {
    it("collapses a backslash-escaped quote inside a quoted field", () => {
        const { rows, error } = parseCsvRows('"a\\"b"', CSV_OPTIONS_COMMENTS);
        expect(error).toBeNull();
        expect(rows).toEqual([['a"b']]);
    });

    it("keeps a backslash literal when it does not escape a quote", () => {
        // Escape char (\) followed by a non-quote char falls through to the
        // literal-append branch inside the quoted-field state machine.
        const { rows, error } = parseCsvRows('"a\\b"', CSV_OPTIONS_COMMENTS);
        expect(error).toBeNull();
        expect(rows).toEqual([["a\\b"]]);
    });

    it("keeps a trailing backslash literal at end of input", () => {
        const { rows } = parseCsvRows('"a\\', CSV_OPTIONS_COMMENTS);
        // Unterminated quote, but the literal backslash is appended first.
        expect(rows[0][0]).toContain("a\\");
    });
});

describe("parseCsvRows carriage-return handling inside quotes", () => {
    it("preserves a bare CR (not followed by LF) inside a quoted field", () => {
        const { rows, error } = parseCsvRows('"line1\rline2"', CSV_OPTIONS_DEFAULT);
        expect(error).toBeNull();
        expect(rows).toEqual([["line1\rline2"]]);
    });

    it("collapses CRLF to LF inside a quoted field", () => {
        const { rows, error } = parseCsvRows('"line1\r\nline2"', CSV_OPTIONS_DEFAULT);
        expect(error).toBeNull();
        expect(rows).toEqual([["line1\nline2"]]);
    });
});

describe("parseCsvRows field-size guard for mid-field quotes", () => {
    it("rejects an unquoted field that overflows just as a mid-field quote arrives", () => {
        // Build a field exactly at the limit, then a mid-field quote: the bulk
        // copy fills the field to the cap, and the following lone quote trips
        // the per-character overflow guard.
        const atLimit = "x".repeat(200000);
        const { rows, error } = parseCsvRows(`${atLimit}"y`, CSV_OPTIONS_DEFAULT);
        expect(rows).toEqual([]);
        expect(error).toMatch(/too large/i);
    });
});

describe("parseCsvRows field-size guard inside quoted fields", () => {
    const atLimit = "x".repeat(200000);

    it("rejects a doubled quote that would overflow the field cap", () => {
        // Quoted field already at the cap, then a doubled quote ("") whose
        // collapse to a single literal quote would exceed the limit.
        const { rows, error } = parseCsvRows(`"${atLimit}""`, CSV_OPTIONS_DEFAULT);
        expect(rows).toEqual([]);
        expect(error).toMatch(/too large/i);
    });

    it("rejects a carriage return that would overflow the field cap", () => {
        // Quoted field already at the cap, then a bare CR whose literal append
        // would exceed the limit (the per-character overflow guard fires before
        // the CR-handling branch).
        const { rows, error } = parseCsvRows(`"${atLimit}\r`, CSV_OPTIONS_DEFAULT);
        expect(rows).toEqual([]);
        expect(error).toMatch(/too large/i);
    });
});

describe("isRowEmpty", () => {
    it("treats a row of only missing cells as empty", () => {
        expect(isRowEmpty(["", "NA", null, undefined])).toBe(true);
    });

    it("treats a row with any present cell as non-empty", () => {
        expect(isRowEmpty(["", "value"])).toBe(false);
    });
});
