import { describe, expect, it } from "vitest";

import { computeWorkerTimeout } from "../../src/shared/worker-timeout.js";

describe("computeWorkerTimeout", () => {
    it("returns the base timeout for small inputs", () => {
        expect(computeWorkerTimeout("", "")).toBe(30000);
        expect(computeWorkerTimeout("abc", "def")).toBe(30000);
    });

    it("adds 5000ms per whole megabyte of combined input", () => {
        const oneMb = "a".repeat(1024 * 1024);
        expect(computeWorkerTimeout(oneMb, "")).toBe(35000);
        expect(computeWorkerTimeout(oneMb, oneMb)).toBe(40000);
    });

    it("floors partial megabytes", () => {
        const oneAndAHalfMb = "a".repeat(Math.floor(1.5 * 1024 * 1024));
        expect(computeWorkerTimeout(oneAndAHalfMb, "")).toBe(35000);
    });

    it("sums however many files the caller was given", () => {
        // Variadic so a caller with one file passes one, rather than padding
        // the call with an empty second file it does not have. Summing means
        // three half-megabyte files clear a whole megabyte together, the way
        // two would.
        const halfMb = "a".repeat(Math.floor(0.5 * 1024 * 1024));
        expect(computeWorkerTimeout()).toBe(30000);
        expect(computeWorkerTimeout(halfMb)).toBe(30000);
        expect(computeWorkerTimeout(halfMb, halfMb)).toBe(35000);
        expect(computeWorkerTimeout(halfMb, halfMb, halfMb)).toBe(35000);
        expect(computeWorkerTimeout(halfMb, halfMb, halfMb, halfMb)).toBe(40000);
    });
});
