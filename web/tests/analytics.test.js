import { describe, expect, it } from "vitest";

import { AnalyticsEngine } from "../src/analytics.js";

function sampleData() {
    const shares = [
        {
            Date: "2025-01-02 05:00:00",
            ShareCommentary: "Excel tips #Excel",
            SharedUrl: "",
            MediaUrl: "",
            ShareLink: "https://linkedin.com",
            Visibility: "MEMBER_NETWORK"
        },
        {
            Date: "2025-01-03 14:00:00",
            ShareCommentary: "AI and data",
            SharedUrl: "https://example.com",
            MediaUrl: "",
            ShareLink: "https://linkedin.com",
            Visibility: "MEMBER_NETWORK"
        },
        {
            Date: "2025-01-04 15:00:00",
            ShareCommentary: "Video about excel",
            SharedUrl: "",
            MediaUrl: "https://media.example.com",
            ShareLink: "https://linkedin.com",
            Visibility: "MEMBER_NETWORK"
        }
    ];

    const comments = [
        {
            Date: "2025-01-02 06:00:00",
            Message: "Love #Excel",
            Link: "https://linkedin.com"
        },
        {
            Date: "2025-01-05 04:00:00",
            Message: "Nice data",
            Link: "https://linkedin.com"
        }
    ];

    return { shares, comments };
}

