import { describe, expect, it } from "vitest";

import {
    MAX_CSV_CHARS,
    MAX_CSV_ROWS,
    MAX_FILE_BYTES,
    MEASUREMENT_LIMITS,
    PUBLIC_LIMITS,
    resolveLimits,
} from "../../src/shared/limits.js";

describe("upload limits", () => {
    it("enforces the public limits by default", () => {
        expect(PUBLIC_LIMITS).toEqual({
            maxFileBytes: 128 * 1024 * 1024,
            maxCsvChars: 128 * 1024 * 1024,
            maxCsvRows: 1000000,
        });
        expect([MAX_FILE_BYTES, MAX_CSV_CHARS, MAX_CSV_ROWS]).toEqual([
            PUBLIC_LIMITS.maxFileBytes,
            PUBLIC_LIMITS.maxCsvChars,
            PUBLIC_LIMITS.maxCsvRows,
        ]);
    });

    it("raises the limits only for a non-production build that asks for them", () => {
        expect(resolveLimits({ MODE: "development", VITE_MEASUREMENT_LIMITS: "1" })).toBe(
            MEASUREMENT_LIMITS,
        );
        expect(resolveLimits({ MODE: "measurement", VITE_MEASUREMENT_LIMITS: "1" })).toEqual({
            maxFileBytes: 128 * 1024 * 1024,
            maxCsvChars: 128 * 1024 * 1024,
            maxCsvRows: 1000000,
        });
        expect(resolveLimits({ MODE: "development" })).toBe(PUBLIC_LIMITS);
        expect(resolveLimits({ MODE: "test", VITE_MEASUREMENT_LIMITS: "0" })).toBe(PUBLIC_LIMITS);
        expect(resolveLimits(undefined)).toBe(PUBLIC_LIMITS);
    });

    it("ignores the override in a production build", () => {
        expect(resolveLimits({ MODE: "production", VITE_MEASUREMENT_LIMITS: "1" })).toBe(
            PUBLIC_LIMITS,
        );
    });
});
