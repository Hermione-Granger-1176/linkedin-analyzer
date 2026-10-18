/* Local activity calculations. */

import { DAY_LABELS, MONTH_LABELS } from "./constants.js";
import {
    addDays,
    addMonths,
    endOfMonth,
    enumerateMonths,
    formatDateKey,
    formatWeekLabel,
    monthKeyToLabel,
    parseDateKey,
    parseLinkedInDate,
    startOfMonth,
    startOfWeek,
} from "./dates.js";
import { generateInsights } from "./insights.js";
import { average, pearson } from "./stats.js";
import { extractTopics } from "./text.js";

/** @typedef {import("../cleaning/cleaner.js").CleanedRow} CleanedRow */
/** @typedef {import("../../shared/ui/charts.js").ContentMix} ContentMix */
/** @typedef {import("../../shared/ui/charts.js").TimelinePoint} TimelinePoint */
/** @typedef {import("../../shared/ui/charts.js").TopicPoint} TopicPoint */

/** @typedef {import("./model.ts").ActivityTotals} ActivityTotals */
/** @typedef {import("./model.ts").MonthBucket} MonthBucket */
/** @typedef {import("./model.ts").HydratedMonthBucket} HydratedMonthBucket */
/** @typedef {import("./model.ts").AnyMonthBucket} AnyMonthBucket */
/** @typedef {import("./model.ts").DayBucket} DayBucket */
/** @typedef {import("./model.ts").NetworkGrowth} NetworkGrowth */
/** @typedef {import("./model.ts").AnalyticsBase} AnalyticsBase */
/** @typedef {import("./model.ts").HydratedAnalytics} HydratedAnalytics */
/** @typedef {import("./model.ts").AnalyticsFilterInput} AnalyticsFilterInput */
/** @typedef {import("./model.ts").AnalyticsFilters} AnalyticsFilters */
/** @typedef {import("./model.ts").ActivityTrend} ActivityTrend */
/** @typedef {import("./model.ts").TopicShift} TopicShift */
/** @typedef {import("./model.ts").RatioTrend} RatioTrend */
/** @typedef {import("./model.ts").AnalyticsView} AnalyticsView */
/** @typedef {import("./model.ts").Insight} Insight */
/** @typedef {import("./model.ts").InsightsResult} InsightsResult */
/** @typedef {import("./model.ts").AnalyticsViewPayload} AnalyticsViewPayload */
/** @typedef {import("./model.ts").WorkingMonthBucket} WorkingMonthBucket */
/** @typedef {import("./model.ts").MonthlyStat} MonthlyStat */
/** @typedef {import("./model.ts").MonthMeta} MonthMeta */
/** @typedef {NonNullable<ReturnType<typeof parseLinkedInDate>>} DateInfo */

/**
 * Running totals a view sums month buckets into.
 * @typedef {object} ViewTotals
 * @property {number} posts - Posts in the filtered months
 * @property {number} comments - Comments in the filtered months
 * @property {number[][]} heatmap - Day-by-hour activity counts
 * @property {Map<string, number>} topicCounts - Mentions per topic
 * @property {ContentMix} contentMix - Share counts by type
 * @property {number[]} hourCounts - Activity per hour of the day
 * @property {number[]} dayCounts - Activity per weekday
 * @property {Set<string>} activeDays - "YYYY-MM-DD" keys with activity
 */

/**
 * Indexes dated events by month and day, then builds the analytics base.
 * @typedef {object} ActivityAccumulator
 * @property {(dateInfo: DateInfo, row: CleanedRow) => void} recordShare - Count one share
 * @property {(dateInfo: DateInfo, row: CleanedRow) => void} recordComment - Count one comment
 * @property {(connectionsData: CleanedRow[]|null|undefined) => AnalyticsBase} build - Build the serializable base
 */