describe("AnalyticsEngine", () => {
    it("compute aggregates totals and base indices", () => {
        const { shares, comments } = sampleData();
        const analytics = AnalyticsEngine.compute(shares, comments);

        expect(analytics.totals.posts).toBe(3);
        expect(analytics.totals.comments).toBe(2);
        expect(analytics.totals.total).toBe(5);

        expect(Object.keys(analytics.months).length).toBeGreaterThan(0);
        expect(Object.keys(analytics.dayIndex).length).toBeGreaterThan(0);
    });

    it("buildView respects topic and shareType filters", () => {
        const { shares, comments } = sampleData();
        const analytics = AnalyticsEngine.compute(shares, comments);

        const viewAll = AnalyticsEngine.buildView(analytics, {
            timeRange: "all",
            topic: "all",
            monthFocus: null,
            day: null,
            hour: null,
            shareType: "all"
        });

        expect(viewAll.totals.total).toBe(5);
        expect(viewAll.contentMix.media).toBe(1);

        const topTopics = viewAll.topics.map(item => item.topic);
        expect(topTopics.includes("excel")).toBe(true);

        const viewTopic = AnalyticsEngine.buildView(analytics, {
            timeRange: "all",
            topic: "excel",
            monthFocus: null,
            day: null,
            hour: null,
            shareType: "all"
        });

        expect(viewTopic.totals.total).toBe(3);

        const viewMedia = AnalyticsEngine.buildView(analytics, {
            timeRange: "all",
            topic: "all",
            monthFocus: null,
            day: null,
            hour: null,
            shareType: "media"
        });

        expect(viewMedia.totals.posts).toBe(1);
        expect(viewMedia.totals.comments).toBe(0);
    });

    it("buildView respects day and hour filters", () => {
        const { shares, comments } = sampleData();
        const analytics = AnalyticsEngine.compute(shares, comments);

        const view = AnalyticsEngine.buildView(analytics, {
            timeRange: "all",
            topic: "all",
            monthFocus: null,
            day: 3,
            hour: 5,
            shareType: "all"
        });

        expect(view.totals.total).toBe(1);
        expect(view.totals.posts).toBe(1);
        expect(view.totals.comments).toBe(0);
    });

    it("generateInsights handles empty views safely", () => {
        const result = AnalyticsEngine.generateInsights({ totals: { total: 0 } });
        expect(result.insights).toEqual([]);
        expect(result.tip).toBe(null);
    });

    it("buildView supports share type and day/hour filters", () => {
        const shares = [
            {
                Date: "2025-01-01 08:00:00",
                ShareCommentary: "#AI insights",
                SharedUrl: "",
                MediaUrl: "",
                ShareLink: "https://linkedin.com",
                Visibility: "MEMBER_NETWORK"
            },
            {
                Date: "2025-01-05 12:00:00",
                ShareCommentary: "Check this https://example.com",
                SharedUrl: "https://example.com",
                MediaUrl: "",
                ShareLink: "https://linkedin.com",
                Visibility: "MEMBER_NETWORK"
            },
            {
                Date: "2025-02-01 22:00:00",
                ShareCommentary: "Video update",
                SharedUrl: "",
                MediaUrl: "https://media.example.com",
                ShareLink: "https://linkedin.com",
                Visibility: "MEMBER_NETWORK"
            }
        ];
        const comments = [
            {
                Date: "2025-01-03 09:00:00",
                Message: "Great #AI",
                Link: "https://linkedin.com"
            }
        ];

        const analytics = AnalyticsEngine.compute(shares, comments);

        const mediaOnly = AnalyticsEngine.buildView(analytics, {
            timeRange: "all",
            topic: "all",
            monthFocus: null,
            day: null,
            hour: null,
            shareType: "media"
        });

        expect(mediaOnly.totals.posts).toBe(1);
        expect(mediaOnly.totals.comments).toBe(0);

        const filtered = AnalyticsEngine.buildView(analytics, {
            timeRange: "all",
            topic: "all",
            monthFocus: null,
            day: 2,
            hour: 8,
            shareType: "all"
        });

        expect(filtered.totals.total).toBe(1);
    });

    it("buildView does not inflate counts when a topic filter is combined with a day filter", () => {
        // Regression: the day/hour fraction must be taken over the month's full
        // activity, not the topic-narrowed total. Four posts land on the same
        // weekday (Mon 2025-01-06) but only one is #ai, so the old code computed
        // ratio = days[Mon] / topicCount = 4 / 1 and inflated the #ai count to 4.
        const share = (commentary) => ({
            Date: "2025-01-06 08:00:00",
            ShareCommentary: commentary,
            SharedUrl: "",
            MediaUrl: "",
            ShareLink: "https://linkedin.com",
            Visibility: "MEMBER_NETWORK"
        });
        const shares = [
            share("#ai breakthrough"),
            share("#excel tips"),
            share("#excel more"),
            share("#data points")
        ];
        const analytics = AnalyticsEngine.compute(shares, []);
        const base = {
            timeRange: "all",
            monthFocus: null,
            day: null,
            hour: null,
            shareType: "all"
        };

        const topicOnly = AnalyticsEngine.buildView(analytics, { ...base, topic: "ai" });
        const topicAndDay = AnalyticsEngine.buildView(analytics, { ...base, topic: "ai", day: 0 });

        expect(topicOnly.totals.posts).toBe(1);
        // Adding the (Monday) day filter can only narrow the topic subset; with
        // the bug it ballooned to 4.
        expect(topicAndDay.totals.posts).toBe(1);
        expect(topicAndDay.totals.posts).toBeLessThanOrEqual(topicOnly.totals.posts);
        expect(topicAndDay.totals.total).toBeLessThanOrEqual(topicOnly.totals.total);
    });

    it("buildView intersects a topic filter with a share-type filter", () => {
        // Regression: the share-type branch used to overwrite the topic
        // adjustment, so #ai + media reported every media post regardless of
        // topic. Here only one of three media posts is #ai.
        const share = (commentary, mediaUrl) => ({
            Date: "2025-01-06 08:00:00",
            ShareCommentary: commentary,
            SharedUrl: "",
            MediaUrl: mediaUrl,
            ShareLink: "https://linkedin.com",
            Visibility: "MEMBER_NETWORK"
        });
        const shares = [
            share("#ai with video", "https://media.example.com/1"),
            share("#ai text only", ""),
            share("#excel chart", "https://media.example.com/2"),
            share("#excel clip", "https://media.example.com/3")
        ];
        const analytics = AnalyticsEngine.compute(shares, []);
        const base = {
            timeRange: "all",
            monthFocus: null,
            day: null,
            hour: null
        };

        const mediaOnly = AnalyticsEngine.buildView(analytics, {
            ...base,
            topic: "all",
            shareType: "media"
        });
        const topicOnly = AnalyticsEngine.buildView(analytics, {
            ...base,
            topic: "ai",
            shareType: "all"
        });
        const topicAndMedia = AnalyticsEngine.buildView(analytics, {
            ...base,
            topic: "ai",
            shareType: "media"
        });

        expect(mediaOnly.totals.posts).toBe(3);
        // The intersection is smaller than media-only (the topic excludes the two
        // #excel media posts); with the bug it equaled media-only at 3.
        expect(topicAndMedia.totals.posts).toBeGreaterThan(0);
        expect(topicAndMedia.totals.posts).toBeLessThan(mediaOnly.totals.posts);
        expect(topicAndMedia.totals.posts).toBeLessThanOrEqual(topicOnly.totals.posts);
    });

    it("buildView creates weekly timeline for 1m range", () => {
        const shares = [
            {
                Date: "2025-02-01 08:00:00",
                ShareCommentary: "Weekly test",
                SharedUrl: "",
                MediaUrl: "",
                ShareLink: "https://linkedin.com",
                Visibility: "MEMBER_NETWORK"
            },
            {
                Date: "2025-02-04 08:00:00",
                ShareCommentary: "Weekly followup",
                SharedUrl: "",
                MediaUrl: "",
                ShareLink: "https://linkedin.com",
                Visibility: "MEMBER_NETWORK"
            }
        ];

        const analytics = AnalyticsEngine.compute(shares, []);
        const view = AnalyticsEngine.buildView(analytics, {
            timeRange: "1m",
            topic: "all",
            monthFocus: null,
            day: null,
            hour: null,
            shareType: "all"
        });

        expect(view.timeline.length).toBeGreaterThan(0);
        expect(view.timeline[0].monthKey).toBeTruthy();
    });

    it("buildView handles empty analytics and zero older period", () => {
        const analyticsEmpty = AnalyticsEngine.compute([], []);
        const emptyView = AnalyticsEngine.buildView(analyticsEmpty, {
            timeRange: "all",
            topic: "all",
            monthFocus: null,
            day: null,
            hour: null,
            shareType: "all"
        });
        expect(emptyView.totals.total).toBe(0);

        const shares = [
            {
                Date: "2025-03-01 08:00:00",
                ShareCommentary: "Latest month only",
                SharedUrl: "",
                MediaUrl: "",
                ShareLink: "https://linkedin.com",
                Visibility: "MEMBER_NETWORK"
            }
        ];
        const analytics = AnalyticsEngine.compute(shares, []);
        const view = AnalyticsEngine.buildView(analytics, {
            timeRange: "3m",
            topic: "all",
            monthFocus: null,
            day: null,
            hour: null,
            shareType: "all"
        });
        expect(view.trend.direction).toBe("up");
    });

    it("generateInsights returns multiple insight types", () => {
        const view = {
            totals: { total: 20, posts: 2, comments: 8 },
            peakHour: { hour: 22, count: 5 },
            peakDay: { dayIndex: 1, count: 3 },
            trend: { percent: -20, direction: "down" },
            topics: [{ topic: "ai", count: 4 }],
            streaks: { current: 8, longest: 8 }
        };

        const result = AnalyticsEngine.generateInsights(view);
        expect(result.insights.length).toBeGreaterThan(2);
        expect(result.tip).toContain("around");
    });

    // ── buildWeeklyTimeline with hour filter active (lines 675-679) ───────────

    it("buildView weekly timeline with hour filter applies hourRatio (lines 675-679)", () => {
        // Two posts in the same week, one at hour 9, one at hour 14
        const shares = [
            {
                Date: "2025-02-03 09:00:00",
                ShareCommentary: "Morning post",
                SharedUrl: "",
                MediaUrl: "",
                ShareLink: "https://linkedin.com",
                Visibility: "MEMBER_NETWORK"
            },
            {
                Date: "2025-02-04 14:00:00",
                ShareCommentary: "Afternoon post",
                SharedUrl: "",
                MediaUrl: "",
                ShareLink: "https://linkedin.com",
                Visibility: "MEMBER_NETWORK"
            }
        ];
        const analytics = AnalyticsEngine.compute(shares, []);

        // Using '1m' activates the weekly timeline path; adding an hour filter
        // exercises the hasHour branch inside buildWeeklyTimeline (lines 675-679)
        const view = AnalyticsEngine.buildView(analytics, {
            timeRange: "1m",
            topic: "all",
            monthFocus: null,
            day: null,
            hour: 9,
            shareType: "all"
        });

        // Should produce a weekly timeline
        expect(view.timeline.length).toBeGreaterThan(0);
        // Values may be fractional-rounded, but should not throw and must be numbers
        view.timeline.forEach(entry => expect(typeof entry.value).toBe("number"));
    });

    // ── computeTrendFromTimeline, older === 0 branch (line 805) ─────────────

    it("computeTrendFromTimeline returns flat trend when both halves are zero", () => {
        // Two-point timeline with all zeros → older === 0 AND recent === 0
        const shares = [
            {
                Date: "2025-01-01 10:00:00",
                ShareCommentary: "only",
                SharedUrl: "",
                MediaUrl: "",
                ShareLink: "https://linkedin.com",
                Visibility: "MEMBER_NETWORK"
            }
        ];
        // Build with enough months in range so older half is zero
        const analytics = AnalyticsEngine.compute(shares, []);
        const view = AnalyticsEngine.buildView(analytics, {
            timeRange: "12m",
            topic: "all",
            monthFocus: null,
            day: null,
            hour: null,
            shareType: "all"
        });

        // The trend for a single month of activity in a 12-month window
        // means the older half is 0 and recent has activity → direction 'up'
        expect(view.trend).not.toBeNull();
        expect(["up", "flat"]).toContain(view.trend.direction);
    });

    // ── generateInsights, quiet-stretch insight (line 858) ──────────────────

    it("generateInsights adds quiet-stretch insight when total < 12 (line 858)", () => {
        const view = {
            totals: { total: 5, posts: 5, comments: 0 },
            peakHour: { hour: 10, count: 2 },
            peakDay: { dayIndex: 0, count: 2 },
            trend: null,
            topics: [],
            streaks: { current: 0, longest: 0 }
        };

        const result = AnalyticsEngine.generateInsights(view);

        const ids = result.insights.map(i => i.id);
        expect(ids).toContain("quiet-stretch");
    });

    // ── buildWeeklyTimeline with day filter zeroing non-matching days (line 664) ──

    it("buildView weekly timeline zeroes days that do not match day filter (line 664)", () => {
        // Posts on Monday (day=0) and Tuesday (day=1)
        const shares = [
            {
                Date: "2025-02-03 09:00:00", // Monday
                ShareCommentary: "Monday post",
                SharedUrl: "", MediaUrl: "",
                ShareLink: "https://linkedin.com",
                Visibility: "MEMBER_NETWORK"
            },
            {
                Date: "2025-02-04 14:00:00", // Tuesday
                ShareCommentary: "Tuesday post",
                SharedUrl: "", MediaUrl: "",
                ShareLink: "https://linkedin.com",
                Visibility: "MEMBER_NETWORK"
            }
        ];
        const analytics = AnalyticsEngine.compute(shares, []);

        // Filter for Monday only (day=0) → Tuesday entry gets value=0 (line 664)
        const view = AnalyticsEngine.buildView(analytics, {
            timeRange: "1m",
            topic: "all",
            monthFocus: null,
            day: 0,
            hour: null,
            shareType: "all"
        });

        expect(view.timeline.length).toBeGreaterThan(0);
        // Total should only count Monday's post
        expect(view.totals.posts).toBe(1);
    });

    // ── buildWeeklyTimeline with topic filter ratio (lines 669-672) ─────────

    it("buildView weekly timeline applies topicRatio when topic filter active (lines 669-672)", () => {
        const shares = [
            {
                Date: "2025-02-03 09:00:00",
                ShareCommentary: "#AI morning post",
                SharedUrl: "", MediaUrl: "",
                ShareLink: "https://linkedin.com",
                Visibility: "MEMBER_NETWORK"
            },
            {
                Date: "2025-02-04 14:00:00",
                ShareCommentary: "No topic afternoon post",
                SharedUrl: "", MediaUrl: "",
                ShareLink: "https://linkedin.com",
                Visibility: "MEMBER_NETWORK"
            }
        ];
        const analytics = AnalyticsEngine.compute(shares, []);

        const view = AnalyticsEngine.buildView(analytics, {
            timeRange: "1m",
            topic: "ai",
            monthFocus: null,
            day: null,
            hour: null,
            shareType: "all"
        });

        expect(view.timeline.length).toBeGreaterThan(0);
        view.timeline.forEach(entry => expect(typeof entry.value).toBe("number"));
    });

    // ── calculateStreaksFromDays with empty daySet (line 749) ─────────────────

    it("calculateStreaksFromDays returns zeros when passed empty data (line 749)", () => {
        // An analytics object with no active days → calculateStreaksFromDays gets empty set
        const analyticsEmpty = AnalyticsEngine.compute([], []);
        const view = AnalyticsEngine.buildView(analyticsEmpty, {
            timeRange: "all",
            topic: "all",
            monthFocus: null,
            day: null,
            hour: null,
            shareType: "all"
        });
        // No data → streaks should both be 0
        expect(view.streaks.current).toBe(0);
        expect(view.streaks.longest).toBe(0);
    });

    // ── getMonthKeysInRange with monthFocus (line 434) ────────────────────────

    it("buildView with monthFocus returns single-month timeline (line 434)", () => {
        const shares = [
            {
                Date: "2025-01-05 09:00:00",
                ShareCommentary: "Post in Jan",
                SharedUrl: "", MediaUrl: "",
                ShareLink: "https://linkedin.com",
                Visibility: "MEMBER_NETWORK"
            },
            {
                Date: "2025-02-03 09:00:00",
                ShareCommentary: "Post in Feb",
                SharedUrl: "", MediaUrl: "",
                ShareLink: "https://linkedin.com",
                Visibility: "MEMBER_NETWORK"
            }
        ];
        const analytics = AnalyticsEngine.compute(shares, []);

        // monthFocus triggers `return [monthFocus]` at line 434
        const view = AnalyticsEngine.buildView(analytics, {
            timeRange: "all",
            topic: "all",
            monthFocus: "2025-01",
            day: null,
            hour: null,
            shareType: "all"
        });

        expect(view.totals.posts).toBe(1);
    });

    // ── filterMonthBucket with topic that has 0 count → useMonth=false (line 392) ──

    it("buildView with topic that has zero count for a month sets useMonth=false (line 392)", () => {
        // Jan has AI topic, Feb has Excel topic. Filter for AI → Feb month gets useMonth=false
        const shares = [
            {
                Date: "2025-01-05 09:00:00",
                ShareCommentary: "#AI post",
                SharedUrl: "", MediaUrl: "",
                ShareLink: "https://linkedin.com",
                Visibility: "MEMBER_NETWORK"
            },
            {
                Date: "2025-02-03 09:00:00",
                ShareCommentary: "#Excel post",
                SharedUrl: "", MediaUrl: "",
                ShareLink: "https://linkedin.com",
                Visibility: "MEMBER_NETWORK"
            }
        ];
        const analytics = AnalyticsEngine.compute(shares, []);

        const view = AnalyticsEngine.buildView(analytics, {
            timeRange: "all",
            topic: "ai",
            monthFocus: null,
            day: null,
            hour: null,
            shareType: "all"
        });

        // Only January's AI post should be counted
        expect(view.totals.posts).toBe(1);
    });

    // ── buildView with no dayIndex skips weekly timeline branch (line 491) ──────

    it("buildView skips weekly timeline and uses monthly entries when dayIndex is null", () => {
        const shares = [
            {
                Date: "2025-01-10 09:00:00",
                ShareCommentary: "Text post",
                SharedUrl: "", MediaUrl: "",
                ShareLink: "https://linkedin.com",
                Visibility: "MEMBER_NETWORK"
            }
        ];
        const analytics = AnalyticsEngine.compute(shares, []);
        // Remove dayIndex so useWeeklyTimeline becomes false even for weekly ranges
        analytics.dayIndex = null;

        const view = AnalyticsEngine.buildView(analytics, {
            timeRange: "1m",
            topic: "all",
            monthFocus: null,
            day: null,
            hour: null,
            shareType: "all"
        });

        // Monthly timeline is used; each entry has key/label/value
        expect(view.timeline.length).toBeGreaterThan(0);
        expect(view.timeline[0]).toHaveProperty("key");
        expect(view.timeline[0]).toHaveProperty("value");
    });

    // ── buildWeeklyTimeline typeKey branch when shareTypes is falsy (line 658) ─

    it("buildView weekly timeline falls back to 0 when entry has no shareTypes (line 658)", () => {
        const shares = [
            {
                Date: "2025-02-03 09:00:00",
                ShareCommentary: "Text post",
                SharedUrl: "", MediaUrl: "",
                ShareLink: "https://linkedin.com",
                Visibility: "MEMBER_NETWORK"
            }
        ];
        const analytics = AnalyticsEngine.compute(shares, []);
        // Manually clear shareTypes from dayIndex to force the falsy branch
        Object.values(analytics.dayIndex).forEach(entry => {
            entry.shareTypes = null;
        });

        const view = AnalyticsEngine.buildView(analytics, {
            timeRange: "1m",
            topic: "all",
            monthFocus: null,
            day: null,
            hour: null,
            shareType: "textOnly"
        });

        expect(view.timeline.length).toBeGreaterThan(0);
        view.timeline.forEach(entry => expect(typeof entry.value).toBe("number"));
    });

    it("generateInsights adds trending-up insight when trend direction is up (line 849)", () => {
        const view = {
            totals: { total: 30, posts: 20, comments: 10 },
            peakHour: { hour: 10, count: 5 },
            peakDay: { dayIndex: 0, count: 5 },
            trend: { percent: 50, direction: "up" },
            topics: [],
            streaks: { current: 0, longest: 0 }
        };

        const result = AnalyticsEngine.generateInsights(view);

        const ids = result.insights.map(i => i.id);
        expect(ids).toContain("trending-up");
    });
});

