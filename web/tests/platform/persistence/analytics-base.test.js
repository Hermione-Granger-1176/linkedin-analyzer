import { afterEach, describe, expect, it, vi } from "vitest";

import { loadAnalyticsBase } from "../../../src/platform/persistence/analytics-base.js";
import { DataCache } from "../../../src/platform/persistence/data-cache.js";
import { Storage } from "../../../src/platform/persistence/storage.js";

const CACHE_KEY = "storage:analyticsBase";

describe("loadAnalyticsBase", () => {
    afterEach(() => {
        DataCache.invalidate(CACHE_KEY);
        vi.restoreAllMocks();
    });

    it("returns the cached base without reading storage", async () => {
        const base = { months: { "2024-01": { posts: 1, comments: 0 } } };
        DataCache.set(CACHE_KEY, base);
        const getAnalytics = vi.spyOn(Storage, "getAnalytics");

        await expect(loadAnalyticsBase()).resolves.toBe(base);

        expect(getAnalytics).not.toHaveBeenCalled();
    });

    it("reads storage on a miss and caches the answer", async () => {
        const base = { months: { "2024-02": { posts: 2, comments: 1 } } };
        const getAnalytics = vi.spyOn(Storage, "getAnalytics").mockResolvedValue(base);

        await expect(loadAnalyticsBase()).resolves.toBe(base);
        await expect(loadAnalyticsBase()).resolves.toBe(base);

        expect(getAnalytics).toHaveBeenCalledTimes(1);
        expect(DataCache.get(CACHE_KEY)).toBe(base);
    });

    it("reads storage again while nothing is stored", async () => {
        const getAnalytics = vi.spyOn(Storage, "getAnalytics").mockResolvedValue(null);

        await expect(loadAnalyticsBase()).resolves.toBeNull();
        await expect(loadAnalyticsBase()).resolves.toBeNull();

        expect(getAnalytics).toHaveBeenCalledTimes(2);
    });
});
