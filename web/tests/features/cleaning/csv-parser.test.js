import { describe, expect, it, vi } from "vitest";

import {
    CSV_OPTIONS_COMMENTS,
    CSV_OPTIONS_DEFAULT,
    createCsvRowParser,
    isRowEmpty,
    parseCsvRows,
} from "../../../src/features/cleaning/csv-parser.js";
import { MAX_CSV_CHARS } from "../../../src/shared/limits.js";

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

/**
 * Feed chunks through the incremental parser and collect what it emits.
 * @param {string[]} chunks - Text chunks in order
 * @param {{delimiter: string, quote: string, escape: string|null}} [options] - Parser options
 */
function parseChunks(chunks, options = CSV_OPTIONS_DEFAULT) {
    const rows = [];
    const parser = createCsvRowParser(options, (row) => rows.push(row));
    for (const chunk of chunks) {
        parser.push(chunk);
    }
    return { rows, error: parser.finish() };
}

describe("createCsvRowParser across chunk boundaries", () => {
    const cases = [
        ["default", CSV_OPTIONS_DEFAULT, 'a,"b\r\nc",d\r\n"x""y",z\n\n,\nlast\r'],
        ["default with emoji", CSV_OPTIONS_DEFAULT, 'name,note\n"😀 hi","a""😀"\r\n😀,b\n'],
        ["comments", CSV_OPTIONS_COMMENTS, `${String.raw`a,"q\"u\😀o",\,b`}\r\nc,d`],
    ];

    it.each(cases)(
        "matches the whole-text parse at every split point (%s)",
        (_name, options, text) => {
            const whole = parseCsvRows(text, options);
            expect(whole.error).toBeNull();
            for (let split = 1; split < text.length; split += 1) {
                expect(parseChunks([text.slice(0, split), text.slice(split)], options)).toEqual(
                    whole,
                );
            }
            expect(parseChunks([...text.split("")], options)).toEqual(whole);
        },
    );

    it.each([
        ["a quoted newline", ['"a\n', 'b",c'], [["a\nb", "c"]]],
        ["a doubled quote split between its quotes", ['"a"', '"b"'], [['a"b']]],
        ["a closing quote at the chunk end", ['"a"', ",b"], [["a", "b"]]],
        ["a CRLF inside quotes", ['"a\r', '\nb"'], [["a\nb"]]],
        ["a bare CR inside quotes", ['"a\r', 'b"'], [["a\rb"]]],
        ["a CRLF row ending", ["a\r", "\nb"], [["a"], ["b"]]],
        ["a bare CR row ending", ["a\r", "b"], [["a"], ["b"]]],
        ["a surrogate pair in plain text", ["a\ud83d", "\ude00b"], [["a😀b"]]],
    ])("joins %s", (_name, chunks, expected) => {
        expect(parseChunks(chunks)).toEqual({ rows: expected, error: null });
    });

    it.each([
        ["an escape at the chunk end", ['"a\\', '"b"'], [['a"b']]],
        ["an escaped surrogate pair split after its high half", ["\\\ud83d", "\ude00"], [["😀"]]],
    ])("joins %s (comments options)", (_name, chunks, expected) => {
        expect(parseChunks(chunks, CSV_OPTIONS_COMMENTS)).toEqual({ rows: expected, error: null });
    });
});

describe("createCsvRowParser row emission", () => {
    it("emits held empty rows once a non-empty row follows and drops trailing ones", () => {
        expect(parseChunks(["a\n\n", ",\nb\n", "\n,\n"])).toEqual({
            rows: [["a"], [""], ["", ""], ["b"]],
            error: null,
        });
    });

    it("emits complete rows before finish", () => {
        const rows = [];
        const parser = createCsvRowParser(CSV_OPTIONS_DEFAULT, (row) => rows.push(row));
        expect(parser.push("a,b\nc")).toBeNull();
        expect(rows).toEqual([["a", "b"]]);
        expect(parser.finish()).toBeNull();
        expect(rows).toEqual([["a", "b"], ["c"]]);
    });

    it("keeps the rows and reports an unmatched quote at finish", () => {
        expect(parseChunks(["a\n", '"b'])).toEqual({
            rows: [["a"], ["b"]],
            error: "CSV parsing error: unmatched quote",
        });
    });

    it("reports a trailing escape at finish", () => {
        expect(parseChunks(["a\\"], CSV_OPTIONS_COMMENTS).error).toBe(
            "CSV parsing error: trailing escape character.",
        );
    });
});

describe("createCsvRowParser errors and lifecycle", () => {
    it("enforces the character limit as a running count", () => {
        const parser = createCsvRowParser(CSV_OPTIONS_DEFAULT, () => {});
        expect(parser.push("a")).toBeNull();
        // A length-bearing object trips the guard before any concatenation.
        expect(
            parser.push(/** @type {string} */ (/** @type {unknown} */ ({ length: MAX_CSV_CHARS }))),
        ).toMatch(/parser limit/);
        expect(parser.finish()).toMatch(/parser limit/);
    });

    it("ignores chunks after an error and after finish", () => {
        const rows = [];
        const parser = createCsvRowParser(CSV_OPTIONS_DEFAULT, (row) => rows.push(row));
        const tooLong = `"${"x".repeat(200001)}`;
        expect(parser.push(tooLong)).toMatch(/too large/);
        expect(parser.push("a\n")).toMatch(/too large/);
        expect(rows).toEqual([]);

        const done = createCsvRowParser(CSV_OPTIONS_DEFAULT, (row) => rows.push(row));
        expect(done.push("")).toBeNull();
        expect(done.finish()).toBeNull();
        expect(done.push("late\n")).toBeNull();
        expect(done.finish()).toBeNull();
        expect(rows).toEqual([]);
    });
});

describe("createCsvRowParser column limit at a row ending", () => {
    it.each([
        ["LF", "\n"],
        ["CR", "\r"],
    ])("reports too many columns when a %s ends the row", (_name, ending) => {
        const text = `${",".repeat(256)}${ending}next`;
        expect(parseChunks([text])).toEqual({
            rows: [],
            error: "CSV parsing error: too many columns in a row.",
        });
    });
});

describe("createCsvRowParser row limit", () => {
    it("counts every row, empty ones included, toward the row limit", async () => {
        vi.resetModules();
        vi.doMock("../../../src/shared/limits.js", async (importOriginal) => ({
            ...(await importOriginal()),
            MAX_CSV_ROWS: 2,
        }));
        const limited = await import("../../../src/features/cleaning/csv-parser.js");
        expect(limited.parseCsvRows("a\nb").error).toBeNull();
        expect(limited.parseCsvRows("a\n\nb")).toEqual({
            rows: [],
            error: "CSV parsing error: row limit exceeded for this file.",
        });
        vi.doUnmock("../../../src/shared/limits.js");
        vi.resetModules();
    });
});