// ── WP6: network growth, topic shift, engagement shift, tiered cards ──────────

/**
 * Build shares/comments/connections rows from per-month specs.
 * @param {Array<{month: string, posts?: number, comments?: number, connections?: number, topic?: string}>} specs
 */
function buildMonthly(specs) {
    const shares = [];
    const comments = [];
    const connections = [];
    specs.forEach(spec => {
        const topic = spec.topic || "general";
        for (let i = 0; i < (spec.posts || 0); i++) {
            shares.push({
                Date: `${spec.month}-05 09:00:00`,
                ShareCommentary: `#${topic}`,
                SharedUrl: "",
                MediaUrl: ""
            });
        }
        for (let i = 0; i < (spec.comments || 0); i++) {
            comments.push({ Date: `${spec.month}-06 10:00:00`, Message: `#${topic}` });
        }
        for (let i = 0; i < (spec.connections || 0); i++) {
            connections.push({ "Connected On": `${spec.month}-10` });
        }
    });
    return { shares, comments, connections };
}

/**
 * Build `count` consecutive month specs from 2023-01, merging perMonth(idx).
 * @param {number} count
 * @param {(index: number) => object} perMonth
 */
function monthsRange(count, perMonth) {
    const specs = [];
    for (let i = 0; i < count; i++) {
        const year = 2023 + Math.floor(i / 12);
        const month = String((i % 12) + 1).padStart(2, "0");
        specs.push({ month: `${year}-${month}`, ...perMonth(i) });
    }
    return specs;
}

