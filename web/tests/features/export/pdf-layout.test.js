import { describe, expect, it } from "vitest";

import { mixColors, spacerRow, totalRowHeight } from "../../../src/features/export/pdf-layout.js";

// Covers the arithmetic in this module. Page geometry, line-height conversion
// and WCAG contrast helpers are tested through pdf-document.test.js.

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
        // Amounts outside 0..1 clamp to the nearest endpoint.
        expect(mixColors(paper, ink, -3)).toEqual(paper);
        expect(mixColors(paper, ink, 4)).toEqual(ink);
    });

    it("blends to nothing for an amount that is not a number", () => {
        // NaN, Infinity and undefined blend to the first color.
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
        // A small amount still yields a color distinct from the first endpoint.
        expect(mixColors(paper, ink, 0.05)).not.toEqual(paper);
    });
});

describe("spacerRow", () => {
    it("reserves height without drawing anything", () => {
        // A spacer row reserves vertical space and draws nothing.
        const row = spacerRow(3.6);

        expect(row.height).toBe(3.6);
        expect(row.draw(10, 20)).toBeUndefined();
    });

    it("counts towards the height of the rows around it", () => {
        expect(totalRowHeight([{ height: 4 }, spacerRow(2.6)])).toBe(6.6);
    });
});
