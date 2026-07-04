/**
 * Vitest unit tests for the analytics date parsing and calendar math helpers.
 *
 * These functions were extracted from analytics.js. They are pure and operate
 * on local-time Date objects (the cleaner has already localized timestamps).
 */

import { describe, expect, it } from "vitest";

import {
    addDays,
    addMonths,
    endOfMonth,
    enumerateMonths,
    formatDateKey,
    formatWeekLabel,
    parseDateKey,
    parseLinkedInDate,
    startOfMonth,
    startOfWeek,
} from "../src/analytics-dates.js";

describe("parseLinkedInDate", () => {
    it("parses a full timestamp into local-time components", () => {
        // 2024-01-03 is a Wednesday.
        const parsed = parseLinkedInDate("2024-01-03 09:30:00");
        expect(parsed).not.toBeNull();
        expect(parsed.dateKey).toBe("2024-01-03");
        expect(parsed.monthKey).toBe("2024-01");
        expect(parsed.hour).toBe(9);
        expect(parsed.dayIndex).toBe(2); // Monday=0, so Wednesday=2
        expect(parsed.timestamp).toBe(new Date(2024, 0, 3, 9, 30, 0).getTime());
    });

    it("zero-pads single-digit months and days in keys", () => {
        const parsed = parseLinkedInDate("2024-05-07 01:05:00");
        expect(parsed.dateKey).toBe("2024-05-07");
        expect(parsed.monthKey).toBe("2024-05");
    });

    it("defaults missing minutes to zero", () => {
        const parsed = parseLinkedInDate("2024-01-03 09");
        expect(parsed).not.toBeNull();
        expect(parsed.hour).toBe(9);
    });

    it("handles a midnight timestamp (falsy hour and minute)", () => {
        const parsed = parseLinkedInDate("2024-01-03 00:00:00");
        expect(parsed).not.toBeNull();
        expect(parsed.hour).toBe(0);
        expect(parsed.timestamp).toBe(new Date(2024, 0, 3, 0, 0, 0).getTime());
    });

    it("returns null for non-string or empty input", () => {
        expect(parseLinkedInDate(null)).toBeNull();
        expect(parseLinkedInDate(undefined)).toBeNull();
        expect(parseLinkedInDate("")).toBeNull();
        expect(parseLinkedInDate(1234)).toBeNull();
    });

    it("returns null when the date or time part is missing", () => {
        expect(parseLinkedInDate("2024-01-03")).toBeNull();
        expect(parseLinkedInDate(" 09:30:00")).toBeNull();
    });

    it("returns null when the date components are not numbers", () => {
        expect(parseLinkedInDate("bad-date-here 09:30:00")).toBeNull();
        expect(parseLinkedInDate("0000-01-01 09:30:00")).toBeNull();
    });

    it("rejects out-of-range month and day instead of rolling them over", () => {
        // Month 13 would roll into next January and day 32 into the next month;
        // both must be treated as unparseable rather than silently shifted.
        expect(parseLinkedInDate("2024-13-01 09:30:00")).toBeNull();
        expect(parseLinkedInDate("2024-00-15 09:30:00")).toBeNull();
        expect(parseLinkedInDate("2024-01-32 09:30:00")).toBeNull();
        expect(parseLinkedInDate("2024-01-00 09:30:00")).toBeNull();
    });

    it("rejects impossible calendar dates that would roll into the next month", () => {
        // 2024 is a leap year, so Feb 29 is valid but Feb 30 is not.
        expect(parseLinkedInDate("2024-02-29 09:30:00")).not.toBeNull();
        expect(parseLinkedInDate("2024-02-30 09:30:00")).toBeNull();
        expect(parseLinkedInDate("2023-02-29 09:30:00")).toBeNull();
    });

    it("rejects non-numeric or out-of-range time parts", () => {
        expect(parseLinkedInDate("2024-01-03 xx:30")).toBeNull();
        expect(parseLinkedInDate("2024-01-03 09:xx")).toBeNull();
        expect(parseLinkedInDate("2024-01-03 25:00:00")).toBeNull();
        expect(parseLinkedInDate("2024-01-03 09:75:00")).toBeNull();
    });
});