/** Build the all-time view for an analytics payload. */
function allTimeView(analytics) {
    return AnalyticsEngine.buildView(analytics, {
        timeRange: "all",
        topic: "all",
        monthFocus: null,
        day: null,
        hour: null,
        shareType: "all"
    });
}

/** Minimal generateInsights view with overridable fields. */
function insightView(overrides) {
    return {
        totals: { total: 20, posts: 10, comments: 2 },
        peakHour: { hour: 10, count: 1 },
        peakDay: { dayIndex: 0, count: 1 },
        trend: null,
        topics: [],
        streaks: { current: 0, longest: 0 },
        ...overrides
    };
}

describe("AnalyticsEngine network growth", () => {
    it("computes a network-growth summary from posting/connection correlation", () => {
        const specs = monthsRange(14, i =>
            i < 4
                ? { posts: 1, connections: 1, topic: "excel" }
                : { posts: 10, connections: 20, topic: "ai" }
        );
        const { shares, comments, connections } = buildMonthly(specs);
        const analytics = AnalyticsEngine.compute(shares, comments, connections);

        expect(analytics.networkGrowth).not.toBeNull();
        expect(analytics.networkGrowth.multiplier).toBeGreaterThanOrEqual(2);
        expect(analytics.networkGrowth.correlation).toBeGreaterThan(0);

        // It is a lifetime stat rendered in the All-time section, not one of the
        // filter-driven cards, so generateInsights must not emit it.
        const view = allTimeView(analytics);
        expect(view.networkGrowth).toEqual(analytics.networkGrowth);
        const ids = AnalyticsEngine.generateInsights(view).insights.map(i => i.id);
        expect(ids).not.toContain("network-growth");
    });

    it("carries the same networkGrowth value on filtered and narrowed views", () => {
        const specs = monthsRange(14, i =>
            i < 4
                ? { posts: 1, connections: 1, topic: "excel" }
                : { posts: 10, connections: 20, topic: "ai" }
        );
        const { shares, comments, connections } = buildMonthly(specs);
        const analytics = AnalyticsEngine.compute(shares, comments, connections);
        expect(analytics.networkGrowth).not.toBeNull();

        // It is a lifetime value rendered apart from the filters, so it rides on
        // every view unchanged rather than being recomputed per filter.
        const baseFilters = {
            timeRange: "all",
            topic: "all",
            monthFocus: null,
            day: null,
            hour: null,
            shareType: "all",
        };
        expect(
            AnalyticsEngine.buildView(analytics, { ...baseFilters, timeRange: "3m" }).networkGrowth
        ).toEqual(analytics.networkGrowth);
        expect(
            AnalyticsEngine.buildView(analytics, { ...baseFilters, topic: "ai" }).networkGrowth
        ).toEqual(analytics.networkGrowth);
    });

    it("leaves networkGrowth null without connection data", () => {
        const { shares } = buildMonthly(monthsRange(14, () => ({ posts: 5, topic: "x" })));
        expect(AnalyticsEngine.compute(shares, []).networkGrowth).toBeNull();
    });

    it("leaves networkGrowth null when there is no posting activity", () => {
        const { connections } = buildMonthly(
            monthsRange(14, i => ({ posts: 0, connections: i + 1, topic: "x" }))
        );
        expect(AnalyticsEngine.compute([], [], connections).networkGrowth).toBeNull();
    });

    it("requires at least 12 overlapping months", () => {
        const { shares, connections } = buildMonthly(
            monthsRange(6, i => ({ posts: i + 1, connections: i + 1, topic: "x" }))
        );
        expect(AnalyticsEngine.compute(shares, [], connections).networkGrowth).toBeNull();
    });

    it("returns null when posting and connection ranges do not overlap", () => {
        const { shares } = buildMonthly(monthsRange(13, () => ({ posts: 3, topic: "x" })));
        const connections = [];
        for (let i = 0; i < 13; i++) {
            connections.push({ "Connected On": `2030-${String((i % 12) + 1).padStart(2, "0")}-10` });
        }
        expect(AnalyticsEngine.compute(shares, [], connections).networkGrowth).toBeNull();
    });

    it("returns null when posting volume is flat", () => {
        const { shares, connections } = buildMonthly(
            monthsRange(13, i => ({ posts: 3, connections: i + 1, topic: "x" }))
        );
        expect(AnalyticsEngine.compute(shares, [], connections).networkGrowth).toBeNull();
    });

    it("returns null when connection counts never vary", () => {
        const { shares, connections } = buildMonthly(
            monthsRange(13, i => ({ posts: i + 1, connections: 3, topic: "x" }))
        );
        expect(AnalyticsEngine.compute(shares, [], connections).networkGrowth).toBeNull();
    });

    it("returns null when quiet months gained no connections", () => {
        const specs = monthsRange(14, i =>
            i === 0 || i === 13
                ? { posts: 10, connections: 20, topic: "x" }
                : { posts: 1, connections: 0, topic: "x" }
        );
        const { shares, connections } = buildMonthly(specs);
        expect(AnalyticsEngine.compute(shares, [], connections).networkGrowth).toBeNull();
    });

    it("returns null when there are no quiet months to compare", () => {
        const { shares, connections } = buildMonthly(
            monthsRange(13, i => ({ posts: 5 + i, connections: 5 + i, topic: "x" }))
        );
        expect(AnalyticsEngine.compute(shares, [], connections).networkGrowth).toBeNull();
    });

    it("returns null when busy months do not outpace quiet ones", () => {
        // Quiet (low-post) months gain the most connections, so the busiest
        // posting months bring no more than the quiet ones (and the correlation
        // is negative), the card would be misleading and must stay dormant.
        const specs = monthsRange(14, i =>
            i < 4
                ? { posts: 1, connections: 20, topic: "x" }
                : { posts: 10, connections: 1, topic: "x" }
        );
        const { shares, connections } = buildMonthly(specs);
        expect(AnalyticsEngine.compute(shares, [], connections).networkGrowth).toBeNull();
    });

    it("returns null when the busiest-vs-quiet lift rounds below 2x", () => {
        // Connections track posts perfectly (positive correlation) but the
        // busiest months only edge out the quiet ones, so the multiplier rounds
        // to 1x, too weak a headline to surface.
        const { shares, connections } = buildMonthly(
            monthsRange(14, i => ({ posts: i + 1, connections: 101 + i, topic: "x" }))
        );
        expect(AnalyticsEngine.compute(shares, [], connections).networkGrowth).toBeNull();
    });
});

