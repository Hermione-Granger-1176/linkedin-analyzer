import { describe, expect, it } from "vitest";

import {
    buildDataSignature,
    computeWorkerTimeout,
    DEFAULT_TIME_RANGE,
    formatShortDate,
    getRangeStart,
    MS_PER_DAY,
    parseRangeParam,
} from "../src/messages-format.js";

describe("messages-format", () => {
    describe("constants", () => {
        it("exposes the default time range", () => {
            expect(DEFAULT_TIME_RANGE).toBe("12m");
        });

        it("exposes milliseconds per day", () => {
            expect(MS_PER_DAY).toBe(24 * 60 * 60 * 1000);
        });
    });

    describe("parseRangeParam", () => {
        it("returns a recognized numeric range unchanged", () => {
            expect(parseRangeParam("3m", "12m")).toBe("3m");
            expect(parseRangeParam("1m", "12m")).toBe("1m");
            expect(parseRangeParam("6m", "12m")).toBe("6m");
            expect(parseRangeParam("12m", "12m")).toBe("12m");
        });

        it('accepts "all" as a valid range', () => {
            expect(parseRangeParam("all", "12m")).toBe("all");
        });

        it("lowercases the incoming value before matching", () => {
            expect(parseRangeParam("3M", "12m")).toBe("3m");
            expect(parseRangeParam("ALL", "12m")).toBe("all");
        });

        it("falls back for unrecognized or empty values", () => {
            expect(parseRangeParam("bogus", "12m")).toBe("12m");
            expect(parseRangeParam("", "6m")).toBe("6m");
            expect(parseRangeParam(null, "1m")).toBe("1m");
            expect(parseRangeParam(undefined, "12m")).toBe("12m");
        });
    });

    describe("getRangeStart", () => {
        it('returns null for the "all" range', () => {
            expect(getRangeStart("all", Date.now())).toBeNull();
        });

        it("returns null for an unknown range", () => {
            expect(getRangeStart("bogus", Date.now())).toBeNull();
        });

        it("returns null when there is no latest timestamp", () => {
            expect(getRangeStart("12m", 0)).toBeNull();
        });

        it("returns the first day of the month N months back", () => {
            const latest = new Date(2024, 5, 15, 9, 30, 0).getTime(); // 2024-06-15
            // 1m -> first day of the current month at midnight (months - 1 = 0)
            expect(getRangeStart("1m", latest)).toBe(new Date(2024, 5, 1, 0, 0, 0, 0).getTime());
            // 3m -> two months back
            expect(getRangeStart("3m", latest)).toBe(new Date(2024, 3, 1, 0, 0, 0, 0).getTime());
            // 12m -> eleven months back, crossing the year boundary
            expect(getRangeStart("12m", latest)).toBe(new Date(2023, 6, 1, 0, 0, 0, 0).getTime());
        });
    });

    describe("formatShortDate", () => {
        it("formats a timestamp via Intl with the expected parts", () => {
            const ts = new Date(2024, 0, 5).getTime();
            const expected = new Intl.DateTimeFormat(undefined, {
                month: "short",
                day: "2-digit",
                year: "numeric",
            }).format(new Date(ts));
            expect(formatShortDate(ts)).toBe(expected);
        });
    });

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
    });

    describe("buildDataSignature", () => {
        it("uses :none parts when files are absent", () => {
            expect(buildDataSignature(null, null)).toBe("messages:none|connections:none");
        });

        it("includes name, updatedAt, and rowCount for present files", () => {
            const messagesFile = { name: "messages.csv", updatedAt: 10, rowCount: 2 };
            const connectionsFile = { name: "Connections.csv", updatedAt: 20, rowCount: 5 };
            expect(buildDataSignature(messagesFile, connectionsFile)).toBe(
                "messages:messages.csv:10:2|connections:Connections.csv:20:5",
            );
        });

        it("defaults missing metadata fields", () => {
            expect(buildDataSignature({}, null)).toBe(
                "messages:unknown:0:0|connections:none",
            );
        });
    });
});