describe("enumerateMonths", () => {
    it("returns a single key when start equals end", () => {
        expect(enumerateMonths("2024-03", "2024-03")).toEqual(["2024-03"]);
    });

    it("enumerates contiguous months within a year", () => {
        expect(enumerateMonths("2024-01", "2024-04")).toEqual([
            "2024-01",
            "2024-02",
            "2024-03",
            "2024-04",
        ]);
    });

    it("crosses the year boundary", () => {
        expect(enumerateMonths("2023-11", "2024-02")).toEqual([
            "2023-11",
            "2023-12",
            "2024-01",
            "2024-02",
        ]);
    });

    it("returns empty when the end precedes the start", () => {
        expect(enumerateMonths("2024-05", "2024-01")).toEqual([]);
    });
});

describe("addMonths", () => {
    it("offsets forward and snaps to the first of the month", () => {
        const result = addMonths(new Date(2024, 0, 15), 2);
        expect(result).toEqual(new Date(2024, 2, 1));
    });

    it("offsets backward across the year boundary", () => {
        const result = addMonths(new Date(2024, 0, 15), -2);
        expect(result).toEqual(new Date(2023, 10, 1));
    });
});

describe("addDays", () => {
    it("offsets forward, rolling into the next month", () => {
        expect(addDays(new Date(2024, 0, 30), 3)).toEqual(new Date(2024, 1, 2));
    });

    it("offsets backward, rolling into the previous month", () => {
        expect(addDays(new Date(2024, 1, 1), -1)).toEqual(new Date(2024, 0, 31));
    });
});

describe("startOfMonth", () => {
    it("returns the first day of the month", () => {
        expect(startOfMonth(new Date(2024, 5, 18))).toEqual(new Date(2024, 5, 1));
    });
});

describe("endOfMonth", () => {
    it("returns the last day of the month", () => {
        expect(endOfMonth(new Date(2024, 1, 10))).toEqual(new Date(2024, 1, 29)); // 2024 is a leap year
        expect(endOfMonth(new Date(2023, 1, 10))).toEqual(new Date(2023, 1, 28));
    });
});

describe("parseDateKey", () => {
    it("parses a YYYY-MM-DD key into a local Date", () => {
        expect(parseDateKey("2024-07-04")).toEqual(new Date(2024, 6, 4));
    });
});

describe("formatDateKey", () => {
    it("formats a Date as a zero-padded YYYY-MM-DD key", () => {
        expect(formatDateKey(new Date(2024, 6, 4))).toBe("2024-07-04");
        expect(formatDateKey(new Date(2024, 11, 25))).toBe("2024-12-25");
    });

    it("round-trips with parseDateKey", () => {
        const key = "2023-02-09";
        expect(formatDateKey(parseDateKey(key))).toBe(key);
    });
});

describe("startOfWeek", () => {
    it("returns the same day when the date is already a Monday", () => {
        const monday = new Date(2024, 0, 1); // 2024-01-01 is a Monday
        expect(startOfWeek(monday)).toEqual(monday);
    });

    it("returns the preceding Monday for a mid-week date", () => {
        const thursday = new Date(2024, 0, 4);
        expect(startOfWeek(thursday)).toEqual(new Date(2024, 0, 1));
    });

    it("returns the preceding Monday for a Sunday", () => {
        const sunday = new Date(2024, 0, 7);
        expect(startOfWeek(sunday)).toEqual(new Date(2024, 0, 1));
    });
});

describe("formatWeekLabel", () => {
    it("formats a date as a `Mon DD` label", () => {
        expect(formatWeekLabel(new Date(2024, 0, 5))).toBe("Jan 05");
        expect(formatWeekLabel(new Date(2024, 11, 25))).toBe("Dec 25");
    });
});