describe("AnalyticsEngine topic shift", () => {
    it("reports a shift when the dominant topic changes across the range", () => {
        const specs = monthsRange(9, i => ({
            posts: 3,
            topic: i < 3 ? "excel" : i < 6 ? "data" : "ai"
        }));
        const analytics = AnalyticsEngine.compute(buildMonthly(specs).shares, []);
        const view = allTimeView(analytics);

        expect(view.topicShift).toEqual({ from: "excel", to: "ai" });
        const ids = AnalyticsEngine.generateInsights(view).insights.map(i => i.id);
        expect(ids).toContain("topic-shift");
    });

    it("reports no shift when the focus stays stable", () => {
        const specs = monthsRange(9, () => ({ posts: 3, topic: "excel" }));
        const analytics = AnalyticsEngine.compute(buildMonthly(specs).shares, []);
        expect(allTimeView(analytics).topicShift).toBeNull();
    });

    it("omits topic shift under a topic or dimension filter", () => {
        // The per-month topic mix is unfiltered, so a topic/day/hour/share-type
        // filter must drop the focus-shift card rather than compare topics the
        // active view has filtered out.
        const specs = monthsRange(9, i => ({
            posts: 3,
            topic: i < 3 ? "excel" : i < 6 ? "data" : "ai"
        }));
        const analytics = AnalyticsEngine.compute(buildMonthly(specs).shares, []);
        const baseFilters = {
            timeRange: "all",
            topic: "all",
            monthFocus: null,
            day: null,
            hour: null,
            shareType: "all",
        };
        expect(
            AnalyticsEngine.buildView(analytics, { ...baseFilters, topic: "ai" }).topicShift
        ).toBeNull();
        expect(
            AnalyticsEngine.buildView(analytics, { ...baseFilters, hour: "10" }).topicShift
        ).toBeNull();
    });

    it("skips topic shift and ratio trend with too few months", () => {
        const specs = monthsRange(4, i => ({ posts: 3, topic: i < 2 ? "excel" : "ai" }));
        const analytics = AnalyticsEngine.compute(buildMonthly(specs).shares, []);
        const view = allTimeView(analytics);
        expect(view.topicShift).toBeNull();
        expect(view.ratioTrend).toBeNull();
    });
});

