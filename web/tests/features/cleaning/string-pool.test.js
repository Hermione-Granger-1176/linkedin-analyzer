import { describe, expect, it, vi } from "vitest";

import { copyString, createValueCache } from "../../../src/features/cleaning/string-pool.js";

/** @param {unknown} value */
const upper = (value) => String(value).toUpperCase();

describe("copyString", () => {
    it.each(["", "a", "a value longer than thirteen characters"])(
        "returns an equal string for %j",
        (value) => {
            expect(copyString(value)).toBe(value);
        },
    );
});

describe("createValueCache", () => {
    it("cleans a repeated value once per column and shares the result", () => {
        const cache = createValueCache();
        const clean = vi.fn(upper);

        const first = cache("FROM", "ada", clean);
        const second = cache("FROM", "ada", clean);

        expect(first).toBe("ADA");
        expect(second).toBe(first);
        expect(clean).toHaveBeenCalledTimes(1);
    });

    it("keeps each column's values apart", () => {
        const cache = createValueCache();
        const clean = vi.fn(upper);

        cache("FROM", "ada", clean);
        cache("TO", "ada", clean);

        expect(clean).toHaveBeenCalledTimes(2);
    });

    it("cleans a value that is not a string without caching it", () => {
        const cache = createValueCache();
        const clean = vi.fn(() => "");

        cache("FROM", undefined, clean);
        cache("FROM", undefined, clean);

        expect(clean).toHaveBeenCalledTimes(2);
    });

    it("keeps caching in a column that repeats past its sample", () => {
        const cache = createValueCache();
        const clean = vi.fn(upper);
        for (let index = 0; index < 5000; index += 1) {
            cache("FROM", `person-${index % 10}`, clean);
        }

        expect(clean).toHaveBeenCalledTimes(10);
    });

    it("stops caching a column whose sample was nearly all distinct", () => {
        const cache = createValueCache();
        const clean = vi.fn(upper);
        for (let index = 0; index < 4096; index += 1) {
            cache("DATE", `2025-01-01 10:00:${index}`, clean);
        }
        clean.mockClear();

        expect(cache("DATE", "2025-01-01 10:00:1", clean)).toBe("2025-01-01 10:00:1");
        expect(cache("DATE", "2025-01-01 10:00:1", clean)).toBe("2025-01-01 10:00:1");
        expect(clean).toHaveBeenCalledTimes(2);
    });

    it("stops caching a column that repeats at first and then turns distinct", () => {
        const cache = createValueCache();
        const clean = vi.fn(upper);
        for (let index = 0; index < 4096; index += 1) {
            cache("CONTENT", "Thanks!", clean);
        }
        for (let index = 0; index < 4096; index += 1) {
            cache("CONTENT", `a long, distinct message body ${index}`, clean);
        }
        clean.mockClear();

        cache("CONTENT", "Thanks!", clean);
        cache("CONTENT", "Thanks!", clean);
        expect(clean).toHaveBeenCalledTimes(2);
    });
});
