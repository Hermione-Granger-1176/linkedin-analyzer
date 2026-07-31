import { describe, expect, it } from "vitest";

import { mixColors, spacerRow, totalRowHeight } from "../../../src/features/export/pdf-layout.js";

// The rest of this module (the page geometry, the line-height conversion and
// the WCAG contrast helpers) is exercised through pdf-document.test.js, which
// draws with them. What is left here is the arithmetic no drawing path pins
// down on its own.

describe("mixColors", () => {
    const paper = { r: 255, g: 253, b: 247 };
    const ink = { r: 66, g: 133, b: 244 };

    it("returns each endpoint at the ends of the blend", () => {
        expect(mixColors(paper, ink, 0)).toEqual(paper);
        expect(mixColors(paper, ink, 1)).toEqual(ink);
    });

    it("meets in the middle", () => {
        expect(mixColors({ r: 0, g: 0, b: 0 }, { r: 100, g: 200, b: 40 }, 0.5)).toEqual({
            r: 50,
            g: 100,
            b: 20,
        });
    });

    it("clamps a blend position outside the unit range", () => {
        // A heatmap intensity is computed from the data, so an out-of-range
        // amount must land on an endpoint rather than on channels jsPDF would
        // reject.
        expect(mixColors(paper, ink, -3)).toEqual(paper);
        expect(mixColors(paper, ink, 4)).toEqual(ink);
    });

    it("blends to nothing for an amount that is not a number", () => {
        // Clamping alone leaves NaN as NaN, and every channel computed from it
        // reaches setFillColor(NaN, NaN, NaN).
        for (const amount of [Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
            expect(mixColors(paper, ink, amount)).toEqual(paper);
        }
    });

    it("rounds every channel to a whole byte", () => {
        const blended = mixColors({ r: 0, g: 0, b: 0 }, { r: 5, g: 5, b: 5 }, 0.5);

        expect(blended).toEqual({ r: 3, g: 3, b: 3 });
        expect(Object.values(blended).every(Number.isInteger)).toBe(true);
    });

    it("keeps a whisper of ink visible against the paper", () => {
        // The heatmap draws its empty cells at a twentieth intensity; a mix
        // that rounded back to the paper colour would leave the grid invisible.
        expect(mixColors(paper, ink, 0.05)).not.toEqual(paper);
    });
});

describe("spacerRow", () => {
    it("reserves height without drawing anything", () => {
        // A card's chrome is painted to the height of its rows, so its bottom
        // padding has to be a row that puts no ink on the page.
        const row = spacerRow(3.6);

        expect(row.height).toBe(3.6);
        expect(row.draw(10, 20)).toBeUndefined();
    });

    it("counts towards the height of the rows around it", () => {
        expect(totalRowHeight([{ height: 4 }, spacerRow(2.6)])).toBe(6.6);
    });
});
