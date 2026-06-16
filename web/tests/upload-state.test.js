import { describe, expect, it } from "vitest";

import {
    createEmptyFileMap,
    getTypeSpecificFileCacheKey,
    getUploadHint,
    hasAnalyticsMonths,
} from "../src/upload-state.js";

describe("createEmptyFileMap", () => {
    it("returns all tracked types set to null", () => {
        expect(createEmptyFileMap()).toEqual({
            shares: null,
            comments: null,
            messages: null,
            connections: null,
        });
    });

    it("returns a fresh object each call", () => {
        const a = createEmptyFileMap();
        const b = createEmptyFileMap();
        expect(a).not.toBe(b);
    });
});

describe("getUploadHint", () => {
    it("prompts to upload when nothing is present", () => {
        expect(getUploadHint(false, false, false)).toBe("Upload at least one file to start.");
    });

    it("reports background processing when analytics files exist but base is not ready", () => {
        expect(getUploadHint(true, true, false)).toBe("Processing analytics in the background.");
    });

    it("reports readiness when analytics base is available", () => {
        expect(getUploadHint(true, true, true)).toBe("Analytics are ready. Open the dashboard.");
    });

    it("points to the Messages tab when only non-analytics files exist", () => {
        expect(getUploadHint(true, false, false)).toBe(
            "Files loaded. Open Messages tab for conversation insights.",
        );
        expect(getUploadHint(true, false, true)).toBe(
            "Files loaded. Open Messages tab for conversation insights.",
        );
    });

    it("maps the analytics-files-without-any-tracked edge state", () => {
        // hasAny=false but analytics files reported maps to the upload prompt.
        expect(getUploadHint(false, true, false)).toBe("Upload at least one file to start.");
        expect(getUploadHint(false, true, true)).toBe("Upload at least one file to start.");
    });
});

describe("hasAnalyticsMonths", () => {
    it("returns true when at least one month bucket exists", () => {
        expect(hasAnalyticsMonths({ months: { "2024-01": {} } })).toBe(true);
    });

    it("returns false for an empty months object", () => {
        expect(hasAnalyticsMonths({ months: {} })).toBe(false);
    });

    it("returns false when months is missing", () => {
        expect(hasAnalyticsMonths({})).toBe(false);
    });

    it("returns false for null", () => {
        expect(hasAnalyticsMonths(null)).toBe(false);
    });
});

describe("getTypeSpecificFileCacheKey", () => {
    it("maps messages to its cache key", () => {
        expect(getTypeSpecificFileCacheKey("messages")).toBe("storage:file:messages");
    });

    it("maps connections to its cache key", () => {
        expect(getTypeSpecificFileCacheKey("connections")).toBe("storage:file:connections");
    });

    it("returns null for types without a dedicated cache key", () => {
        expect(getTypeSpecificFileCacheKey("shares")).toBeNull();
        expect(getTypeSpecificFileCacheKey("comments")).toBeNull();
        expect(getTypeSpecificFileCacheKey("unknown")).toBeNull();
    });
});
