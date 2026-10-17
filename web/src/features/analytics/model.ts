/* LinkedIn Analyzer - Shapes of the activity analytics data */

import type { ContentMix, TimelinePoint, TopicPoint } from "../../shared/ui/charts.js";

/** Activity counts */
export type ActivityTotals = { posts: number; comments: number; total: number };

/** One month of activity as compute() serializes it. */
export interface MonthBucket {
    /** Posts in the month */
    posts: number;
    /** Comments in the month */
    comments: number;
    /** Posts plus comments */
    total: number;
    /** Topic token counts */
    topics: Record<string, number>;
    /** Activity per weekday, Monday first (7 entries) */
    days: number[];
    /** Activity per hour of day (24 entries) */
    hours: number[];
    /** Activity per weekday and hour (7 x 24) */
    heatmap: number[][];
    /** Post counts per share type */
    shareTypes: ContentMix;
    /** "YYYY-MM-DD" keys with any activity */
    activeDays: string[];
}

/** A month bucket after the worker hydrates it, with its active days as a Set. */
export type HydratedMonthBucket = Omit<MonthBucket, "activeDays"> & { activeDays: Set<string> };

/** Serialized or hydrated bucket */
export type AnyMonthBucket = MonthBucket | HydratedMonthBucket;

/** One day of activity in the day index. */
export interface DayBucket {
    /** Posts that day */
    posts: number;
    /** Comments that day */
    comments: number;
    /** Posts plus comments */
    total: number;
    /** Post counts per share type */
    shareTypes: ContentMix;
}

/** Lifetime posting-versus-network-growth comparison. */
export interface NetworkGrowth {
    /** Pearson correlation, rounded to two places */
    correlation: number;
    /** Busiest-month average over quiet-month average */
    multiplier: number;
    /** Average new connections in the busiest posting months */
    topAvg: number;
    /** Average new connections in quiet months */
    quietAvg: number;
    /** Overlapping months compared */
    months: number;
}

/** The analytics base compute() produces: the aggregate the worker posts and storage keeps. */
export interface AnalyticsBase {
    /** Month buckets keyed "YYYY-MM" */
    months: Record<string, MonthBucket>;
    /** Day buckets keyed "YYYY-MM-DD" */
    dayIndex: Record<string, DayBucket>;
    /** "YYYY-MM-DD" keys with any activity */
    activeDays: string[];
    /** Latest activity (ms), or null when none */
    latestTimestamp: number | null;
    /** Earliest activity (ms), or null when none */
    earliestTimestamp: number | null;
    /** Network-growth comparison, when meaningful */
    networkGrowth: NetworkGrowth | null;
    /** Lifetime activity counts */
    totals: ActivityTotals;
}

/** The analytics base after the worker hydrates it from storage. */
export type HydratedAnalytics = Omit<AnalyticsBase, "months" | "activeDays"> & {
    months: Record<string, HydratedMonthBucket>;
    activeDays: Set<string>;
};

/** Filters as the UI sends them, before the worker normalizes them. */
export interface AnalyticsFilterInput {
    /** Time range key */
    timeRange?: string;
    /** Topic token, or "all" */
    topic?: string;
    /** Single "YYYY-MM" month to show */
    monthFocus?: string | null;
    /** Weekday index, Monday first */
    day?: unknown;
    /** Hour of day */
    hour?: unknown;
    /** Share type key ("text", "links", "media"), or "all" */
    shareType?: string;
}

/** Normalized filters buildView() applies. */
export interface AnalyticsFilters {
    /** Time range key, e.g. "1m", "12m", or "all" */
    timeRange: string;
    /** Topic token, or "all" */
    topic: string;
    /** Single "YYYY-MM" month to show, or null */
    monthFocus: string | null;
    /** Weekday index, Monday first, or null */
    day: number | null;
    /** Hour of day, or null */
    hour: number | null;
    /** Share type key ("text", "links", "media"), or "all" */
    shareType: string;
}

/** Activity trend between the older and recent halves of the timeline. */
export interface ActivityTrend {
    /** Percent change from the older half */
    percent: number;
    /** Trend direction */
    direction: "up" | "down" | "flat";
    /** Activity in the recent half */
    currentCount: number;
    /** Activity in the older half */
    previousCount: number;
}

/** Dominant topic change */
export type TopicShift = { from: string; to: string };

/** Comment-to-post ratio shift between the older and recent halves. */
export interface RatioTrend {
    /** Direction of the shift */
    direction: "more-engaging" | "more-posting";
    /** Recent comment-to-post ratio */
    recentRatio: number;
    /** Older comment-to-post ratio */
    priorRatio: number;
}

/** The filtered view buildView() produces. */
export interface AnalyticsView {
    /** Monthly or weekly activity points */
    timeline: TimelinePoint[];
    /** Largest unfiltered bucket value, at least 1 */
    timelineMax: number;
    /** Activity per weekday and hour (7 x 24) */
    heatmap: number[][];
    /** Top topics, most frequent first */
    topics: TopicPoint[];
    /** Post counts per share type */
    contentMix: ContentMix;
    /** Activity streaks in days */
    streaks: { current: number; longest: number };
    /** Busiest hour of day */
    peakHour: { hour: number; count: number };
    /** Busiest weekday */
    peakDay: { dayIndex: number; count: number };
    /** Activity trend, or null with too little data */
    trend: ActivityTrend | null;
    /** Dominant topic change, when one shows */
    topicShift?: TopicShift | null;
    /** Engagement style change, when one shows */
    ratioTrend?: RatioTrend | null;
    /** Lifetime network-growth comparison */
    networkGrowth?: NetworkGrowth | null;
    /** Filtered activity counts */
    totals: ActivityTotals;
}

/** One narrative insight card. */
export interface Insight {
    /** Stable insight ID */
    id: string;
    /** Card title */
    title: string;
    /** Card text */
    body: string;
    /** Icon name */
    icon: string;
    /** Accent class name */
    accent: string;
}

/** Cards and closing tip */
export type InsightsResult = { insights: Insight[]; tip: string | null };

/** The view payload the analytics worker posts: the view with its cache key, and its insights. */
export type AnalyticsViewPayload = {
    view: AnalyticsView & { key: string };
    insights: InsightsResult;
};

/** A month bucket while compute() fills it. */
export interface WorkingMonthBucket {
    /** Posts in the month */
    posts: number;
    /** Comments in the month */
    comments: number;
    /** Posts plus comments */
    total: number;
    /** Topic token counts */
    topics: Map<string, number>;
    /** Activity per weekday */
    days: number[];
    /** Activity per hour of day */
    hours: number[];
    /** Activity per weekday and hour */
    heatmap: number[][];
    /** Post counts per share type */
    shareTypes: ContentMix;
    /** Active "YYYY-MM-DD" keys */
    activeDays: Set<string>;
}

/** One included month's filtered counts, for the topic-shift and engagement-style cards. */
export type MonthlyStat = {
    key: string;
    posts: number;
    comments: number;
    topics: Record<string, number>;
};

/** Per-month filter ratios */
export type MonthMeta = { topicRatio: number; hourRatio: number };
