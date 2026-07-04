/**
 * Vitest unit tests for the analytics text normalization and topic extraction.
 *
 * extractTopics is the only public export; normalizeText stays closure-internal
 * and is exercised through it. These helpers are pure, so no DOM is needed.
 */

import { describe, expect, it } from "vitest";

import { extractTopics } from "../src/analytics-text.js";

describe("extractTopics", () => {
    it("returns an empty array for empty, null, or non-string input", () => {
        expect(extractTopics("")).toEqual([]);
        expect(extractTopics(null)).toEqual([]);
        expect(extractTopics(undefined)).toEqual([]);
    });

    it("returns an empty array when the text collapses to nothing", () => {
        expect(extractTopics("   ")).toEqual([]);
    });

    it("extracts significant words and lowercases them", () => {
        const topics = extractTopics("Building Kubernetes clusters for Production");
        expect(topics).toContain("building");
        expect(topics).toContain("kubernetes");
        expect(topics).toContain("clusters");
        expect(topics).toContain("production");
    });

    it("filters out stop words", () => {
        const topics = extractTopics("the a and or but with about design");
        expect(topics).toEqual(["design"]);
    });

    it("drops words shorter than three letters", () => {
        const topics = extractTopics("go to ai ml design");
        expect(topics).not.toContain("ai");
        expect(topics).not.toContain("ml");
        expect(topics).toContain("design");
    });

    it("captures hashtags without the leading hash", () => {
        const topics = extractTopics("Shipping #DevOps and #Kubernetes today");
        expect(topics).toContain("devops");
        expect(topics).toContain("kubernetes");
    });

    it("filters hashtags that are stop words", () => {
        const topics = extractTopics("#the #design");
        expect(topics).toEqual(["design"]);
    });

    it("strips URLs before tokenizing", () => {
        const topics = extractTopics("Read more at https://example.com/analytics report");
        expect(topics).toContain("read");
        expect(topics).toContain("report");
        expect(topics).not.toContain("https");
        expect(topics).not.toContain("example");
    });

    it("deduplicates repeated tokens", () => {
        const topics = extractTopics("design design DESIGN #design");
        expect(topics).toEqual(["design"]);
    });
});
