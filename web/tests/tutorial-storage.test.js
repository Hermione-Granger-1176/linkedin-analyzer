/**
 * Vitest unit tests for the tutorial storage keys and safe localStorage access.
 *
 * These helpers were extracted from tutorial.js. The key builders are pure; the
 * storage wrappers swallow access errors so a locked-down browser cannot break
 * the tutorial.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    getCompletionKey,
    getMiniTipKey,
    getMiniTipLastShownAtKey,
    getMiniTipVisitCountKey,
    getStorageNumberValue,
    getStorageValue,
    removeStorageValue,
    setStorageValue,
} from "../src/tutorial-storage.js";

const PREFIX = "linkedin-analyzer:tutorial:v1";

describe("storage key builders", () => {
    it("builds a per-route completion key", () => {
        expect(getCompletionKey("analytics")).toBe(`${PREFIX}:route:analytics:complete`);
    });

    it("builds a per-route, per-tip dismissal key", () => {
        expect(getMiniTipKey("messages", "range-filter")).toBe(
            `${PREFIX}:route:messages:tip:range-filter:dismissed`,
        );
    });

    it("builds the shared mini-tip visit count key", () => {
        expect(getMiniTipVisitCountKey()).toBe(`${PREFIX}:mini-tip:route-visits`);
    });

    it("builds the shared mini-tip last-shown key", () => {
        expect(getMiniTipLastShownAtKey()).toBe(`${PREFIX}:mini-tip:last-shown-at`);
    });
});

describe("safe localStorage wrappers", () => {
    beforeEach(() => {
        window.localStorage.clear();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        window.localStorage.clear();
    });

    it("round-trips a value through set and get", () => {
        setStorageValue("k", "v");
        expect(getStorageValue("k")).toBe("v");
    });

    it("returns null for a missing key", () => {
        expect(getStorageValue("absent")).toBeNull();
    });

    it("removes a stored value", () => {
        setStorageValue("k", "v");
        removeStorageValue("k");
        expect(getStorageValue("k")).toBeNull();
    });

    describe("getStorageNumberValue", () => {
        it("parses a stored numeric string", () => {
            setStorageValue("count", "7");
            expect(getStorageNumberValue("count", 0)).toBe(7);
        });

        it("coerces a missing key to zero (Number(null))", () => {
            // A missing key reads as null, and Number(null) is a finite 0, so the
            // fallback only applies to genuinely non-numeric stored strings.
            expect(getStorageNumberValue("absent", 42)).toBe(0);
        });

        it("returns the fallback for a non-numeric value", () => {
            setStorageValue("count", "not-a-number");
            expect(getStorageNumberValue("count", 3)).toBe(3);
        });
    });

    it("swallows getItem errors and returns null", () => {
        vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        expect(getStorageValue("k")).toBeNull();
    });

    it("swallows setItem errors without throwing", () => {
        vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        expect(() => setStorageValue("k", "v")).not.toThrow();
    });

    it("swallows removeItem errors without throwing", () => {
        vi.spyOn(window.localStorage, "removeItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        expect(() => removeStorageValue("k")).not.toThrow();
    });
});
