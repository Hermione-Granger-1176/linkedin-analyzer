import { describe, expect, it } from "vitest";

import { CLEANERS, cleanValue, escapeFormula, isMissing } from "../src/field-cleaners.js";

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
