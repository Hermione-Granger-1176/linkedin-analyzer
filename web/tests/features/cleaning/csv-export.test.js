import { describe, expect, it } from "vitest";

import {
    buildCleanedCsvBlob,
    cleanedCsvName,
    toCsvField,
} from "../../../src/features/cleaning/csv-export.js";

describe("csv-export", () => {
    it("quotes only fields that need it and doubles inner quotes", () => {
        expect(toCsvField("plain")).toBe("plain");
        expect(toCsvField("a,b")).toBe('"a,b"');
        expect(toCsvField('say "hi"')).toBe('"say ""hi"""');
        expect(toCsvField("line\nbreak")).toBe('"line\nbreak"');
        expect(toCsvField("carriage\rreturn")).toBe('"carriage\rreturn"');
        expect(toCsvField(null)).toBe("");
        expect(toCsvField(undefined)).toBe("");
        expect(toCsvField(42)).toBe("42");
    });

    it("writes a BOM, the configured headers, and one line per row", async () => {
        const blob = buildCleanedCsvBlob(
            [
                {
                    Date: "2026-01-02",
                    ShareLink: "https://example.com",
                    ShareCommentary: "Hi, all",
                },
                { Date: "2026-01-03" },
            ],
            "shares",
        );
        const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await blob.arrayBuffer());
        const lines = text.split("\r\n");

        expect(blob.type).toBe("text/csv;charset=utf-8");
        expect(text.startsWith("﻿")).toBe(true);
        expect(lines[0].replace("﻿", "")).toMatch(/^Date,/);
        expect(lines[1]).toContain('"Hi, all"');
        expect(lines[2].startsWith("2026-01-03")).toBe(true);
        expect(lines.at(-1)).toBe("");
    });

    it("splits large exports into several parts that join in order", async () => {
        const rows = Array.from({ length: 4500 }, (_, index) => ({ Date: `row-${index}` }));
        const text = new TextDecoder().decode(
            await buildCleanedCsvBlob(rows, "shares").arrayBuffer(),
        );
        const lines = text.split("\r\n");

        expect(lines).toHaveLength(4502);
        expect(lines[1].startsWith("row-0")).toBe(true);
        expect(lines[4500].startsWith("row-4499")).toBe(true);
    });

    it("names the CSV after the workbook and rejects unknown types", () => {
        expect(cleanedCsvName("messages")).toBe("Messages.csv");
        expect(() => cleanedCsvName("bogus")).toThrow(/Unknown file type/);
    });
});
