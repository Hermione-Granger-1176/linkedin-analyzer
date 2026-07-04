/**
 * Vitest unit tests for the engagement-aware mini-tip pacing math.
 *
 * These helpers were extracted from tutorial.js. They are pure functions of the
 * visit count, so the exact constants are asserted directly.
 */

import { describe, expect, it } from "vitest";

import {
    getMiniTipCooldownMs,
    getMiniTipDisplayDelayMs,
    getMiniTipVisitInterval,
    normalizeVisitCount,
} from "../src/tutorial-pacing.js";

describe("normalizeVisitCount", () => {
    it("floors a positive fractional count", () => {
        expect(normalizeVisitCount(3.9)).toBe(3);
    });

    it("clamps values below one up to one", () => {
        expect(normalizeVisitCount(0)).toBe(1);
        expect(normalizeVisitCount(-5)).toBe(1);
    });

    it("clamps non-finite and non-numeric input to one", () => {
        expect(normalizeVisitCount(Number.NaN)).toBe(1);
        expect(normalizeVisitCount(Number.POSITIVE_INFINITY)).toBe(1);
        expect(normalizeVisitCount("nonsense")).toBe(1);
    });

    it("parses a numeric string", () => {
        expect(normalizeVisitCount("4")).toBe(4);
    });
});

describe("getMiniTipDisplayDelayMs", () => {
    it("uses the initial delay plus per-visit growth", () => {
        // 2200 base + 1 * 90 growth
        expect(getMiniTipDisplayDelayMs(1)).toBe(2290);
        // 2200 base + 5 * 90 growth
        expect(getMiniTipDisplayDelayMs(5)).toBe(2650);
    });

    it("caps the extra delay at the maximum", () => {
        // Extra delay saturates at 2200, so total caps at 4400.
        expect(getMiniTipDisplayDelayMs(1000)).toBe(4400);
    });
});

describe("getMiniTipCooldownMs", () => {
    it("grows the cooldown with the visit count", () => {
        // 30000 base + 1 * 2500 growth
        expect(getMiniTipCooldownMs(1)).toBe(32500);
        // 30000 base + 4 * 2500 growth
        expect(getMiniTipCooldownMs(4)).toBe(40000);
    });

    it("caps the cooldown at the maximum", () => {
        expect(getMiniTipCooldownMs(1000)).toBe(240000);
    });
});

describe("getMiniTipVisitInterval", () => {
    it("returns the minimum interval before the first growth step", () => {
        expect(getMiniTipVisitInterval(1)).toBe(2);
        expect(getMiniTipVisitInterval(11)).toBe(2);
    });

    it("adds one step per interval threshold crossed", () => {
        // floor(12 / 12) = 1 step above the minimum of 2
        expect(getMiniTipVisitInterval(12)).toBe(3);
        // floor(24 / 12) = 2 steps
        expect(getMiniTipVisitInterval(24)).toBe(4);
    });

    it("caps the interval at the maximum", () => {
        expect(getMiniTipVisitInterval(1000)).toBe(6);
    });
});
