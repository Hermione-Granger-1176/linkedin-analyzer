import { describe, expect, it } from "vitest";

import { LinkedInCleaner } from "../src/cleaner.js";

describe("LinkedInCleaner", () => {
    it("auto-detects and cleans messages CSV", () => {
        const csv = [
            "CONVERSATION ID,FROM,TO,DATE,CONTENT,FOLDER,SENDER PROFILE URL,RECIPIENT PROFILE URLS",
            'abc,Ada,Bob,2025-01-01 10:00:00 UTC,"He said ""hello""",INBOX,https://linkedin.com/in/ada,https://linkedin.com/in/bob',
        ].join("\n");

        const result = LinkedInCleaner.process(csv, "auto");

        expect(result.success).toBe(true);
        expect(result.fileType).toBe("messages");
        expect(result.rowCount).toBe(1);
        expect(result.cleanedData[0].CONTENT).toBe('He said "hello"');
    });

    it("auto-detects and cleans connections CSV with preamble", () => {
        const csv = [
            "Notes:",
            "Export metadata",
            "",
            "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
            "Ada,Lovelace,https://linkedin.com/in/ada,,Analytical Engines,Mathematician,30 Jan 2026",
        ].join("\n");

        const result = LinkedInCleaner.process(csv, "auto");

        expect(result.success).toBe(true);
        expect(result.fileType).toBe("connections");
        expect(result.rowCount).toBe(1);
        expect(result.cleanedData[0]["Connected On"]).toBe("2026-01-30");
    });

    it("does not auto-detect connections when identity headers are missing", () => {
        const csv = ["Notes:", "Export metadata", "", "Connected On", "30 Jan 2026"].join("\n");

        const result = LinkedInCleaner.process(csv, "auto");

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/auto-detect/i);
    });

    it("rejects exact duplicate headers before building rows", () => {
        const csv = [
            "Date,ShareLink,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility",
            "2025-01-01,https://linkedin.com/one,https://linkedin.com/two,Hello,,,PUBLIC",
        ].join("\n");

        const result = LinkedInCleaner.process(csv, "shares");

        expect(result.success).toBe(false);
        expect(result.error).toBe("Duplicate columns after header normalization: ShareLink");
    });

    it("rejects duplicate headers after BOM and whitespace normalization", () => {
        const csv = [
            "\uFEFFDate, Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility",
            "2025-01-01,2025-01-02,https://linkedin.com/post,Hello,,,PUBLIC",
        ].join("\n");

        const result = LinkedInCleaner.process(csv, "shares");

        expect(result.success).toBe(false);
        expect(result.error).toBe("Duplicate columns after header normalization: Date");
    });

    it("rejects duplicate blank headers after normalization", () => {
        const csv = [
            "Date,, ,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility",
            "2025-01-01,one,two,https://linkedin.com/post,Hello,,,PUBLIC",
        ].join("\n");

        const result = LinkedInCleaner.parseCSV(csv, "shares");

        expect(result.error).toBe("Duplicate columns after header normalization: (blank)");
    });

    it("cleans connections long month names", () => {
        const csv = [
            "Notes:",
            "Export metadata",
            "",
            "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
            "Ada,Lovelace,https://linkedin.com/in/ada,,Analytical Engines,Mathematician,30 January 2026",
        ].join("\n");

        const result = LinkedInCleaner.process(csv, "connections");

        expect(result.success).toBe(true);
        expect(result.cleanedData[0]["Connected On"]).toBe("2026-01-30");
    });

    it("cleans connections month names case-insensitively", () => {
        const csv = [
            "Notes:",
            "Export metadata",
            "",
            "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
            "Ada,Lovelace,https://linkedin.com/in/ada,,Analytical Engines,Mathematician,30 JAN 2026",
        ].join("\n");

        const result = LinkedInCleaner.process(csv, "connections");

        expect(result.success).toBe(true);
        expect(result.cleanedData[0]["Connected On"]).toBe("2026-01-30");
    });

    it("drops messages rows missing required values", () => {
        const csv = [
            "CONVERSATION ID,FROM,TO,DATE,CONTENT,FOLDER,SENDER PROFILE URL,RECIPIENT PROFILE URLS",
            'abc,Ada,Bob,2025-01-01 10:00:00 UTC,"Valid message",INBOX,https://linkedin.com/in/ada,https://linkedin.com/in/bob',
            "def,Ada,Bob,2025-01-01 11:00:00 UTC,,INBOX,https://linkedin.com/in/ada,https://linkedin.com/in/bob",
            'ghi,#N/A,Bob,2025-01-01 12:00:00 UTC,"Ignored row",INBOX,https://linkedin.com/in/ada,https://linkedin.com/in/bob',
        ].join("\n");

        const result = LinkedInCleaner.process(csv, "messages");

        expect(result.success).toBe(true);
        expect(result.rowCount).toBe(1);
        expect(result.cleanedData[0].CONTENT).toBe("Valid message");
    });

    it("drops connections rows when all identity fields are missing", () => {
        const csv = [
            "Notes:",
            "Export metadata",
            "",
            "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
            ",,,,,,30 Jan 2026",
            ",,https://linkedin.com/in/ada,,Analytical Engines,Mathematician,30 Jan 2026",
        ].join("\n");

        const result = LinkedInCleaner.process(csv, "connections");

        expect(result.success).toBe(true);
        expect(result.rowCount).toBe(1);
        expect(result.cleanedData[0].URL).toBe("https://linkedin.com/in/ada");
    });

    // ── buildColumnErrorMessage paths ─────────────────────────────────────────

    it("returns type-mismatch error when wrong file type selected", () => {
        // Upload a shares CSV but tell the cleaner it's comments.
        // Shares have Date/ShareLink/ShareCommentary; Comments require Date/Link/Message.
        // detectFileType will identify the headers as 'shares', which != 'comments',
        // so buildColumnErrorMessage fires the "This looks like a X file" branch.
        const csv = [
            "Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility",
            "2025-01-01 10:00:00,https://linkedin.com/in/post,Hello world,,,MEMBER_NETWORK",
        ].join("\n");

        const result = LinkedInCleaner.process(csv, "comments");

        expect(result.success).toBe(false);
        // The error must mention that it looks like a Shares file and Comments was chosen
        expect(result.error).toMatch(/Shares/i);
        expect(result.error).toMatch(/Comments/i);
    });

    it("cleanConnectionsDate returns raw value when date does not match expected format", () => {
        // A connections CSV where Connected On doesn't match "DD Mon YYYY" format
        const csv = [
            "Notes:",
            "",
            "",
            "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
            "Ada,Lovelace,https://linkedin.com/in/ada,,Analytical Engines,Mathematician,2026-01-30",
        ].join("\n");

        const result = LinkedInCleaner.process(csv, "connections");

        expect(result.success).toBe(true);
        // Date doesn't match "DD Mon YYYY" so it's returned as-is
        expect(result.cleanedData[0]["Connected On"]).toBe("2026-01-30");
    });

    it("processes connections where Connected On field has unusual date format", () => {
        // A connections CSV where Connected On has an iso-format date (not matching "DD Mon YYYY")
        // but the URL and name are present so row is not dropped
        const csv = [
            "Notes:",
            "",
            "",
            "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
            "Ada,Lovelace,https://linkedin.com/in/ada,,Analytical Engines,Mathematician,1/30/2026",
        ].join("\n");

        const result = LinkedInCleaner.process(csv, "connections");

        // Process should succeed; date is returned as-is if format doesn't match
        expect(result.success).toBe(true);
    });

    it('returns "does not appear to be" error when selected type has no matching headers', () => {
        // A CSV with completely unknown columns, selectedType != 'auto',
        // detectFileType returns null (no known type matches), so the error branch fires
        const csv = ["Unknown,Column,Headers", "a,b,c"].join("\n");

        const result = LinkedInCleaner.process(csv, "shares");

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/doesn't appear to be/i);
    });

    // ── process() auto-detect failure paths ──────────────────

    it("returns failure with headers when auto-detect finds no match", () => {
        // A well-formed CSV with unknown column names so no file type matches
        const csv = ["Foo,Bar,Baz", "1,2,3", "4,5,6"].join("\n");

        const result = LinkedInCleaner.process(csv, "auto");

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/auto-detect/i);
        // Headers and row count should still be populated
        expect(result.headers.length).toBeGreaterThan(0);
        expect(result.rowCount).toBe(2);
    });

    it("skips file types whose prefix fails to parse during auto-detect", () => {
        // Over 64KB so auto-detect takes the prefix fast-path. The single row has
        // far more columns than the parser allows, so every candidate type's
        // prefix parse errors (the quote-retry cannot fix it) and detection walks
        // past each error before falling through to full multi-type detection.
        const result = LinkedInCleaner.process(",".repeat(64 * 1024 + 100), "auto");

        expect(result.success).toBe(false);
        expect(result.error).toBeTruthy();
    });

    describe("parseCSV without a shared cache", () => {
        it("reports an empty document", () => {
            const result = LinkedInCleaner.parseCSV("", "shares");
            expect(result.error).toBeTruthy();
            expect(result.data).toEqual([]);
        });

        it("reports a document that trims down to no rows", () => {
            const result = LinkedInCleaner.parseCSV(",,,\n,,", "shares");
            expect(result.error).toBeTruthy();
            expect(result.data).toEqual([]);
        });

        it("propagates an unrecoverable parser error", () => {
            const result = LinkedInCleaner.parseCSV(",".repeat(300), "shares");
            expect(result.error).toMatch(/too many columns/i);
            expect(result.data).toEqual([]);
        });

        it("reports when nothing remains after the configured skipRows", () => {
            // The connections config skips 3 leading rows; with only three rows of
            // input there is no header row left to read.
            const result = LinkedInCleaner.parseCSV("a\nb\nc", "connections");
            expect(result.error).toMatch(/skip/i);
            expect(result.data).toEqual([]);
        });
    });

    // ── cleanSharesCommentary paths ──────────────────────────

    it("cleans shares commentary that starts and ends with quotes", () => {
        // A shares CSV where ShareCommentary starts with " and ends with "
        const csv = [
            "Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility",
            '2025-01-01 10:00:00 UTC,https://linkedin.com/in/post,"My post""text",,,MEMBER_NETWORK',
        ].join("\n");

        const result = LinkedInCleaner.process(csv, "shares");
        expect(result.success).toBe(true);
        expect(result.rowCount).toBe(1);
    });

    it("cleanDate returns raw value when date has no time component", () => {
        // Date without time, falls through to partial parse return
        const csv = [
            "Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility",
            "2025-01-01,https://linkedin.com/in/post,Hello,,,MEMBER_NETWORK",
        ].join("\n");
        const result = LinkedInCleaner.process(csv, "shares");
        expect(result.success).toBe(true);
    });

    it("cleanDate handles NaN date components gracefully", () => {
        // A date with non-numeric parts
        const csv = [
            "Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility",
            "NOT-A-DATE 00:00:00,https://linkedin.com/in/post,Hello,,,MEMBER_NETWORK",
        ].join("\n");
        const result = LinkedInCleaner.process(csv, "shares");
        expect(result.success).toBe(true);
        // The date should be returned as-is (not cleaned)
        expect(result.cleanedData[0].Date).toContain("NOT-A-DATE");
    });

    it("cleanDate handles out-of-range date components", () => {
        // Hour=25 is out of range
        const csv = [
            "Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility",
            "2025-01-01 25:00:00,https://linkedin.com/in/post,Hello,,,MEMBER_NETWORK",
        ].join("\n");
        const result = LinkedInCleaner.process(csv, "shares");
        expect(result.success).toBe(true);
    });

    // ── Empty CSV edge cases ──────────────────────────────────

    it("returns empty-CSV error when CSV has no rows", () => {
        const result = LinkedInCleaner.process("", "shares");
        expect(result.success).toBe(false);
        expect(result.error).toBeTruthy();
    });

    it("returns error when CSV headers are all empty", () => {
        // A CSV with a header row that is entirely commas (empty columns)
        const csv = ",,,\n1,2,3,4";
        const result = LinkedInCleaner.process(csv, "shares");
        expect(result.success).toBe(false);
    });

    // ── Date parsing edge cases in cleanDate ────────────────────────────────

    it("returns raw value when date format has no time part", () => {
        // A date without a time component, cleanDate should return as-is
        const csv = [
            "Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility",
            "2025-01-01,https://linkedin.com/in/post,Hello world,,,MEMBER_NETWORK",
        ].join("\n");
        const result = LinkedInCleaner.process(csv, "shares");
        // Should still succeed (returns the raw date string as-is)
        expect(result.success).toBe(true);
    });

    it("returns raw value when date components are out of range", () => {
        // Month=13 → invalid range → cleanDate returns as-is
        const csv = [
            "Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility",
            "2025-13-01 10:00:00 UTC,https://linkedin.com,Hello,,,MEMBER_NETWORK",
        ].join("\n");
        const result = LinkedInCleaner.process(csv, "shares");
        expect(result.success).toBe(true);
    });

    // ── validateColumns with unknown file type ────────────────────

    it("validateColumns returns invalid for unknown file type", () => {
        // Process with an unsupported file type → config lookup fails → buildColumnErrorMessage fires
        const csv = [
            "Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility",
            "2025-01-01 10:00:00,https://linkedin.com,Hello,,,MEMBER_NETWORK",
        ].join("\n");
        // 'events' is not a known type
        const result = LinkedInCleaner.process(csv, "events");
        expect(result.success).toBe(false);
    });

    // ── CRLF inside quoted field ───────────────────────────────────

    it("handles bare \\r (without \\n) inside a quoted CSV field", () => {
        // A quoted field with \r NOT followed by \n, triggers the `else` branch in
        // CSV_PARSE_STATE.INSIDE_QUOTES case '\r'
        const csv =
            'CONVERSATION ID,FROM,TO,DATE,CONTENT,FOLDER,SENDER PROFILE URL,RECIPIENT PROFILE URLS\r\nabc,Ada,Bob,2025-01-01 10:00:00 UTC,"Line1\rLine2",INBOX,https://linkedin.com/in/ada,https://linkedin.com/in/bob';

        const result = LinkedInCleaner.process(csv, "messages");

        expect(result.success).toBe(true);
        expect(result.rowCount).toBe(1);
        // The bare \r is preserved inside the quoted field
        expect(result.cleanedData[0].CONTENT).toContain("Line1");
    });

    it("returns parser error when a row exceeds max column count", () => {
        const headers = Array.from({ length: 260 }, (_, index) => `C${index}`).join(",");
        const row = Array.from({ length: 260 }, (_, index) => String(index)).join(",");
        const csv = `${headers}\n${row}`;

        const result = LinkedInCleaner.process(csv, "auto");

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/too many columns/i);
    });

    it("returns empty-data parser error for CSV containing only blank lines", () => {
        const result = LinkedInCleaner.process("\n\n\n", "auto");

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/empty/i);
    });

    it("rejects an unmatched final quote", () => {
        const csv = [
            "Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility",
            '2025-01-01 10:00:00 UTC,https://linkedin.com/in/post,"Unclosed commentary,,,MEMBER_NETWORK',
        ].join("\n");

        const result = LinkedInCleaner.process(csv, "shares");

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/unmatched quote/i);
    });

    it("surfaces alternate detected type when selected type cannot be inferred directly", () => {
        const csv = [
            "Notes:",
            "Export metadata",
            "",
            "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
            "Ada,Lovelace,https://linkedin.com/in/ada,,Analytical Engines,Mathematician,30 Jan 2026",
        ].join("\n");

        const result = LinkedInCleaner.process(csv, "shares");

        expect(result.success).toBe(false);
        expect(result.detectedType).toBe("connections");
        expect(result.error).toMatch(/Connections/i);
    });

    it("cleans shares rows when date/commentary cells are missing", () => {
        const csv = [
            "Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility",
            ",https://linkedin.com/in/post,,,,MEMBER_NETWORK",
        ].join("\n");

        const result = LinkedInCleaner.process(csv, "shares");

        expect(result.success).toBe(true);
        expect(result.rowCount).toBe(0);
    });

    it("cleans comments escaped quotes and preserves content", () => {
        const csv = [
            "Date,Link,Message",
            '2025-01-01 10:00:00 UTC,https://linkedin.com/posts/1,"hello""world"',
        ].join("\n");

        const result = LinkedInCleaner.process(csv, "comments");

        expect(result.success).toBe(true);
        expect(result.rowCount).toBe(1);
    });

    it("returns connection date as-is for unknown month token", () => {
        const csv = [
            "Notes:",
            "",
            "",
            "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
            "Ada,Lovelace,https://linkedin.com/in/ada,,Analytical Engines,Mathematician,30 FOO 2026",
        ].join("\n");

        const result = LinkedInCleaner.process(csv, "connections");

        expect(result.success).toBe(true);
        expect(result.cleanedData[0]["Connected On"]).toBe("30 FOO 2026");
    });

    it.each([
        ["30 Feb 2026", "30 Feb 2026"],
        ["29 Feb 2025", "29 Feb 2025"],
        ["29 Feb 2024", "2024-02-29"],
        ["30 Jank 2026", "30 Jank 2026"],
    ])("preserves invalid connection date %s and converts valid dates", (input, expected) => {
        const csv = [
            "Notes:",
            "",
            "",
            "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
            `Ada,Lovelace,https://linkedin.com/in/ada,,Analytical Engines,Mathematician,${input}`,
        ].join("\n");

        const result = LinkedInCleaner.process(csv, "connections");

        expect(result.success).toBe(true);
        expect(result.cleanedData[0]["Connected On"]).toBe(expected);
    });

    it("returns empty-data parser error when parsed rows collapse to empty", () => {
        const result = LinkedInCleaner.process(",,,\n,,", "shares");

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/empty/i);
    });

    it("escapes formula injection prefix + in Visibility column", () => {
        const csv = [
            "Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility",
            "2025-01-01 10:00:00 UTC,https://linkedin.com/in/post,Hello,,,+cmd",
        ].join("\n");
        const result = LinkedInCleaner.process(csv, "shares");
        expect(result.success).toBe(true);
        expect(result.cleanedData[0].Visibility).toBe("'+cmd");
    });

    it("escapes formula injection prefix - in Visibility column", () => {
        const csv = [
            "Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility",
            "2025-01-01 10:00:00 UTC,https://linkedin.com/in/post,Hello,,,-cmd",
        ].join("\n");
        const result = LinkedInCleaner.process(csv, "shares");
        expect(result.success).toBe(true);
        expect(result.cleanedData[0].Visibility).toBe("'-cmd");
    });

    it("escapes formula injection prefix @ in Visibility column", () => {
        const csv = [
            "Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility",
            "2025-01-01 10:00:00 UTC,https://linkedin.com/in/post,Hello,,,@SUM(A1)",
        ].join("\n");
        const result = LinkedInCleaner.process(csv, "shares");
        expect(result.success).toBe(true);
        expect(result.cleanedData[0].Visibility).toBe("'@SUM(A1)");
    });

    it.each([
        {
            type: "shares",
            csv: [
                "Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility",
                "2025-01-01 10:00:00 UTC,https://linkedin.com/in/post,=SUM(1),,,MEMBER_NETWORK",
            ].join("\n"),
            column: "ShareCommentary",
        },
        {
            type: "comments",
            csv: [
                "Date,Link,Message",
                "2025-01-01 10:00:00 UTC,https://linkedin.com/posts/1,=SUM(1)",
            ].join("\n"),
            column: "Message",
        },
        {
            type: "messages",
            csv: [
                "FROM,TO,DATE,CONTENT",
                "Ada,Bob,2025-01-01 10:00:00 UTC,=SUM(1)",
            ].join("\n"),
            column: "CONTENT",
        },
        {
            type: "connections",
            csv: [
                "Notes:",
                "",
                "",
                "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
                "Ada,Lovelace,=SUM(1),,,,30 Jan 2026",
            ].join("\n"),
            column: "URL",
        },
    ])("escapes formula prefixes after $type-specific cleaning", ({ type, csv, column }) => {
        const result = LinkedInCleaner.process(csv, type);

        expect(result.success).toBe(true);
        expect(result.cleanedData[0][column]).toBe("'=SUM(1)");
    });

    it("keeps mid-field quotes literal in unquoted fields", () => {
        const csv = [
            "Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility",
            '2025-01-01 10:00:00 UTC,https://linkedin.com/in/post,say ""hi"" or "bye,,,MEMBER_NETWORK',
        ].join("\n");

        const result = LinkedInCleaner.process(csv, "shares");

        expect(result.success).toBe(true);
        expect(result.cleanedData[0].ShareCommentary).toBe('say "hi" or "bye');
    });

    it("returns parser error when a quoted field exceeds the safety limit", () => {
        const veryLargeField = "x".repeat(200001);
        const csv = [
            "Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility",
            `2025-01-01 10:00:00 UTC,https://linkedin.com/in/post,"${veryLargeField}",,,MEMBER_NETWORK`,
        ].join("\n");

        const result = LinkedInCleaner.process(csv, "shares");

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/too large/i);
    });

    it("returns parser error when an unquoted field exceeds the safety limit", () => {
        const veryLargeField = "x".repeat(200001);
        const csv = [
            "Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility",
            `2025-01-01 10:00:00 UTC,https://linkedin.com/in/post,${veryLargeField},,,MEMBER_NETWORK`,
        ].join("\n");

        const result = LinkedInCleaner.process(csv, "shares");

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/too large/i);
    });

    it("builds rows with a null prototype so malicious headers cannot pollute", () => {
        const csv = ["toString,__proto__", "a,b"].join("\n");

        const result = LinkedInCleaner.parseCSV(csv, "auto");
        const row = result.data[0];

        expect(result.error).toBeNull();
        expect(Object.getPrototypeOf(row)).toBeNull();
        // Header keys become plain own properties instead of mutating the chain.
        expect(row.toString).toBe("a");
        expect(Object.prototype.hasOwnProperty.call(row, "__proto__")).toBe(true);
        expect(row.__proto__).toBe("b");
    });

    it("preserves embedded CRLF newlines inside quoted fields", () => {
        const csv = [
            "Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility",
            '2025-01-01 10:00:00 UTC,https://linkedin.com/in/post,"line one\r\nline two",,,MEMBER_NETWORK',
        ].join("\n");

        const result = LinkedInCleaner.process(csv, "shares");

        expect(result.success).toBe(true);
        expect(result.cleanedData[0].ShareCommentary).toBe("line one\nline two");
    });

    // ── process() auto-detect prefix pre-pass (large files) ──────────────────
    describe("auto-detect prefix pre-pass", () => {
        const SHARES_HEADER = "Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility";

        /**
         * Build a shares CSV with enough rows to exceed the 64KB prefix
         * threshold so process("auto") takes the prefix pre-pass fast path.
         * @param {number} rows - Number of data rows to generate
         * @returns {string}
         */
        function buildLargeSharesCsv(rows) {
            const lines = [SHARES_HEADER];
            for (let i = 0; i < rows; i += 1) {
                lines.push(
                    `2025-01-01 10:00:00 UTC,https://linkedin.com/in/post${i},Commentary number ${i} with padding text,,,MEMBER_NETWORK`,
                );
            }
            return lines.join("\n");
        }

        it("detects a large file from its header prefix without full multi-type parsing", () => {
            const csv = buildLargeSharesCsv(1200);
            expect(csv.length).toBeGreaterThan(64 * 1024);

            const result = LinkedInCleaner.process(csv, "auto");

            expect(result.success).toBe(true);
            expect(result.fileType).toBe("shares");
            expect(result.detectedType).toBe("shares");
            expect(result.rowCount).toBe(1200);
        });

        it("falls back to full detection when the prefix matches no known type", () => {
            const lines = ["Alpha,Beta,Gamma"];
            for (let i = 0; i < 1500; i += 1) {
                lines.push(`value-${i},other-${i},extra-${i} with some padding text here`);
            }
            const csv = lines.join("\n");
            expect(csv.length).toBeGreaterThan(64 * 1024);

            const result = LinkedInCleaner.process(csv, "auto");

            expect(result.success).toBe(false);
            expect(result.error).toMatch(/auto-detect/i);
        });

        it("falls back when the prefix matches but the full file fails to parse", () => {
            // The prefix (first 64KB) is clean shares rows, so it detects shares;
            // a giant field placed past the prefix makes the full parse error, so
            // the fast path is abandoned for full detection (which also errors).
            const csv = `${buildLargeSharesCsv(1200)}\n2025-01-01 10:00:00 UTC,https://linkedin.com/in/post,"${"x".repeat(200001)}",,,MEMBER_NETWORK`;
            expect(csv.indexOf("x".repeat(200001))).toBeGreaterThan(64 * 1024);

            const result = LinkedInCleaner.process(csv, "auto");

            expect(result.success).toBe(false);
            expect(result.error).toMatch(/too large/i);
        });
    });
});
