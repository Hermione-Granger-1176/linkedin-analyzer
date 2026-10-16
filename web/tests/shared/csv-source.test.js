import { afterEach, describe, expect, it, vi } from "vitest";

import { csvSourceSize, toCsvSource } from "../../src/shared/csv-source.js";

describe("csv-source", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("keeps a non-empty Blob and text, and empties everything else", () => {
        const blob = new Blob(["a,b"]);
        expect(toCsvSource(blob)).toBe(blob);
        expect(toCsvSource(new Blob([]))).toBe("");
        expect(toCsvSource("a,b")).toBe("a,b");
        expect(toCsvSource(null)).toBe("");
        expect(toCsvSource(42)).toBe("");
    });

    it("treats values as text where the platform has no Blob", () => {
        vi.stubGlobal("Blob", undefined);
        expect(toCsvSource("a,b")).toBe("a,b");
        expect(toCsvSource({ size: 3 })).toBe("");
    });

    it("measures text in characters and a Blob in bytes", () => {
        expect(csvSourceSize("héllo")).toBe(5);
        expect(csvSourceSize(new Blob(["héllo"]))).toBe(6);
        expect(csvSourceSize(null)).toBe(0);
        expect(csvSourceSize(undefined)).toBe(0);
    });
});
