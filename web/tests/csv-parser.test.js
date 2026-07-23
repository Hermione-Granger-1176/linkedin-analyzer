import { describe, expect, it } from "vitest";

import { MAX_CSV_CHARS } from "../src/constants.js";
import {
    CSV_OPTIONS_COMMENTS,
    CSV_OPTIONS_DEFAULT,
    isRowEmpty,
    parseCsvRows,
} from "../src/csv-parser.js";

describe("parseCsvRows input-size guard", () => {
    it("rejects input longer than the character limit", () => {
        // Pass a length-bearing object so the guard trips without allocating a
        // multi-megabyte string (the early return never scans the characters).
        const { rows, error } = parseCsvRows({ length: MAX_CSV_CHARS + 1 });
        expect(rows).toEqual([]);
        expect(error).toMatch(/parser limit/);
    });
});

describe("parseCsvRows row endings outside quotes", () => {
    it("splits rows on a bare CR not followed by LF", () => {
        const { rows, error } = parseCsvRows("a\rb", CSV_OPTIONS_DEFAULT);
        expect(error).toBeNull();
        expect(rows).toEqual([["a"], ["b"]]);
    });

    it("consumes the LF of a CRLF row ending", () => {
        const { rows, error } = parseCsvRows("a\r\nb", CSV_OPTIONS_DEFAULT);
        expect(error).toBeNull();
        expect(rows).toEqual([["a"], ["b"]]);
    });
});

describe("parseCsvRows escape handling (comments options)", () => {
    it.each([
        ["ordinary ASCII inside quotes", String.raw`"a\b"`, [["ab"]]],
        ["a quote inside quotes", String.raw`"a\"b"`, [['a"b']]],
        ["a doubled backslash", String.raw`"a\\b"`, [["a\\b"]]],
        ["adjacent doubled backslashes", String.raw`"a\\\\b"`, [["a\\\\b"]]],
        ["backslashes next to a closing quote", String.raw`"a\\"`, [["a\\"]]],
        ["non-ASCII characters", String.raw`"caf\é \📌"`, [["café 📌"]]],
        ["an unquoted delimiter", String.raw`a\,b,c`, [["a,b", "c"]]],
        ["an unquoted ordinary character", String.raw`a\bc`, [["abc"]]],
        ["an unquoted quote", String.raw`a\",b`, [['a"', "b"]]],
        ["an LF inside a quoted field", '"line\\\nbreak"', [["line\nbreak"]]],
        ["a CR inside a quoted field", '"line\\\rbreak"', [["line\rbreak"]]],
        ["an LF outside quotes", "line\\\nbreak", [["line\nbreak"]]],
        ["a CR outside quotes", "line\\\rbreak", [["line\rbreak"]]],
    ])("consumes the escape before %s", (_name, csv, expectedRows) => {
        const { rows, error } = parseCsvRows(csv, CSV_OPTIONS_COMMENTS);
        expect(error).toBeNull();
        expect(rows).toEqual(expectedRows);
    });

    it.each(["a\\", '"a\\'])("rejects a trailing escape in %j", (csv) => {
        const { rows, error } = parseCsvRows(csv, CSV_OPTIONS_COMMENTS);
        expect(rows).toEqual([]);
        expect(error).toBe("CSV parsing error: trailing escape character.");
    });

    it("counts an escape pair as its decoded field content", () => {
        const atLimitMinusOne = "x".repeat(199999);
        const accepted = parseCsvRows(`${atLimitMinusOne}\\,`, CSV_OPTIONS_COMMENTS);
        expect(accepted.error).toBeNull();
        expect(accepted.rows).toEqual([[`${atLimitMinusOne},`]]);

        const atLimit = "x".repeat(200000);
        const rejected = parseCsvRows(`${atLimit}\\,`, CSV_OPTIONS_COMMENTS);
        expect(rejected.rows).toEqual([]);
        expect(rejected.error).toMatch(/too large/i);
    });

    it("does not consume backslashes when escape is null", () => {
        const { rows, error } = parseCsvRows(String.raw`a\b`, CSV_OPTIONS_DEFAULT);
        expect(error).toBeNull();
        expect(rows).toEqual([[String.raw`a\b`]]);
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
