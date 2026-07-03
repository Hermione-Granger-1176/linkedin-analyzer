import { describe, expect, it } from "vitest";

import {
    CLEANERS,
    cleanValue,
    escapeFormula,
    isMissing,
    removeIllegalChars,
} from "../src/field-cleaners.js";

describe("isMissing", () => {
    it("treats null and undefined as missing", () => {
        expect(isMissing(null)).toBe(true);
        expect(isMissing(undefined)).toBe(true);
    });

    it("treats NaN numbers as missing but finite numbers as present", () => {
        expect(isMissing(Number.NaN)).toBe(true);
        expect(isMissing(0)).toBe(false);
        expect(isMissing(42)).toBe(false);
    });

    it("treats blank and sentinel strings as missing", () => {
        expect(isMissing("")).toBe(true);
        expect(isMissing("   ")).toBe(true);
        expect(isMissing("NA")).toBe(true);
        expect(isMissing("n/a")).toBe(true);
    });

    it("treats ordinary strings as present", () => {
        expect(isMissing("hello")).toBe(false);
        expect(isMissing("ordinary long profile content")).toBe(false);
    });

    it("treats non-string, non-number values as present", () => {
        expect(isMissing(true)).toBe(false);
        expect(isMissing({})).toBe(false);
    });
});

describe("cleanValue", () => {
    it("trims surrounding whitespace", () => {
        expect(cleanValue("  hi  ")).toBe("hi");
    });

    it("returns empty string for missing values", () => {
        expect(cleanValue(null)).toBe("");
        expect(cleanValue("NA")).toBe("");
    });
});

describe("escapeFormula", () => {
    it("prefixes formula-injection characters with a quote", () => {
        for (const prefix of ["=", "+", "-", "@", "\t", "\r", "\n"]) {
            expect(escapeFormula(`${prefix}cmd`)).toBe(`'${prefix}cmd`);
        }
    });

    it("leaves ordinary values and empty strings unchanged", () => {
        expect(escapeFormula("safe")).toBe("safe");
        expect(escapeFormula("")).toBe("");
    });
});

describe("removeIllegalChars", () => {
    it("strips XML-illegal control characters", () => {
        expect(removeIllegalChars("a\u0000b\u0007c\u001fd")).toBe("abcd");
        expect(removeIllegalChars("\u0008\u000b\u000c\u000e")).toBe("");
    });

    it("preserves legal whitespace and ordinary text", () => {
        expect(removeIllegalChars("a\tb\nc\rd")).toBe("a\tb\nc\rd");
        expect(removeIllegalChars("hello")).toBe("hello");
    });
});

describe("CLEANERS registry", () => {
    it("exposes the named cell cleaners", () => {
        expect(Object.keys(CLEANERS).sort()).toEqual(
            [
                "cleanCommentsMessage",
                "cleanConnectionsDate",
                "cleanDate",
                "cleanEmptyField",
                "cleanMessagesContent",
                "cleanSharesCommentary",
            ].sort(),
        );
    });

    it("cleanEmptyField collapses quoted-empty values", () => {
        expect(CLEANERS.cleanEmptyField('""')).toBe("");
        expect(CLEANERS.cleanEmptyField('"')).toBe("");
        expect(CLEANERS.cleanEmptyField("keep")).toBe("keep");
    });

    it("cleanSharesCommentary strips wrapping quotes and unescapes", () => {
        expect(CLEANERS.cleanSharesCommentary('"He said ""hi"""')).toBe('He said "hi"');
        expect(CLEANERS.cleanSharesCommentary(null)).toBe("");
    });
});
