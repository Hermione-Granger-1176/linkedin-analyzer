/**
 * Vitest unit tests for the shared analytics label constants.
 *
 * These arrays were extracted into their own module to break an import cycle
 * between the analytics engine and its date/insight helpers.
 */

import { describe, expect, it } from "vitest";

import { DAY_LABELS, MONTH_LABELS } from "../src/analytics-constants.js";

describe("DAY_LABELS", () => {
    it("lists the seven weekdays starting on Monday", () => {
        expect(DAY_LABELS).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    });
});

describe("MONTH_LABELS", () => {
    it("lists the twelve months starting in January", () => {
        expect(MONTH_LABELS).toHaveLength(12);
        expect(MONTH_LABELS[0]).toBe("Jan");
        expect(MONTH_LABELS[11]).toBe("Dec");
    });
});