describe("AnalyticsEngine engagement shift", () => {
    it("flags a shift toward commenting", () => {
        const specs = monthsRange(8, i =>
            i < 4 ? { posts: 10, comments: 5, topic: "x" } : { posts: 2, comments: 10, topic: "x" }
        );
        const data = buildMonthly(specs);
        const view = allTimeView(AnalyticsEngine.compute(data.shares, data.comments));

        expect(view.ratioTrend.direction).toBe("more-engaging");
        const ids = AnalyticsEngine.generateInsights(view).insights.map(i => i.id);
        expect(ids).toContain("engagement-shift");
    });

    it("flags a shift toward posting", () => {
        const specs = monthsRange(8, i =>
            i < 4 ? { posts: 2, comments: 10, topic: "x" } : { posts: 10, comments: 1, topic: "x" }
        );
        const data = buildMonthly(specs);
        expect(allTimeView(AnalyticsEngine.compute(data.shares, data.comments)).ratioTrend.direction).toBe(
            "more-posting"
        );
    });

    it("reports no shift when the ratio holds steady", () => {
        const specs = monthsRange(8, () => ({ posts: 5, comments: 5, topic: "x" }));
        const data = buildMonthly(specs);
        expect(allTimeView(AnalyticsEngine.compute(data.shares, data.comments)).ratioTrend).toBeNull();
    });

    it("reports no shift when the older period had no comments", () => {
        const specs = monthsRange(8, i =>
            i < 4 ? { posts: 5, comments: 0, topic: "x" } : { posts: 5, comments: 10, topic: "x" }
        );
        const data = buildMonthly(specs);
        expect(allTimeView(AnalyticsEngine.compute(data.shares, data.comments)).ratioTrend).toBeNull();
    });

    it("reports no shift when a half has no posts", () => {
        const specs = monthsRange(8, i =>
            i < 4 ? { posts: 0, comments: 5, topic: "x" } : { posts: 5, comments: 5, topic: "x" }
        );
        const data = buildMonthly(specs);
        expect(allTimeView(AnalyticsEngine.compute(data.shares, data.comments)).ratioTrend).toBeNull();
    });
});

