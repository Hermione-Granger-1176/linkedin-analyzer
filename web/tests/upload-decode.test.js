import { afterEach, describe, expect, it } from "vitest";

import { MAX_CSV_CHARS } from "../src/constants.js";
import { concatChunks, decodeBytes, isQuotaExceededError } from "../src/upload-decode.js";

const encode = (str) => new TextEncoder().encode(str);

describe("decodeBytes", () => {
    const originalTextDecoder = globalThis.TextDecoder;

    afterEach(() => {
        globalThis.TextDecoder = originalTextDecoder;
    });

    it("returns the decoded text and usedFallback=false for clean UTF-8", () => {
        const result = decodeBytes(encode("hello world"), "Shares.csv");
        expect(result.text).toBe("hello world");
        expect(result.usedFallback).toBe(false);
    });

    it("decodes multibyte UTF-8 without a fallback", () => {
        const result = decodeBytes(encode("col\nvalüe"), "Shares.csv");
        expect(result.text).toBe("col\nvalüe");
        expect(result.usedFallback).toBe(false);
    });

    it("falls back to windows-1252 for non-UTF-8 bytes", () => {
        // 0xFF is invalid as a lone UTF-8 byte; windows-1252 maps it to ÿ.
        const result = decodeBytes(new Uint8Array([0xff]), "Shares.csv");
        expect(result.usedFallback).toBe(true);
        expect(result.text).toBe("ÿ");
    });

    it("throws a clear error when TextDecoder is unavailable", () => {
        globalThis.TextDecoder = undefined;
        expect(() => decodeBytes(new Uint8Array([0x61]), "Shares.csv")).toThrow(
            /text-decoding support/,
        );
    });

    it("throws when decoded text exceeds the character limit", () => {
        // Stub TextDecoder to return an over-limit string without allocating it.
        globalThis.TextDecoder = class {
            decode() {
                return { length: MAX_CSV_CHARS + 1 };
            }
        };
        expect(() => decodeBytes(new Uint8Array([0x61]), "Huge.csv")).toThrow(/text limit/);
    });
});

describe("concatChunks", () => {
    it("concatenates chunks in order into a single byte array", () => {
        const a = encode("ab");
        const b = encode("cd");
        const result = concatChunks([a, b], a.byteLength + b.byteLength);
        expect(new TextDecoder().decode(result)).toBe("abcd");
    });

    it("returns an empty array for no chunks", () => {
        const result = concatChunks([], 0);
        expect(result).toEqual(new Uint8Array(0));
    });
});

describe("isQuotaExceededError", () => {
    it("detects a QuotaExceededError by name", () => {
        expect(isQuotaExceededError({ name: "QuotaExceededError" })).toBe(true);
    });

    it("detects the Firefox quota error name", () => {
        expect(isQuotaExceededError({ name: "NS_ERROR_DOM_QUOTA_REACHED" })).toBe(true);
    });

    it("detects the legacy code 22", () => {
        expect(isQuotaExceededError({ code: 22 })).toBe(true);
    });

    it("walks the cause chain to find a wrapped quota error", () => {
        const wrapped = new Error("save failed");
        wrapped.cause = { name: "QuotaExceededError" };
        expect(isQuotaExceededError(wrapped)).toBe(true);
    });

    it("returns false for unrelated errors", () => {
        expect(isQuotaExceededError(new Error("network down"))).toBe(false);
    });

    it("returns false for null/undefined", () => {
        expect(isQuotaExceededError(null)).toBe(false);
        expect(isQuotaExceededError(undefined)).toBe(false);
    });

    it("stops after the depth limit without looping forever on a cycle", () => {
        const a = { name: "x" };
        const b = { name: "y", cause: a };
        a.cause = b;
        expect(isQuotaExceededError(a)).toBe(false);
    });
});
