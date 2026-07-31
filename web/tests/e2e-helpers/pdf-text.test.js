/**
 * Unit tests for the e2e helper that reads text back out of a generated PDF.
 *
 * The helper is what four privacy assertions in `pdf-export.e2e.spec.js` rest
 * on: they check that the exported file does *not* contain a spreadsheet-cleaned
 * body. A helper that silently returned "" would satisfy every one of those
 * `not.toContain` assertions while proving nothing, so its own behaviour needs a
 * test that fails loudly instead.
 */

import zlib from "node:zlib";

import { describe, expect, it } from "vitest";

import pdfText from "../../e2e/helpers/pdf-text.js";

const { extractPdfText } = pdfText;

/**
 * Wrap content in the stream framing the helper scans for.
 * @param {string|Buffer} content - Stream body
 * @returns {Buffer} A PDF-shaped buffer
 */
function pdfWithStream(content) {
    const body = Buffer.isBuffer(content) ? content : Buffer.from(content, "latin1");
    return Buffer.concat([
        Buffer.from("%PDF-1.3\nstream\n", "latin1"),
        body,
        Buffer.from("\nendstream\n%%EOF", "latin1"),
    ]);
}

describe("extractPdfText", () => {
    it("reads the strings an uncompressed content stream draws", () => {
        const pdf = pdfWithStream("BT (Hello) Tj (Bob) Tj ET");

        expect(extractPdfText(pdf)).toBe("Hello\nBob");
    });

    it("reads the strings a deflated content stream draws", () => {
        // The export asks jsPDF for compression, so this is the real shape.
        const pdf = pdfWithStream(zlib.deflateSync(Buffer.from("(Ada Lovelace) Tj", "latin1")));

        expect(extractPdfText(pdf)).toBe("Ada Lovelace");
    });

    it("decodes the escapes a PDF literal uses", () => {
        const pdf = pdfWithStream(String.raw`(one\ntwo\tthree\101) Tj (a\)b) Tj`);

        expect(extractPdfText(pdf)).toBe("one\ntwo\tthreeA\na)b");
    });

    it("keeps a formula-prefixed body readable rather than dropping it", () => {
        // The negative assertions in the e2e spec are only meaningful if a body
        // that IS present comes back: this is the positive control for them.
        // Parentheses inside a literal are escaped, as any PDF writer emits them.
        const pdf = pdfWithStream(String.raw`(=SUM\(A1\) stays) Tj`);

        expect(extractPdfText(pdf)).toContain("=SUM(A1) stays");
    });

    it("returns nothing when there is no stream to read", () => {
        expect(extractPdfText(Buffer.from("%PDF-1.3\n%%EOF", "latin1"))).toBe("");
    });
});
