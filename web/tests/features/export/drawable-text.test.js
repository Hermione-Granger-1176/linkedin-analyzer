import { describe, expect, it } from "vitest";

import { sanitizeModel, sanitizeText } from "../../../src/features/export/drawable-text.js";

/**
 * Build the coverage a Latin face reports: printable ASCII and Latin-1.
 *
 * The shape both shipped faces have, so a test here reads the way the real
 * document does without depending on the font files themselves.
 * @returns {Set<number>} Code points
 */
function latinCoverage() {
    const coverage = new Set();
    for (let code = 0x20; code <= 0x7e; code += 1) {
        coverage.add(code);
    }
    for (let code = 0xa0; code <= 0xff; code += 1) {
        coverage.add(code);
    }
    return coverage;
}

const COVERAGE = latinCoverage();

describe("sanitizeText", () => {
    it("leaves text the fonts can draw exactly as it came", () => {
        const name = "Björn Fernández-Hall (Müller & Co.)";

        expect(sanitizeText(name, COVERAGE)).toBe(name);
    });

    it("marks a dropped character instead of losing it", () => {
        // jsPDF omits what the face has no glyph for, so this name reached the
        // page as "uo319 Smith" with nothing to say it had been damaged.
        expect(sanitizeText("Ňuňo319 Smith", COVERAGE)).toBe("?u?o319 Smith");
    });

    it("collapses a run of dropped characters into one mark", () => {
        // One mark per name reads as a name that could not be printed; one per
        // character reads as a row of marks.
        expect(sanitizeText("田中 Fernández-Hall", COVERAGE)).toBe("? Fernández-Hall");
        expect(sanitizeText("Ňuňo596 陈", COVERAGE)).toBe("?u?o596 ?");
    });

    it("marks a character from beyond the basic plane once", () => {
        // A surrogate pair is one character, not two.
        expect(sanitizeText("Nice work 🎉", COVERAGE)).toBe("Nice work ?");
    });

    it("keeps an accent that arrived decomposed", () => {
        // "a" followed by a combining acute. Both faces carry the precomposed
        // letter and neither carries the mark on its own, so composing first
        // keeps a name whole that would otherwise have been marked where its
        // accent was. Written as escapes because the two forms look identical
        // in an editor and one of them is the point of the test.
        expect(sanitizeText("Fern\u0061\u0301ndez", COVERAGE)).toBe("Fern\u00e1ndez");
    });

    it("keeps the line breaks a message body is laid out by", () => {
        // Layout rather than glyphs: jsPDF's own line splitting reads these, and
        // no cmap carries a newline.
        expect(sanitizeText("First line\nsecond\tline\r\n", COVERAGE)).toBe(
            "First line\nsecond\tline\r\n",
        );
    });

    it("does not leave the space a lost character sat beside", () => {
        expect(sanitizeText(" 陈 ", COVERAGE)).toBe("?");
        expect(sanitizeText("", COVERAGE)).toBe("");
    });
});

describe("sanitizeModel", () => {
    it("walks every string in a document model", () => {
        const model = {
            rangeLabel: "Feb 2024 to Jan 2025",
            dashboards: [
                {
                    title: "Messages",
                    charts: [{ items: [{ primary: "李429 Müller", value: "7 msgs" }] }],
                },
            ],
        };

        const sanitized = sanitizeModel(model, COVERAGE);

        expect(sanitized.dashboards[0].charts[0].items[0]).toEqual({
            primary: "?429 Müller",
            value: "7 msgs",
        });
        expect(sanitized.rangeLabel).toBe("Feb 2024 to Jan 2025");
    });

    it("hands back everything that is not text as it is", () => {
        const generatedAt = new Date(2026, 6, 31);
        const model = {
            generatedAt,
            count: 42,
            ratio: null,
            opted: true,
            missing: undefined,
        };

        const sanitized = sanitizeModel(model, COVERAGE);

        // The layout engine formats this date, so it has to stay a date rather
        // than be copied into a bare object one field at a time.
        expect(sanitized.generatedAt).toBe(generatedAt);
        expect(sanitized).toEqual(model);
    });

    it("leaves the model it was given untouched", () => {
        const model = { title: "田中" };

        expect(sanitizeModel(model, COVERAGE).title).toBe("?");
        expect(model.title).toBe("田中");
    });
});