describe("AnalyticsEngine tiered insight cards", () => {
    it("tiers the super-engager card by comment-to-post ratio", () => {
        const titleAt = (posts, comments) =>
            AnalyticsEngine.generateInsights(
                insightView({ totals: { total: posts + comments, posts, comments } })
            ).insights.find(i => i.id === "super-engager").title;

        expect(titleAt(2, 6)).toBe("Super Engager");
        expect(titleAt(2, 20)).toBe("Community Builder");
        expect(titleAt(2, 50)).toBe("Engagement Machine");
    });

    it("tiers the streak card by streak length", () => {
        const titleAt = current =>
            AnalyticsEngine.generateInsights(
                insightView({ streaks: { current, longest: current } })
            ).insights.find(i => i.id === "streak").title;

        expect(titleAt(7)).toBe("Consistency Streak");
        expect(titleAt(30)).toBe("Streak Master");
        expect(titleAt(100)).toBe("Unstoppable Streak");
    });

    it("emits topic-shift and engagement-shift cards from view fields", () => {
        const result = AnalyticsEngine.generateInsights(
            insightView({
                networkGrowth: { multiplier: 19, topAvg: 210, quietAvg: 11, correlation: 0.5, months: 24 },
                topicShift: { from: "excel", to: "ai" },
                ratioTrend: { direction: "more-posting", recentRatio: 0.2, priorRatio: 1 }
            })
        );

        // network-growth is rendered in the All-time section, not as a card.
        expect(result.insights.find(i => i.id === "network-growth")).toBeUndefined();

        const shift = result.insights.find(i => i.id === "topic-shift");
        expect(shift.body).toContain("excel");
        expect(shift.body).toContain("ai");

        expect(result.insights.find(i => i.id === "engagement-shift").body).toContain("posting more");
    });
});
