import { describe, expect, it } from "vitest";

import { parseMessagesForExport } from "../../../src/features/export/messages-parse.js";

const HEADER =
    "CONVERSATION ID,FROM,TO,DATE,CONTENT,FOLDER,SENDER PROFILE URL,RECIPIENT PROFILE URLS";

/**
 * Build a one-row messages CSV around the given content cell.
 * @param {string} content - CONTENT cell, already CSV-quoted if it needs to be
 * @returns {string} CSV text
 */
function csvWithContent(content) {
    return [
        HEADER,
        `c1, Sam Self ,Ada,2025-01-01 10:00:00 UTC,${content},INBOX,https://linkedin.com/in/sam,https://linkedin.com/in/ada`,
    ].join("\n");
}

describe("parseMessagesForExport", () => {
    it("leaves formula-prefixed bodies exactly as they were written", () => {
        for (const body of ["=SUM(A1)", "+1 from me", "-5 minutes late", "@Ada ping"]) {
            const { rows } = parseMessagesForExport(csvWithContent(`"${body}"`));
            expect(rows[0].CONTENT).toBe(body);
        }
    });

    it("keeps leading and trailing whitespace inside a body", () => {
        const { rows } = parseMessagesForExport(csvWithContent('"\tone\ntwo  "'));

        expect(rows[0].CONTENT).toBe("\tone\ntwo  ");
    });

    it("keeps control characters a worksheet would have stripped", () => {
        const body = "bell\u0007end";
        const { rows } = parseMessagesForExport(csvWithContent(`"${body}"`));

        expect(rows[0].CONTENT).toBe(body);
    });

    it("still unescapes the quoting the CSV format itself adds", () => {
        const { rows } = parseMessagesForExport(csvWithContent('"she said ""yes"""'));

        expect(rows[0].CONTENT).toBe('she said "yes"');
    });

    it("still normalizes dates, names and URLs", () => {
        const { rows } = parseMessagesForExport(csvWithContent('"hi"'));

        expect(rows[0].FROM).toBe("Sam Self");
        expect(rows[0].DATE).toBe("2025-01-01 10:00:00");
        expect(rows[0]["SENDER PROFILE URL"]).toBe("https://linkedin.com/in/sam");
        expect(rows[0]["CONVERSATION ID"]).toBe("c1");
    });

    it("drops rows with no message body, as the workbook path does", () => {
        const { success, rows } = parseMessagesForExport(
            [
                HEADER,
                'c1,Sam Self,Ada,2025-01-01 10:00:00 UTC,"kept",INBOX,,',
                "c1,Sam Self,Ada,2025-01-02 10:00:00 UTC,,INBOX,,",
            ].join("\n"),
        );

        expect(success).toBe(true);
        expect(rows.map((row) => row.CONTENT)).toEqual(["kept"]);
    });

    it("reports a CSV that is not a messages export", () => {
        const result = parseMessagesForExport("First Name,Last Name\nAda,Lovelace");

        expect(result.success).toBe(false);
        expect(result.rows).toEqual([]);
        expect(result.error).toContain("missing required Messages columns");
    });

    it("reports an unparseable CSV", () => {
        const result = parseMessagesForExport("");

        expect(result.success).toBe(false);
        expect(result.error).toBeTruthy();
    });
});
