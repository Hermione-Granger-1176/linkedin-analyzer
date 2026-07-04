/**
 * Vitest unit tests for narrative insight-card generation.
 *
 * generateInsights was extracted from analytics.js. It is pure: it maps a
 * already-built view model onto insight cards and a closing tip.
 */

import { describe, expect, it } from "vitest";

import { generateInsights } from "../src/analytics-insights.js";

/**
 * Build a minimal view model with sensible defaults, overridable per test.
 * @param {object} overrides - Fields to override on the base view
 * @returns {object} View model accepted by generateInsights
 */
function buildView(overrides = {}) {
    return {
        totals: { total: 40, posts: 10, comments: 5 },
        peakHour: { hour: 14 },
        peakDay: { dayIndex: 2 },
        trend: null,
        topicShift: null,
        ratioTrend: null,
        topics: [],
        streaks: { current: 0 },
        ...overrides,
    };
}

/**
 * Collect insight ids for easier assertions.
 * @param {object} view - View model
 * @returns {string[]} Ordered insight ids
 */
function insightIds(view) {
    return generateInsights(view).insights.map((insight) => insight.id);
}

describe("generateInsights", () => {
    it("returns no insights when the view is missing or empty", () => {
        expect(generateInsights(null)).toEqual({ insights: [], tip: null });
        expect(generateInsights({ totals: null })).toEqual({ insights: [], tip: null });
        expect(generateInsights(buildView({ totals: { total: 0, posts: 0, comments: 0 } }))).toEqual(
            { insights: [], tip: null },
        );
    });

    describe("time-of-day insight", () => {
        it("labels early peak hours as an Early Bird", () => {
            const ids = insightIds(buildView({ peakHour: { hour: 5 } }));
            expect(ids).toContain("early-bird");
        });

        it("labels late peak hours as a Night Owl", () => {
            const ids = insightIds(buildView({ peakHour: { hour: 22 } }));
            expect(ids).toContain("night-owl");
        });

        it("falls back to a steady rhythm for midday peaks", () => {
            const ids = insightIds(buildView({ peakHour: { hour: 14 } }));
            expect(ids).toContain("steady-pace");
        });

        it("formats the peak hour as a zero-padded 24h label", () => {
            const { insights } = generateInsights(buildView({ peakHour: { hour: 5 } }));
            const early = insights.find((insight) => insight.id === "early-bird");
            expect(early.body).toContain("05:00");
        });
    });

    describe("trend insight", () => {
        it("reports an upward trend with the rounded absolute percent", () => {
            const { insights } = generateInsights(
                buildView({ trend: { direction: "up", percent: 42.4 } }),
            );
            const trend = insights.find((insight) => insight.id === "trending-up");
            expect(trend.body).toContain("42%");
        });

        it("reports a downward trend with a positive percent", () => {
            const { insights } = generateInsights(
                buildView({ trend: { direction: "down", percent: -18.6 } }),
            );
            const trend = insights.find((insight) => insight.id === "slowing");
            expect(trend.body).toContain("19%");
        });

        it("ignores a trend with an unrecognized direction", () => {
            const ids = insightIds(buildView({ trend: { direction: "flat", percent: 0 } }));
            expect(ids).not.toContain("trending-up");
            expect(ids).not.toContain("slowing");
        });
    });

    it("adds a focus-shift card when the top topic changed", () => {
        const { insights } = generateInsights(
            buildView({ topicShift: { from: "design", to: "hiring" } }),
        );
        const shift = insights.find((insight) => insight.id === "topic-shift");
        expect(shift.body).toContain("design");
        expect(shift.body).toContain("hiring");
    });

    describe("engagement-style shift", () => {
        it("describes leaning into conversations when engaging more", () => {
            const { insights } = generateInsights(
                buildView({ ratioTrend: { direction: "more-engaging" } }),
            );
            const shift = insights.find((insight) => insight.id === "engagement-shift");
            expect(shift.body).toContain("commenting more");
        });

        it("describes leaning into creating otherwise", () => {
            const { insights } = generateInsights(
                buildView({ ratioTrend: { direction: "less-engaging" } }),
            );
            const shift = insights.find((insight) => insight.id === "engagement-shift");
            expect(shift.body).toContain("posting more");
        });
    });

    it("flags a quiet stretch when activity is very low", () => {
        const ids = insightIds(buildView({ totals: { total: 6, posts: 2, comments: 1 } }));
        expect(ids).toContain("quiet-stretch");
    });

    describe("super-engager tiers", () => {
        it("does not divide by zero when there are no posts", () => {
            const ids = insightIds(buildView({ totals: { total: 40, posts: 0, comments: 30 } }));
            expect(ids).not.toContain("super-engager");
        });

        it("picks the strongest tier the ratio qualifies for", () => {
            const { insights } = generateInsights(
                buildView({ totals: { total: 60, posts: 1, comments: 30 } }),
            );
            const engager = insights.find((insight) => insight.id === "super-engager");
            expect(engager.title).toBe("Engagement Machine");
        });

        it("uses the lowest tier for a modest ratio", () => {
            const { insights } = generateInsights(
                buildView({ totals: { total: 40, posts: 10, comments: 40 } }),
            );
            const engager = insights.find((insight) => insight.id === "super-engager");
            expect(engager.title).toBe("Super Engager");
        });
    });

    it("adds a topic-focus card for the top topic", () => {
        const { insights } = generateInsights(
            buildView({ topics: [{ topic: "kubernetes", count: 12 }] }),
        );
        const topic = insights.find((insight) => insight.id === "topic-master");
        expect(topic.body).toContain("kubernetes");
        expect(topic.body).toContain("12");
    });

    describe("streak tiers", () => {
        it("names an unstoppable streak at the highest tier", () => {
            const { insights } = generateInsights(buildView({ streaks: { current: 120 } }));
            const streak = insights.find((insight) => insight.id === "streak");
            expect(streak.title).toBe("Unstoppable Streak");
        });

        it("omits the streak card below the lowest threshold", () => {
            const ids = insightIds(buildView({ streaks: { current: 3 } }));
            expect(ids).not.toContain("streak");
        });
    });

    it("always closes with a peak-day card and a tip referencing it", () => {
        const { insights, tip } = generateInsights(buildView({ peakDay: { dayIndex: 2 } }));
        const peakDay = insights.find((insight) => insight.id === "weekday");
        expect(peakDay.body).toContain("Wed");
        expect(tip).toContain("Wed");
        expect(tip).toContain("14:00");
    });
});
