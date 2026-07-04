/**
 * Vitest unit tests for the analytics numeric helpers.
 *
 * pearson and average were extracted from analytics.js and are pure.
 */

import { describe, expect, it } from "vitest";

import { average, pearson } from "../src/analytics-stats.js";

describe("pearson", () => {
    it("returns 1 for a perfectly positive linear relationship", () => {
        expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 10);
    });

    it("returns -1 for a perfectly negative linear relationship", () => {
        expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 10);
    });

    it("returns a value near zero for uncorrelated series", () => {
        const result = pearson([1, 2, 3, 4], [3, 1, 4, 2]);
        expect(Math.abs(result)).toBeLessThan(0.5);
    });

    it("returns null when a series has zero variance", () => {
        expect(pearson([5, 5, 5], [1, 2, 3])).toBeNull();
        expect(pearson([1, 2, 3], [7, 7, 7])).toBeNull();
    });
});

describe("average", () => {
    it("computes the arithmetic mean", () => {
        expect(average([2, 4, 6])).toBe(4);
        expect(average([10])).toBe(10);
    });

    it("handles negative values", () => {
        expect(average([-2, 2])).toBe(0);
    });

    it("returns 0 for an empty array", () => {
        expect(average([])).toBe(0);
    });
});
