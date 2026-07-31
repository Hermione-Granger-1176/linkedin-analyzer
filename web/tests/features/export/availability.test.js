import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    hasExportableData,
    hasSnapshotContent,
    readAnalyticsBase,
    readSafely,
} from "../../../src/features/export/availability.js";
import { captureError } from "../../../src/platform/observability/sentry.js";
import { DataCache } from "../../../src/platform/persistence/data-cache.js";
import { Storage } from "../../../src/platform/persistence/storage.js";
import { INSIGHTS_EXPORT_CACHE_KEY } from "../../../src/shared/constants.js";
import { expectFixedError, piiError } from "../../helpers/pii-sentinel.js";

vi.mock("../../../src/platform/observability/sentry.js", () => ({
    captureError: vi.fn(),
}));

vi.mock("../../../src/platform/persistence/data-cache.js", () => {
    const values = new Map();
    return {
        DataCache: {
            get: vi.fn((key) => values.get(key)),
            set: vi.fn((key, value) => values.set(key, value)),
            clearAll: () => values.clear(),
        },
    };
});

vi.mock("../../../src/platform/persistence/storage.js", () => ({
    Storage: {
        getAnalytics: vi.fn(),
        getOutreach: vi.fn(),
        getAllFiles: vi.fn(),
    },
}));

const OUTREACH = Object.freeze({
    selfInitiated: 128,
    replyRate: 0.42,
    unansweredContacts: 37,
    sentReceivedRatio: 1.84,
});

beforeEach(() => {
    vi.clearAllMocks();
    DataCache.clearAll();
    Storage.getAnalytics.mockResolvedValue(null);
    Storage.getOutreach.mockResolvedValue(null);
    Storage.getAllFiles.mockResolvedValue([]);
});

describe("hasExportableData", () => {
    it("is true when the Insights screen has published a snapshot", async () => {
        DataCache.set(INSIGHTS_EXPORT_CACHE_KEY, { insights: [{ title: "One" }] });

        expect(await hasExportableData()).toBe(true);
        expect(Storage.getAnalytics).not.toHaveBeenCalled();
    });

    it("is true when the snapshot holds only all-time stats", async () => {
        DataCache.set(INSIGHTS_EXPORT_CACHE_KEY, { insights: [], outreach: OUTREACH });

        expect(await hasExportableData()).toBe(true);
        expect(Storage.getAnalytics).not.toHaveBeenCalled();
    });

    it("is true when the analytics base is cached", async () => {
        DataCache.set("storage:analyticsBase", { months: {} });

        expect(await hasExportableData()).toBe(true);
        expect(Storage.getAnalytics).not.toHaveBeenCalled();
    });

    it("is true when analytics are only in storage", async () => {
        Storage.getAnalytics.mockResolvedValue({ months: {} });

        expect(await hasExportableData()).toBe(true);
    });

    it("is true when only an outreach summary exists", async () => {
        Storage.getOutreach.mockResolvedValue(OUTREACH);

        expect(await hasExportableData()).toBe(true);
    });

    it("is true when only a connections or messages export is stored", async () => {
        // Neither fills the analytics base, which only shares and comments
        // reach, but each produces a dashboard of its own.
        for (const type of ["connections", "messages"]) {
            Storage.getAllFiles.mockResolvedValue([{ type, rowCount: 12 }]);

            expect(await hasExportableData(), type).toBe(true);
        }
    });

    it("is false when the stored export holds no rows", async () => {
        // A row count rather than mere presence: an upload that stored no rows,
        // or a record whose text has since gone, is a file the dashboards will
        // find nothing in, and enabling the button for it promises a document
        // that comes back empty.
        for (const file of [{ type: "connections", rowCount: 0 }, { type: "messages" }]) {
            Storage.getAllFiles.mockResolvedValue([file]);

            expect(await hasExportableData(), file.type).toBe(false);
        }
    });

    it("is false when the stored files produce no dashboard", async () => {
        Storage.getAllFiles.mockResolvedValue([{ type: "shares", rowCount: 40 }]);

        expect(await hasExportableData()).toBe(false);
    });

    it("is false when nothing has been uploaded", async () => {
        DataCache.set(INSIGHTS_EXPORT_CACHE_KEY, { insights: [] });

        expect(await hasExportableData()).toBe(false);
        expect(Storage.getAllFiles).toHaveBeenCalled();
    });

    it("survives a storage failure without disabling the button by accident", async () => {
        Storage.getAllFiles.mockRejectedValue(new Error("indexeddb gone"));

        expect(await hasExportableData()).toBe(false);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "load-file-metadata",
        });
    });
});

describe("readAnalyticsBase", () => {
    it("prefers a cached base to a storage read", async () => {
        DataCache.set("storage:analyticsBase", { months: { "2026-01": {} } });

        expect(await readAnalyticsBase()).toEqual({ months: { "2026-01": {} } });
        expect(Storage.getAnalytics).not.toHaveBeenCalled();
    });

    it("falls through to storage when the cached base has no months", async () => {
        // The cache and the collection have to agree: a monthless cached base
        // used to make the button say yes over a document that came back empty.
        DataCache.set("storage:analyticsBase", {});
        Storage.getAnalytics.mockResolvedValue({ months: { "2026-01": {} } });

        expect(await readAnalyticsBase()).toEqual({ months: { "2026-01": {} } });
    });

    it("is null when neither holds months", async () => {
        Storage.getAnalytics.mockResolvedValue({});

        expect(await readAnalyticsBase()).toBeNull();
    });
});

describe("readSafely", () => {
    it("returns the stored value", async () => {
        expect(await readSafely(() => Promise.resolve("ok"), "load-analytics")).toBe("ok");
        expect(captureError).not.toHaveBeenCalled();
    });

    it("never reports the exception a stored read carried", async () => {
        const thrown = piiError("storage");

        expect(await readSafely(() => Promise.reject(thrown), "load-analytics")).toBeNull();

        const [reported, context] = captureError.mock.calls[0];
        expectFixedError(reported, thrown);
        expect(context).toEqual({ module: "pdf-export", operation: "load-analytics" });
    });
});

describe("hasSnapshotContent", () => {
    it.each([
        ["a missing snapshot", null, false],
        ["an empty snapshot", {}, false],
        ["cards", { insights: [{ title: "One" }] }, true],
        ["network growth alone", { insights: [], networkGrowth: { multiplier: 2 } }, true],
        ["outreach alone", { insights: [], outreach: OUTREACH }, true],
    ])("reports %s", (_label, snapshot, expected) => {
        expect(hasSnapshotContent(snapshot)).toBe(expected);
    });
});
