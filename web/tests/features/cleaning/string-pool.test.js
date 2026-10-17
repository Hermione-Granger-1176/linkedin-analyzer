import { describe, expect, it, vi } from "vitest";

import { copyString, createStringPool } from "../../../src/features/cleaning/string-pool.js";

describe("copyString", () => {
    it.each(["", "a", "a value longer than thirteen characters"])(
        "returns an equal string for %j",
        (value) => {
            expect(copyString(value)).toBe(value);
        },
    );
});

describe("createStringPool", () => {
    it("returns equal values and the same copy for a repeat in one column", () => {
        const keep = createStringPool();
        const first = keep("https://linkedin.com/in/ada", "URL");

        expect(first).toBe("https://linkedin.com/in/ada");
        expect(keep("https://linkedin.com/in/ada", "URL")).toBe(first);
    });

    it("keeps sharing in a column that repeats past its sample", () => {
        const map = vi.spyOn(Map.prototype, "get");
        const keep = createStringPool();
        for (let index = 0; index < 5000; index += 1) {
            keep(`person-${index % 10}`, "FROM");
        }
        map.mockClear();

        expect(keep("person-3", "FROM")).toBe("person-3");
        // One lookup for the column state and one in its pool.
        expect(map).toHaveBeenCalledTimes(2);
        map.mockRestore();
    });

    it("stops sharing a column whose sample was nearly all distinct", () => {
        const keep = createStringPool();
        for (let index = 0; index < 4096; index += 1) {
            keep(`2025-01-01 10:00:${index}`, "DATE");
        }
        const map = vi.spyOn(Map.prototype, "get");

        expect(keep("2025-01-01 10:00:1", "DATE")).toBe("2025-01-01 10:00:1");
        // Only the column state is looked up; the pool is gone.
        expect(map).toHaveBeenCalledTimes(1);
        map.mockRestore();
    });

    it("decides for each column on its own", () => {
        const keep = createStringPool();
        for (let index = 0; index < 4096; index += 1) {
            keep(`unique-${index}`, "DATE");
            keep("INBOX", "FOLDER");
        }
        const map = vi.spyOn(Map.prototype, "get");

        keep("INBOX", "FOLDER");

        expect(map).toHaveBeenCalledTimes(2);
        map.mockRestore();
    });
});