export const AnalyticsEngine = (() => {
    "use strict";

    const WEEKLY_TIME_RANGES = new Set(["1m", "3m"]);
    // Minimum overlapping months required to display the network-growth comparison.
    const MIN_GROWTH_MONTHS = 12;
    // Number of top-posting months averaged for the network-growth comparison.
    const GROWTH_TOP_MONTHS = 10;
    // Months with this many posts or fewer count as "quiet" for the comparison.
    const GROWTH_QUIET_MAX_POSTS = 2;
    // A focus shift / engagement-style card needs at least this many active
    // months so the first/last buckets are not built from a single data point.
    const MIN_SHIFT_MONTHS = 6;
    /** @type {Readonly<Record<string, keyof ContentMix | undefined>>} */
    const SHARE_TYPE_MAP = Object.freeze({ text: "textOnly", links: "links", media: "media" });
    // Callers pick the key from which of day and hour are set, so the casts hold.
    /** @typedef {(bucket: AnyMonthBucket, filters: AnalyticsFilters) => number} DimensionCount */
    /** @type {Readonly<Record<string, DimensionCount>>} */
    const DIMENSION_COUNT_BY_KEY = Object.freeze({
        both: (bucket, filters) => {
            const day = /** @type {number} */ (filters.day);
            const hour = /** @type {number} */ (filters.hour);
            return (bucket.heatmap[day] && bucket.heatmap[day][hour]) || 0;
        },
        day: (bucket, filters) => bucket.days[/** @type {number} */ (filters.day)] || 0,
        hour: (bucket, filters) => bucket.hours[/** @type {number} */ (filters.hour)] || 0,
    });

    /**
     * Create the accumulator that indexes dated events by month and day.
     * Indexing by month and day lets view building cost O(months) instead of
     * O(events).
     * @returns {ActivityAccumulator}
     */
    function createActivityAccumulator() {
        // Pre-aggregated indices
        /** @type {Map<string, WorkingMonthBucket>} */
        const monthIndex = new Map();
        /** @type {Set<string>} */
        const activeDays = new Set();
        /** @type {Map<string, DayBucket>} */
        const dayIndex = new Map();

        let latestTimestamp = 0;
        let earliestTimestamp = Infinity;
        let totalPosts = 0;
        let totalComments = 0;

        /**
         * Create the month bucket when needed.
         * @param {string} monthKey - "YYYY-MM" month key
         * @returns {WorkingMonthBucket}
         */
        function getMonthBucket(monthKey) {
            if (!monthIndex.has(monthKey)) {
                monthIndex.set(monthKey, {
                    posts: 0,
                    comments: 0,
                    total: 0,
                    topics: new Map(),
                    days: Array(7).fill(0),
                    hours: Array(24).fill(0),
                    heatmap: Array.from({ length: 7 }, () => Array(24).fill(0)),
                    shareTypes: { textOnly: 0, links: 0, media: 0 },
                    activeDays: new Set(),
                });
            }
            return /** @type {WorkingMonthBucket} */ (monthIndex.get(monthKey));
        }

        /**
         * Create the day bucket when needed.
         * @param {string} dateKey - "YYYY-MM-DD" date key
         * @returns {DayBucket}
         */
        function getDayBucket(dateKey) {
            if (!dayIndex.has(dateKey)) {
                dayIndex.set(dateKey, {
                    posts: 0,
                    comments: 0,
                    total: 0,
                    shareTypes: { textOnly: 0, links: 0, media: 0 },
                });
            }
            return /** @type {DayBucket} */ (dayIndex.get(dateKey));
        }

        /**
         * Count one dated event in the global stats and its month and day buckets.
         * @param {DateInfo} dateInfo - Parsed event date
         * @param {"posts"|"comments"} kind - Which count the event adds to
         * @param {Iterable<string>} topics - Topics found in the event text
         * @returns {{bucket: WorkingMonthBucket, dayBucket: DayBucket}} The buckets it was counted in
         */
        function recordEvent(dateInfo, kind, topics) {
            const { timestamp, monthKey, dayIndex: dayIdx, hour, dateKey } = dateInfo;

            // Update global stats
            if (kind === "posts") {
                totalPosts++;
            } else {
                totalComments++;
            }
            latestTimestamp = Math.max(latestTimestamp, timestamp);
            earliestTimestamp = Math.min(earliestTimestamp, timestamp);
            activeDays.add(dateKey);

            // Month bucket
            const bucket = getMonthBucket(monthKey);
            bucket[kind]++;
            bucket.total++;
            bucket.days[dayIdx]++;
            bucket.hours[hour]++;
            bucket.heatmap[dayIdx][hour]++;
            bucket.activeDays.add(dateKey);

            const dayBucket = getDayBucket(dateKey);
            dayBucket[kind]++;
            dayBucket.total++;

            for (const topic of topics) {
                bucket.topics.set(topic, (bucket.topics.get(topic) || 0) + 1);
            }
            return { bucket, dayBucket };
        }

        /**
         * Count a share, including how much of it is text, links, or media.
         * @param {DateInfo} dateInfo - Parsed share date
         * @param {CleanedRow} row - Cleaned shares row
         */
        function recordShare(dateInfo, row) {
            const hasMedia = Boolean(String(row.MediaUrl || "").trim());
            const hasLink = Boolean(String(row.SharedUrl || "").trim());
            const { bucket, dayBucket } = recordEvent(
                dateInfo,
                "posts",
                extractTopics(row.ShareCommentary),
            );

            const shareTypeKey = hasMedia ? "media" : hasLink ? "links" : "textOnly";
            bucket.shareTypes[shareTypeKey]++;
            dayBucket.shareTypes[shareTypeKey]++;
        }

        /**
         * Count a comment.
         * @param {DateInfo} dateInfo - Parsed comment date
         * @param {CleanedRow} row - Cleaned comments row
         */
        function recordComment(dateInfo, row) {
            recordEvent(dateInfo, "comments", extractTopics(row.Message));
        }

        /**
         * Convert the working indices to the serializable analytics base.
         * @param {CleanedRow[]|null|undefined} connectionsData - Cleaned connections rows
         * @returns {AnalyticsBase}
         */
        function build(connectionsData) {
            // Convert month index to serializable format
            const months = Object.fromEntries(
                Array.from(monthIndex, ([key, bucket]) => [
                    key,
                    {
                        posts: bucket.posts,
                        comments: bucket.comments,
                        total: bucket.total,
                        topics: Object.fromEntries(bucket.topics),
                        days: bucket.days,
                        hours: bucket.hours,
                        heatmap: bucket.heatmap,
                        shareTypes: bucket.shareTypes,
                        activeDays: Array.from(bucket.activeDays),
                    },
                ]),
            );

            // Skip the full pass over connection rows entirely when there is no
            // posting activity to correlate them against, so the card cannot fire.
            const networkGrowth =
                monthIndex.size === 0
                    ? null
                    : computeNetworkGrowth(monthIndex, buildMonthlyConnections(connectionsData));

            return {
                months,
                dayIndex: Object.fromEntries(dayIndex),
                activeDays: Array.from(activeDays),
                latestTimestamp: latestTimestamp || null,
                earliestTimestamp: earliestTimestamp === Infinity ? null : earliestTimestamp,
                networkGrowth,
                totals: {
                    posts: totalPosts,
                    comments: totalComments,
                    total: totalPosts + totalComments,
                },
            };
        }

        return { recordShare, recordComment, build };
    }

    /**
     * Pre-compute aggregates during initial load.
     * @param {CleanedRow[]|null|undefined} sharesData - Cleaned shares rows
     * @param {CleanedRow[]|null|undefined} commentsData - Cleaned comments rows
     * @param {CleanedRow[]|null|undefined} connectionsData - Cleaned connections rows
     * @returns {AnalyticsBase} Analytics aggregates and indices
     */
    function compute(sharesData, commentsData, connectionsData) {
        const activity = createActivityAccumulator();

        for (const row of Array.isArray(sharesData) ? sharesData : []) {
            const dateInfo = parseLinkedInDate(row.Date);
            if (dateInfo) {
                activity.recordShare(dateInfo, row);
            }
        }
        for (const row of Array.isArray(commentsData) ? commentsData : []) {
            const dateInfo = parseLinkedInDate(row.Date);
            if (dateInfo) {
                activity.recordComment(dateInfo, row);
            }
        }

        return activity.build(connectionsData);
    }

    /**
     * Bucket cleaned connection rows into "YYYY-MM" -> new-connection counts.
     * The cleaner emits "Connected On" as an ISO "YYYY-MM-DD" string, so the
     * month key is the first seven characters once both parts are present.
     * @param {CleanedRow[]|null|undefined} connectionsData - Cleaned connections rows
     * @returns {Map<string, number>} Monthly new-connection counts
     */
    function buildMonthlyConnections(connectionsData) {
        /** @type {Map<string, number>} */
        const monthly = new Map();
        if (!Array.isArray(connectionsData)) {
            return monthly;
        }
        for (const row of connectionsData) {
            const value = row && row["Connected On"];
            if (!value || typeof value !== "string") {
                continue;
            }
            const [year, month] = value.split("-");
            if (!year || !month) {
                continue;
            }
            const monthKey = `${year}-${month}`;
            monthly.set(monthKey, (monthly.get(monthKey) || 0) + 1);
        }
        return monthly;
    }

    /**
     * Compare monthly posting volume with new-connection counts.
     * Return null unless there is enough overlap and posting variance.
     * @param {Map<string, {posts: number}>} monthIndex - Internal month buckets with post counts
     * (non-empty)
     * @param {Map<string, number>} monthlyConnections - Monthly new-connection counts
     * @returns {NetworkGrowth|null}
     */
    function computeNetworkGrowth(monthIndex, monthlyConnections) {
        // Callers only invoke this with a non-empty monthIndex.
        if (monthlyConnections.size === 0) {
            return null;
        }

        const postKeys = Array.from(monthIndex.keys()).sort();
        const connectionKeys = Array.from(monthlyConnections.keys()).sort();
        // The overlap is the later of the two start months to the earlier of the
        // two end months, the window where both series have real coverage.
        const start = postKeys[0] > connectionKeys[0] ? postKeys[0] : connectionKeys[0];
        const lastPost = postKeys[postKeys.length - 1];
        const lastConnection = connectionKeys[connectionKeys.length - 1];
        const end = lastPost < lastConnection ? lastPost : lastConnection;
        if (start > end) {
            return null;
        }

        const months = enumerateMonths(start, end);
        if (months.length < MIN_GROWTH_MONTHS) {
            return null;
        }

        const entries = months.map((monthKey) => {
            const bucket = monthIndex.get(monthKey);
            return {
                posts: bucket ? bucket.posts : 0,
                connections: monthlyConnections.get(monthKey) || 0,
            };
        });

        const posts = entries.map((entry) => entry.posts);
        // Without posting variance the correlation is undefined and the
        // top-vs-quiet comparison is meaningless, so require a real spread.
        if (Math.max(...posts) === Math.min(...posts)) {
            return null;
        }

        const correlation = pearson(
            posts,
            entries.map((entry) => entry.connections),
        );
        if (correlation === null) {
            return null;
        }

        const quietMonths = entries.filter((entry) => entry.posts <= GROWTH_QUIET_MAX_POSTS);
        const topMonths = entries
            .slice()
            .sort((a, b) => b.posts - a.posts)
            .slice(0, GROWTH_TOP_MONTHS);
        if (!quietMonths.length || !topMonths.length) {
            return null;
        }

        // Round the averages first and derive the multiplier from those same
        // displayed values, so the headline ratio always matches the "X vs Y"
        // numbers shown in the card.
        const quietAvg = Math.round(average(quietMonths.map((entry) => entry.connections)));
        const topAvg = Math.round(average(topMonths.map((entry) => entry.connections)));
        const multiplier = quietAvg > 0 ? Math.round(topAvg / quietAvg) : 0;
        // Display the comparison only with positive correlation and a multiplier
        // above one. These conditions do not establish that posting caused growth.
        if (correlation <= 0 || multiplier < 2) {
            return null;
        }

        return {
            correlation: Math.round(correlation * 100) / 100,
            multiplier,
            topAvg,
            quietAvg,
            months: months.length,
        };
    }

    /**
     * Get the topic filter ratio for a month bucket. Returns the fraction of activity matching the selected topic.
     * @param {AnyMonthBucket} bucket - Month bucket with topics and total count.
     * @param {AnalyticsFilters} filters - Active filters including topic.
     * @returns {number} Ratio between 0 and 1.
     */
    function getTopicRatio(bucket, filters) {
        if (!filters.topic || filters.topic === "all") {
            return 1;
        }
        // Existing buckets have a positive total. Return zero for malformed data.
        /* v8 ignore next 3 */
        if (!bucket.total) {
            return 0;
        }
        const topicCount = bucket.topics[filters.topic] || 0;
        return topicCount / bucket.total;
    }

    /**
     * Return the fraction of monthly activity matching the hour, day, or both.
     * @param {AnyMonthBucket} bucket - Month bucket with hours, days, and heatmap arrays.
     * @param {AnalyticsFilters} filters - Active filters including hour and day.
     * @returns {number} Ratio between 0 and 1.
     */
    function getHourRatio(bucket, filters) {
        if (filters.hour === null || filters.hour === undefined) {
            return 1;
        }
        if (filters.day !== null && filters.day !== undefined) {
            const dayTotal = bucket.days[filters.day] || 0;
            const dayHour = bucket.heatmap[filters.day][filters.hour] || 0;
            return dayTotal > 0 ? dayHour / dayTotal : 0;
        }
        const hourTotal = bucket.hours[filters.hour] || 0;
        // Existing buckets have a positive total. Return zero for malformed data.
        /* v8 ignore next */
        return bucket.total > 0 ? hourTotal / bucket.total : 0;
    }

    /**
     * Apply all active filters (topic, share type, day, hour) to a month bucket and return adjusted counts.
     * @param {AnyMonthBucket} bucket - Month bucket with posts, comments, total, and sub-indices.
     * @param {AnalyticsFilters} filters - Active filters to apply.
     * @param {number} topicRatio - Pre-computed topic ratio for this bucket.
     * @param {boolean} hasDay - Whether a day filter is active.
     * @param {boolean} hasHour - Whether an hour filter is active.
     * @returns {{ monthPosts: number, monthComments: number, monthTotal: number, useMonth: boolean }} Filtered counts.
     */
    function applyMonthFilters(bucket, filters, topicRatio, hasDay, hasHour) {
        let monthPosts = bucket.posts;
        let monthComments = bucket.comments;
        let monthTotal = bucket.total;
        let useMonth = true;

        if (filters.topic && filters.topic !== "all") {
            const topicCount = bucket.topics[filters.topic] || 0;
            if (topicCount === 0) {
                useMonth = false;
            } else {
                monthPosts = Math.round(bucket.posts * topicRatio);
                monthComments = Math.round(bucket.comments * topicRatio);
                monthTotal = topicCount;
            }
        }

        if (filters.shareType && filters.shareType !== "all" && useMonth) {
            const typeKey = SHARE_TYPE_MAP[filters.shareType];
            if (typeKey) {
                // Scale the (possibly topic-adjusted) post count by the share of
                // posts that are this type so a topic + shareType filter
                // intersects, instead of the raw shareType count overwriting the
                // topic adjustment. With no topic filter monthPosts === bucket.posts,
                // so this reduces to bucket.shareTypes[typeKey] as before.
                const shareTypeRatio =
                    bucket.posts > 0 ? bucket.shareTypes[typeKey] / bucket.posts : 0;
                monthPosts = Math.round(monthPosts * shareTypeRatio);
            }
            monthComments = 0;
            monthTotal = monthPosts;
        }

        // Apply day/hour dimensional filter. The day/hour/heatmap counters tally
        // ALL activity in the month, so the fraction must be taken over the
        // month's full activity (bucket.total). Using the already-narrowed
        // monthTotal as the denominator lets the ratio exceed 1 and inflates the
        // counts when a topic or shareType filter is also active.
        const dimensionKey = hasDay && hasHour ? "both" : hasDay ? "day" : hasHour ? "hour" : null;
        if (useMonth && dimensionKey) {
            const filterCount = DIMENSION_COUNT_BY_KEY[dimensionKey](bucket, filters);
            // Existing buckets have a positive total. Return zero for malformed data.
            /* v8 ignore next */
            const ratio = bucket.total > 0 ? filterCount / bucket.total : 0;
            monthPosts = Math.round(monthPosts * ratio);
            monthComments = Math.round(monthComments * ratio);
            monthTotal = Math.round(monthTotal * ratio);
        }

        return { monthPosts, monthComments, monthTotal, useMonth };
    }

    /**
     * Get the list of "YYYY-MM" month keys that fall within the specified time range.
     * @param {number|null} earliestTimestamp - Earliest event timestamp in ms.
     * @param {number|null} latestTimestamp - Latest event timestamp in ms.
     * @param {string} rangeKey - Time range key, e.g. "1m", "3m", "12m", or "all".
     * @param {string|null} monthFocus - If set, return only this single month key.
     * @returns {string[]} Array of month keys in chronological order.
     */
    function getMonthKeysInRange(earliestTimestamp, latestTimestamp, rangeKey, monthFocus) {
        if (!latestTimestamp) {
            return [];
        }

        if (monthFocus) {
            return [monthFocus];
        }

        const latestDate = new Date(latestTimestamp);
        const latestMonth = startOfMonth(latestDate);

        if (rangeKey === "all") {
            const startDate = earliestTimestamp
                ? startOfMonth(new Date(earliestTimestamp))
                : latestMonth;
            const startKey = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, "0")}`;
            const endKey = `${latestMonth.getFullYear()}-${String(latestMonth.getMonth() + 1).padStart(2, "0")}`;
            return enumerateMonths(startKey, endKey);
        }

        const monthCount = Number(rangeKey.replace("m", ""));
        if (!monthCount) {
            return [];
        }

        const keys = [];
        for (let i = 0; i < monthCount; i++) {
            const d = addMonths(latestMonth, -i);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
            keys.push(key);
        }
        return keys.reverse();
    }

    /**
     * Create the running totals a view sums month buckets into.
     * @returns {ViewTotals}
     */
    function createViewTotals() {
        return {
            posts: 0,
            comments: 0,
            heatmap: Array.from({ length: 7 }, () => Array(24).fill(0)),
            topicCounts: new Map(),
            contentMix: { textOnly: 0, links: 0, media: 0 },
            hourCounts: Array(24).fill(0),
            dayCounts: Array(7).fill(0),
            activeDays: new Set(),
        };
    }

    /**
     * Add one month bucket's heatmap, hours, content mix, topics, and active days to the totals.
     * @param {ViewTotals} totals - Running totals
     * @param {AnyMonthBucket} bucket - Month bucket to add
     */
    function addBucketToTotals(totals, bucket) {
        // Aggregate heatmap
        for (let d = 0; d < 7; d++) {
            const targetDay = totals.heatmap[d];
            const sourceDay = bucket.heatmap[d];
            for (let h = 0; h < 24; h++) {
                targetDay[h] += sourceDay[h];
            }
            totals.dayCounts[d] += bucket.days[d];
        }
        for (let h = 0; h < 24; h++) {
            totals.hourCounts[h] += bucket.hours[h];
        }

        // Content mix
        totals.contentMix.textOnly += bucket.shareTypes.textOnly;
        totals.contentMix.links += bucket.shareTypes.links;
        totals.contentMix.media += bucket.shareTypes.media;

        // Topics
        for (const [topic, count] of Object.entries(bucket.topics)) {
            totals.topicCounts.set(topic, (totals.topicCounts.get(topic) || 0) + count);
        }

        // Active days
        for (const day of bucket.activeDays) {
            totals.activeDays.add(day);
        }
    }

    /**
     * Build a view from monthly aggregates in O(months) time.
     * @param {AnalyticsBase|HydratedAnalytics|null} analytics - Pre-computed analytics payload
     * @param {AnalyticsFilters} filters - Active filter state
     * @returns {AnalyticsView|null} View model or null when no analytics
     */
    function buildView(analytics, filters) {
        if (!analytics || !analytics.months) {
            return null;
        }

        const { months, latestTimestamp, earliestTimestamp, dayIndex } = analytics;
        const monthKeys = getMonthKeysInRange(
            earliestTimestamp,
            latestTimestamp,
            filters.timeRange,
            filters.monthFocus,
        );

        if (!monthKeys.length) {
            return createEmptyView();
        }

        // Aggregate from pre-computed month buckets
        const totals = createViewTotals();
        /** @type {TimelinePoint[]} */
        const timeline = [];
        let timelineMax = 1;
        /** @type {Record<string, MonthMeta>} */
        const monthMeta = {};
        // Per-included-month posts/comments/topics, used after the loop to derive
        // the topic-shift and engagement-style cards over the active range.
        /** @type {MonthlyStat[]} */
        const monthlyStats = [];
        const useWeeklyTimeline = Boolean(dayIndex) && WEEKLY_TIME_RANGES.has(filters.timeRange);
        const hasDay = filters.day !== null && filters.day !== undefined;
        const hasHour = filters.hour !== null && filters.hour !== undefined;

        /**
         * Add a month's point to the timeline, unless the weekly timeline replaces it.
         * @param {string} monthKey - "YYYY-MM" month key
         * @param {number} value - Activity count for the month
         */
        function addMonthPoint(monthKey, value) {
            if (!useWeeklyTimeline) {
                timeline.push({ key: monthKey, label: monthKeyToLabel(monthKey), value });
            }
        }

        for (const monthKey of monthKeys) {
            const bucket = months[monthKey];
            const baselineValue = bucket ? bucket.total : 0;
            if (!useWeeklyTimeline) {
                timelineMax = Math.max(timelineMax, baselineValue);
            }
            if (!bucket) {
                addMonthPoint(monthKey, 0);
                continue;
            }

            const topicRatio = getTopicRatio(bucket, filters);
            const hourRatio = getHourRatio(bucket, filters);
            monthMeta[monthKey] = {
                topicRatio,
                hourRatio,
            };

            const { monthPosts, monthComments, monthTotal, useMonth } = applyMonthFilters(
                bucket,
                filters,
                topicRatio,
                hasDay,
                hasHour,
            );

            if (!useMonth || monthTotal === 0) {
                addMonthPoint(monthKey, 0);
                continue;
            }

            totals.posts += monthPosts;
            totals.comments += monthComments;

            monthlyStats.push({
                key: monthKey,
                posts: monthPosts,
                comments: monthComments,
                topics: bucket.topics,
            });

            addBucketToTotals(totals, bucket);
            addMonthPoint(monthKey, monthTotal);
        }

        if (useWeeklyTimeline) {
            const weekly = buildWeeklyTimeline(dayIndex, monthKeys, filters, monthMeta);
            timeline.push(...weekly.timeline);
            timelineMax = weekly.timelineMax;
        }

        // Sort and limit topics
        const topicsArray = Array.from(totals.topicCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 12)
            .map(([topic, count]) => ({ topic, count }));

        // Calculate peaks
        const peakHour = getPeakFromArray(totals.hourCounts);
        const peakDay = getPeakFromArray(totals.dayCounts);

        // Calculate streaks
        const streaks = calculateStreaksFromDays(totals.activeDays);

        // Calculate trend
        const trend = computeTrendFromTimeline(timeline);

        // topicShift reads each month's unfiltered topic mix, so it is only
        // coherent when no topic/share-type/day/hour filter is active. A time
        // range merely selects which months to compare, which stays meaningful.
        const topicComparable =
            filters.topic === "all" && filters.shareType === "all" && !hasDay && !hasHour;

        return {
            timeline,
            timelineMax,
            heatmap: totals.heatmap,
            topics: topicsArray,
            contentMix: totals.contentMix,
            streaks,
            peakHour: { hour: peakHour.index, count: peakHour.value },
            peakDay: { dayIndex: peakDay.index, count: peakDay.value },
            trend,
            topicShift: topicComparable ? computeTopicShift(monthlyStats) : null,
            ratioTrend: computeRatioTrend(monthlyStats),
            // The network-growth correlation is a lifetime stat computed once over
            // the full dataset overlap window. It is carried on every view (same
            // value regardless of filters) and rendered in the All-time section,
            // not as one of the filter-driven cards.
            networkGrowth: analytics.networkGrowth || null,
            totals: {
                posts: totals.posts,
                comments: totals.comments,
                total: totals.posts + totals.comments,
            },
        };
    }

    /**
     * Find the most frequent topic across a slice of monthly stats.
     * @param {Array<{topics: Record<string, number>}>} monthlyStats - Per-month stats slice
     * @returns {string|null} Top topic token, or null when none
     */
    function topTopicOf(monthlyStats) {
        /** @type {Map<string, number>} */
        const counts = new Map();
        for (const month of monthlyStats) {
            // Normalized month stats include topics. Treat missing topics as empty.
            /* v8 ignore next */
            for (const [topic, count] of Object.entries(month.topics || {})) {
                counts.set(topic, (counts.get(topic) || 0) + count);
            }
        }
        let bestTopic = null;
        let bestCount = 0;
        for (const [topic, count] of counts) {
            if (count > bestCount) {
                bestTopic = topic;
                bestCount = count;
            }
        }
        return bestTopic;
    }

    /**
     * Detect whether the dominant topic changed from the first third of the
     * active range to the last third. Returns null when the range is too short
     * or the top topic is unchanged.
     * @param {Array<{topics: Record<string, number>}>} monthlyStats - Per-month stats, oldest first
     * @returns {TopicShift|null}
     */
    function computeTopicShift(monthlyStats) {
        if (monthlyStats.length < MIN_SHIFT_MONTHS) {
            return null;
        }
        const third = Math.floor(monthlyStats.length / 3);
        const firstTop = topTopicOf(monthlyStats.slice(0, third));
        const lastTop = topTopicOf(monthlyStats.slice(monthlyStats.length - third));
        if (!firstTop || !lastTop || firstTop === lastTop) {
            return null;
        }
        return { from: firstTop, to: lastTop };
    }

    /**
     * Sum a numeric field across monthly stats.
     * @param {Array<{posts: number, comments: number}>} monthlyStats - Per-month stats slice
     * @param {"posts"|"comments"} field - Field name to sum
     * @returns {number}
     */
    function sumField(monthlyStats, field) {
        return monthlyStats.reduce((sum, month) => sum + month[field], 0);
    }

    /**
     * Detect a shift in comment-to-post ratio between the older and recent
     * halves of the active range. Returns null when there is too little data or
     * the ratio holds steady.
     * @param {Array<{posts: number, comments: number}>} monthlyStats - Per-month stats, oldest first
     * @returns {RatioTrend|null}
     */
    function computeRatioTrend(monthlyStats) {
        if (monthlyStats.length < MIN_SHIFT_MONTHS) {
            return null;
        }
        const half = Math.floor(monthlyStats.length / 2);
        const older = monthlyStats.slice(0, half);
        const recent = monthlyStats.slice(monthlyStats.length - half);
        const olderPosts = sumField(older, "posts");
        const recentPosts = sumField(recent, "posts");
        if (olderPosts === 0 || recentPosts === 0) {
            return null;
        }
        const priorRatio = sumField(older, "comments") / olderPosts;
        const recentRatio = sumField(recent, "comments") / recentPosts;
        if (priorRatio === 0) {
            return null;
        }
        if (recentRatio >= priorRatio * 1.5) {
            return { direction: "more-engaging", recentRatio, priorRatio };
        }
        if (recentRatio <= priorRatio * 0.6) {
            return { direction: "more-posting", recentRatio, priorRatio };
        }
        return null;
    }

    /**
     * Lay out one empty timeline slot per week the target months touch.
     * @param {string[]} targetMonths - Non-empty array of "YYYY-MM" month keys, oldest first.
     * @returns {{ weeks: TimelinePoint[], weekIndex: Map<string, number>, startKey: string, endKey: string }}
     * The slots, each slot's position by week key, and the first and last day keys of the months.
     */
    function createWeekSlots(targetMonths) {
        const [startYear, startMonth] = targetMonths[0].split("-").map(Number);
        const [endYear, endMonth] = targetMonths[targetMonths.length - 1].split("-").map(Number);
        const rangeStart = new Date(startYear, startMonth - 1, 1);
        const rangeEnd = endOfMonth(new Date(endYear, endMonth - 1, 1));
        const startWeek = startOfWeek(rangeStart);
        const endWeek = startOfWeek(rangeEnd);

        /** @type {TimelinePoint[]} */
        const weeks = [];
        /** @type {Map<string, number>} */
        const weekIndex = new Map();
        for (let cursor = startWeek; cursor <= endWeek; cursor = addDays(cursor, 7)) {
            const key = formatDateKey(cursor);
            weekIndex.set(key, weeks.length);
            weeks.push({
                key,
                monthKey: key.slice(0, 7),
                label: formatWeekLabel(cursor),
                value: 0,
            });
        }
        return {
            weeks,
            weekIndex,
            startKey: formatDateKey(rangeStart),
            endKey: formatDateKey(rangeEnd),
        };
    }

    /**
     * Apply the active filters to one day's activity.
     * @param {DayBucket} entry - The day's counts.
     * @param {string} dateKey - "YYYY-MM-DD" key of the day.
     * @param {Date} date - The day.
     * @param {AnalyticsFilters} filters - Active filters (shareType, day, topic, hour).
     * @param {Record<string, MonthMeta>} monthMeta - Per-month topicRatio and hourRatio.
     * @returns {number} The day's filtered activity, which may be fractional.
     */
    function filteredDayValue(entry, dateKey, date, filters, monthMeta) {
        const hasDay = filters.day !== null && filters.day !== undefined;
        const hasHour = filters.hour !== null && filters.hour !== undefined;

        // Activity days normally have a positive total. Use zero for malformed data.
        /* v8 ignore next */
        let value = entry.total || 0;
        const typeKey = SHARE_TYPE_MAP[filters.shareType];
        if (typeKey) {
            /* v8 ignore next */
            value = entry.shareTypes ? entry.shareTypes[typeKey] : 0;
        }

        if (hasDay) {
            const dayIndexValue = (date.getDay() + 6) % 7;
            if (dayIndexValue !== filters.day) {
                value = 0;
            }
        }

        if (filters.topic && filters.topic !== "all") {
            const meta = monthMeta[dateKey.slice(0, 7)];
            // Activity days normally have month metadata. Use zero when it is missing.
            /* v8 ignore next */
            const ratio = meta ? meta.topicRatio : 0;
            value *= ratio;
        }

        if (hasHour) {
            const meta = monthMeta[dateKey.slice(0, 7)];
            // Activity days normally have month metadata. Use zero when it is missing.
            /* v8 ignore next */
            const ratio = meta ? meta.hourRatio : 0;
            value *= ratio;
        }
        return value;
    }

    /**
     * Build a weekly timeline from the day-level index for the given target months, applying all active filters.
     * @param {Record<string, DayBucket>} dayIndex - Day-level index mapping dateKey to daily
     * counts.
     * @param {string[]} targetMonths - Array of "YYYY-MM" month keys to include.
     * @param {AnalyticsFilters} filters - Active filters (shareType, day, topic, hour).
     * @param {Record<string, MonthMeta>} monthMeta - Per-month topicRatio and hourRatio.
     * @returns {{ timeline: TimelinePoint[], timelineMax: number }} Weekly timeline entries and
     * max baseline value.
     */
    function buildWeeklyTimeline(dayIndex, targetMonths, filters, monthMeta) {
        /* v8 ignore next 3 */
        if (!dayIndex || !targetMonths.length) {
            return { timeline: [], timelineMax: 1 };
        }

        const { weeks, weekIndex, startKey, endKey } = createWeekSlots(targetMonths);
        const baselineTotals = new Array(weeks.length).fill(0);

        for (const [dateKey, entry] of Object.entries(dayIndex)) {
            if (dateKey < startKey || dateKey > endKey) {
                /* v8 ignore next */
                continue;
            }
            const date = parseDateKey(dateKey);
            // Date keys come from formatDateKey. Skip an invalid key.
            /* v8 ignore next 3 */
            if (date === null) {
                continue;
            }
            const weekKey = formatDateKey(startOfWeek(date));
            const index = weekIndex.get(weekKey);
            // Each in-range date maps to a bucket. Skip a missing map entry.
            /* v8 ignore next 3 */
            if (index === undefined) {
                continue;
            }

            // Activity days normally have a positive total. Use zero for malformed data.
            /* v8 ignore next */
            baselineTotals[index] += entry.total || 0;
            weeks[index].value += filteredDayValue(entry, dateKey, date, filters, monthMeta);
        }

        weeks.forEach((week) => {
            week.value = Math.round(week.value);
        });

        const timelineMax = baselineTotals.reduce((max, total) => Math.max(max, total), 1);

        return { timeline: weeks, timelineMax };
    }

    /**
     * Create an empty analytics view with zeroed-out values for all fields.
     * @returns {AnalyticsView} Empty view object.
     */
    function createEmptyView() {
        return {
            timeline: [],
            timelineMax: 1,
            heatmap: Array.from({ length: 7 }, () => Array(24).fill(0)),
            topics: [],
            contentMix: { textOnly: 0, links: 0, media: 0 },
            streaks: { current: 0, longest: 0 },
            peakHour: { hour: 0, count: 0 },
            peakDay: { dayIndex: 0, count: 0 },
            trend: null,
            totals: { posts: 0, comments: 0, total: 0 },
        };
    }

    /**
     * Find the index and value of the maximum element in a numeric array.
     * @param {number[]} arr - Array of numbers.
     * @returns {{ index: number, value: number }} Index and value of the peak element.
     */
    function getPeakFromArray(arr) {
        return arr.reduce((peak, value, index) => (value > peak.value ? { index, value } : peak), {
            index: 0,
            value: 0,
        });
    }

    /**
     * Calculate the current and longest activity streaks from a set of active day keys.
     * @param {Set<string>} daySet - Set of "YYYY-MM-DD" date keys representing active days.
     * @returns {{ current: number, longest: number }} Current streak length and longest streak length.
     */
    function calculateStreaksFromDays(daySet) {
        if (!daySet || daySet.size === 0) {
            /* v8 ignore next */
            return { current: 0, longest: 0 };
        }
        const days = Array.from(daySet).sort();
        let longest = 1;
        let streak = 1;

        for (let i = 1; i < days.length; i++) {
            const prev = parseDateKey(days[i - 1]);
            const curr = parseDateKey(days[i]);
            // Date keys come from formatDateKey. Break the streak when a key is invalid.
            /* v8 ignore next 4 */
            if (prev === null || curr === null) {
                streak = 1;
                continue;
            }
            // Round the day delta: across a DST transition two consecutive local
            // calendar days are 23h or 25h apart, so an exact `=== 1` on the raw
            // ms/day ratio would miss the boundary and reset the streak.
            const diff = Math.round((curr.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24));
            if (diff === 1) {
                streak++;
                longest = Math.max(longest, streak);
            } else {
                streak = 1;
            }
        }

        // Current streak from latest
        const latestDay = days[days.length - 1];
        let current = 1;

        const latest = parseDateKey(latestDay);
        // Date keys come from formatDateKey. Return no current streak when the latest key is invalid.
        /* v8 ignore next 3 */
        if (latest === null) {
            return { current: 0, longest };
        }

        for (
            let prev = addDays(latest, -1);
            daySet.has(formatDateKey(prev));
            prev = addDays(prev, -1)
        ) {
            current++;
        }

        return { current, longest };
    }

    /**
     * Compute trend direction by comparing the sum of the recent half of the timeline to the older half.
     * @param {Array<{ value: number }>} timeline - Array of timeline entries with numeric values.
     * @returns {ActivityTrend | null} Trend info, or null if insufficient data.
     */
    function computeTrendFromTimeline(timeline) {
        if (timeline.length < 2) {
            return null;
        }

        const half = Math.floor(timeline.length / 2);
        const older = timeline.slice(0, half).reduce((sum, entry) => sum + entry.value, 0);
        const recent = timeline.slice(half).reduce((sum, entry) => sum + entry.value, 0);

        if (older === 0) {
            const hasRecent = recent > 0;
            return {
                percent: hasRecent ? 100 : 0,
                direction: hasRecent ? "up" : "flat",
                currentCount: recent,
                previousCount: older,
            };
        }

        const percent = ((recent - older) / older) * 100;
        // Asymmetric thresholds: growth is notable at 8%, decline at -12% to avoid
        // flagging minor dips as meaningful slowdowns.
        const direction = percent > 8 ? "up" : percent < -12 ? "down" : "flat";

        return { percent, direction, currentCount: recent, previousCount: older };
    }

    return {
        compute,
        buildView,
        generateInsights,
        DAY_LABELS,
        MONTH_LABELS,
    };
})();
