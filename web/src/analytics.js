/* LinkedIn Analyzer - Analytics Engine (Optimized) */

export const AnalyticsEngine = (() => {
    "use strict";

    const STOP_WORDS = new Set([
        "the",
        "a",
        "an",
        "and",
        "or",
        "but",
        "in",
        "on",
        "at",
        "to",
        "for",
        "of",
        "with",
        "by",
        "from",
        "up",
        "about",
        "into",
        "through",
        "during",
        "before",
        "after",
        "above",
        "below",
        "between",
        "under",
        "again",
        "further",
        "then",
        "once",
        "here",
        "there",
        "when",
        "where",
        "why",
        "how",
        "all",
        "each",
        "few",
        "more",
        "most",
        "other",
        "some",
        "such",
        "no",
        "nor",
        "not",
        "only",
        "own",
        "same",
        "so",
        "than",
        "too",
        "very",
        "s",
        "t",
        "can",
        "will",
        "just",
        "don",
        "should",
        "now",
        "i",
        "you",
        "he",
        "she",
        "it",
        "we",
        "they",
        "what",
        "which",
        "who",
        "this",
        "that",
        "these",
        "those",
        "am",
        "is",
        "are",
        "was",
        "were",
        "be",
        "been",
        "being",
        "have",
        "has",
        "had",
        "having",
        "do",
        "does",
        "did",
        "doing",
        "would",
        "could",
        "ought",
        "im",
        "youre",
        "hes",
        "shes",
        "its",
        "were",
        "theyre",
        "ive",
        "youve",
        "weve",
        "theyve",
        "id",
        "youd",
        "hed",
        "shed",
        "wed",
        "theyd",
        "ill",
        "youll",
        "hell",
        "shell",
        "well",
        "theyll",
        "isnt",
        "arent",
        "wasnt",
        "werent",
        "hasnt",
        "havent",
        "hadnt",
        "doesnt",
        "dont",
        "didnt",
        "wont",
        "wouldnt",
        "couldnt",
        "shouldnt",
        "my",
        "your",
        "his",
        "her",
        "our",
        "their",
        "me",
        "him",
        "us",
        "them",
        "if",
        "because",
        "as",
        "until",
        "while",
        "also",
        "even",
        "much",
        "many",
        "get",
        "got",
        "like",
        "know",
        "think",
        "make",
        "see",
        "one",
        "two",
        "new",
        "want",
        "way",
        "use",
        "go",
        "going",
        "come",
        "take",
        "really",
        "thing",
        "things",
        "something",
        "say",
        "said",
        "people",
        "time",
        "year",
        "years",
        "day",
        "days",
        "good",
        "first",
        "ve",
        "re",
        "ll",
        "d",
        "m",
        "let",
        "need",
        "back",
        "still",
        "every",
        "look",
        "www",
        "https",
        "http",
        "com",
        "linkedin",
        "amp",
        "hi",
        "hello",
    ]);

    const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const MONTH_LABELS = [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
    ];
    const WEEKLY_TIME_RANGES = new Set(["1m", "3m"]);
    const SHARE_TYPE_MAP = Object.freeze({ text: "textOnly", links: "links", media: "media" });
    const DIMENSION_COUNT_BY_KEY = Object.freeze({
        both: (bucket, filters) =>
            (bucket.heatmap[filters.day] && bucket.heatmap[filters.day][filters.hour]) || 0,
        day: (bucket, filters) => bucket.days[filters.day] || 0,
        hour: (bucket, filters) => bucket.hours[filters.hour] || 0,
    });

    /**
     * Parse a LinkedIn date string into date components.
     * @param {string} value - Date string in "YYYY-MM-DD HH:MM:SS" format.
     * @returns {{ timestamp: number, dayIndex: number, hour: number, dateKey: string, monthKey: string } | null} Parsed date components, or null if invalid.
     */
    function parseLinkedInDate(value) {
        if (!value || typeof value !== "string") {
            return null;
        }
        const trimmed = value.trim();
        const [datePart, timePart] = trimmed.split(" ");
        if (!datePart || !timePart) {
            return null;
        }
        const [year, month, day] = datePart.split("-").map(Number);
        const [hour, minute] = timePart.split(":").map(Number);
        if (!year || !month || !day) {
            return null;
        }

        // Timestamps are already converted to local time by the cleaner.
        const localDate = new Date(year, month - 1, day, hour || 0, minute || 0, 0);

        const localHour = localDate.getHours();
        const localDay = localDate.getDay(); // 0 = Sunday
        const localDayIndex = (localDay + 6) % 7; // Convert to 0 = Monday

        const localYear = localDate.getFullYear();
        const localMonth = localDate.getMonth() + 1;
        const localDayOfMonth = localDate.getDate();

        return {
            timestamp: localDate.getTime(),
            dayIndex: localDayIndex,
            hour: localHour,
            dateKey: `${localYear}-${String(localMonth).padStart(2, "0")}-${String(localDayOfMonth).padStart(2, "0")}`,
            monthKey: `${localYear}-${String(localMonth).padStart(2, "0")}`,
        };
    }

    /**
     * Strip URLs and normalize whitespace in a text string.
     * @param {string} text - Raw text to normalize.
     * @returns {string} Cleaned text with URLs removed and whitespace collapsed.
     */
    function normalizeText(text) {
        if (!text) {
            return "";
        }
        return String(text)
            .replace(/https?:\/\/\S+/gi, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    /**
     * Extract hashtags and significant words from text, filtering out stop words.
     * @param {string} text - Raw text to extract topics from.
     * @returns {string[]} Array of unique lowercase topic tokens.
     */
    function extractTopics(text) {
        const normalized = normalizeText(text);
        if (!normalized) {
            return [];
        }
        const hashtags = normalized.match(/#([A-Za-z0-9_]+)/g) || [];
        const textWithoutTags = normalized.replace(/#[A-Za-z0-9_]+/g, " ");
        const words = textWithoutTags.match(/\b[a-zA-Z]{3,}\b/g) || [];
        const tokenSet = new Set();
        hashtags.forEach((tag) => {
            const cleaned = tag.replace("#", "").toLowerCase();
            if (cleaned && !STOP_WORDS.has(cleaned)) {
                tokenSet.add(cleaned);
            }
        });
        words.forEach((word) => {
            const cleaned = word.toLowerCase();
            if (!STOP_WORDS.has(cleaned)) {
                tokenSet.add(cleaned);
            }
        });
        return Array.from(tokenSet);
    }

    // Compute pre-aggregated analytics indices from raw event data.
    // Indexes by month and day for O(months) view building instead of O(events).
    /**
     * Pre-compute aggregates during initial load.
     * This creates an indexed structure that allows fast filter lookups.
     * @param {object[]|null|undefined} sharesData - Cleaned shares rows
     * @param {object[]|null|undefined} commentsData - Cleaned comments rows
     * @returns {object} Analytics aggregates and indices
     */
    function compute(sharesData, commentsData) {
        // Pre-aggregated indices
        const monthIndex = new Map(); // monthKey -> { posts, comments, topics: Map, days: Map, hours: Map, shareTypes: Map }
        const activeDays = new Set();
        const dayIndex = new Map(); // dateKey -> { posts, comments, total, shareTypes }

        let latestTimestamp = 0;
        let earliestTimestamp = Infinity;
        let totalPosts = 0;
        let totalComments = 0;

        // Helper to ensure month bucket exists
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
            return monthIndex.get(monthKey);
        }

        function getDayBucket(dateKey) {
            if (!dayIndex.has(dateKey)) {
                dayIndex.set(dateKey, {
                    posts: 0,
                    comments: 0,
                    total: 0,
                    shareTypes: { textOnly: 0, links: 0, media: 0 },
                });
            }
            return dayIndex.get(dateKey);
        }

        // Process shares
        if (Array.isArray(sharesData)) {
            for (let i = 0; i < sharesData.length; i++) {
                const row = sharesData[i];
                const dateInfo = parseLinkedInDate(row.Date);
                if (!dateInfo) {
                    continue;
                }

                const hasMedia = Boolean(String(row.MediaUrl || "").trim());
                const hasLink = Boolean(String(row.SharedUrl || "").trim());
                const topics = extractTopics(row.ShareCommentary);
                const { timestamp, monthKey, dayIndex: dayIdx, hour, dateKey } = dateInfo;

                // Update global stats
                totalPosts++;
                latestTimestamp = Math.max(latestTimestamp, timestamp);
                earliestTimestamp = Math.min(earliestTimestamp, timestamp);
                activeDays.add(dateKey);

                // Month bucket
                const bucket = getMonthBucket(monthKey);
                bucket.posts++;
                bucket.total++;
                bucket.days[dayIdx]++;
                bucket.hours[hour]++;
                bucket.heatmap[dayIdx][hour]++;
                bucket.activeDays.add(dateKey);

                const dayBucket = getDayBucket(dateKey);
                dayBucket.posts++;
                dayBucket.total++;

                const shareTypeKey = hasMedia ? "media" : hasLink ? "links" : "textOnly";
                bucket.shareTypes[shareTypeKey]++;
                dayBucket.shareTypes[shareTypeKey]++;

                for (const topic of topics) {
                    bucket.topics.set(topic, (bucket.topics.get(topic) || 0) + 1);
                }
            }
        }

        // Process comments
        if (Array.isArray(commentsData)) {
            for (let i = 0; i < commentsData.length; i++) {
                const row = commentsData[i];
                const dateInfo = parseLinkedInDate(row.Date);
                if (!dateInfo) {
                    continue;
                }

                const topics = extractTopics(row.Message);
                const { timestamp, monthKey, dayIndex: dayIdx, hour, dateKey } = dateInfo;

                totalComments++;
                latestTimestamp = Math.max(latestTimestamp, timestamp);
                earliestTimestamp = Math.min(earliestTimestamp, timestamp);
                activeDays.add(dateKey);

                const bucket = getMonthBucket(monthKey);
                bucket.comments++;
                bucket.total++;
                bucket.days[dayIdx]++;
                bucket.hours[hour]++;
                bucket.heatmap[dayIdx][hour]++;
                bucket.activeDays.add(dateKey);

                const dayBucket = getDayBucket(dateKey);
                dayBucket.comments++;
                dayBucket.total++;

                for (const topic of topics) {
                    bucket.topics.set(topic, (bucket.topics.get(topic) || 0) + 1);
                }
            }
        }

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

        const dayIndexData = Object.fromEntries(dayIndex);

        return {
            months,
            dayIndex: dayIndexData,
            activeDays: Array.from(activeDays),
            latestTimestamp: latestTimestamp || null,
            earliestTimestamp: earliestTimestamp === Infinity ? null : earliestTimestamp,
            totals: {
                posts: totalPosts,
                comments: totalComments,
                total: totalPosts + totalComments,
            },
        };
    }

    /**
     * Return a new Date offset by the given number of months, set to the 1st.
     * @param {Date} date - Starting date.
     * @param {number} months - Number of months to add (can be negative).
     * @returns {Date} New date offset by months.
     */
    function addMonths(date, months) {
        return new Date(date.getFullYear(), date.getMonth() + months, 1);
    }

    /**
     * Return a new Date offset by the given number of days.
     * @param {Date} date - Starting date.
     * @param {number} days - Number of days to add (can be negative).
     * @returns {Date} New date offset by days.
     */
    function addDays(date, days) {
        return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
    }

    /**
     * Get the first day of the month for the given date.
     * @param {Date} date - Input date.
     * @returns {Date} New date set to the 1st of the same month.
     */
    function startOfMonth(date) {
        return new Date(date.getFullYear(), date.getMonth(), 1);
    }

    /**
     * Get the last day of the month for the given date.
     * @param {Date} date - Input date.
     * @returns {Date} New date set to the last day of the same month.
     */
    function endOfMonth(date) {
        return new Date(date.getFullYear(), date.getMonth() + 1, 0);
    }

    /**
     * Parse a "YYYY-MM-DD" date key string into a Date object.
     * @param {string} key - Date key in "YYYY-MM-DD" format.
     * @returns {Date} Parsed date.
     */
    function parseDateKey(key) {
        const [year, month, day] = key.split("-").map(Number);
        return new Date(year, month - 1, day);
    }

    /**
     * Format a Date object as a "YYYY-MM-DD" string.
     * @param {Date} date - Date to format.
     * @returns {string} Formatted date key.
     */
    function formatDateKey(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const day = String(date.getDate()).padStart(2, "0");
        return `${year}-${month}-${day}`;
    }

    /**
     * Get the Monday of the week containing the given date.
     * @param {Date} date - Input date.
     * @returns {Date} Monday of that week.
     */
    function startOfWeek(date) {
        const day = date.getDay();
        const diff = (day + 6) % 7;
        return addDays(date, -diff);
    }

    /**
     * Format a date as a "Mon DD" label string.
     * @param {Date} date - Date to format.
     * @returns {string} Formatted label, e.g. "Jan 05".
     */
    function formatWeekLabel(date) {
        return `${MONTH_LABELS[date.getMonth()]} ${String(date.getDate()).padStart(2, "0")}`;
    }

    /**
     * Get the topic filter ratio for a month bucket. Returns the fraction of activity matching the selected topic.
     * @param {object} bucket - Month bucket with topics and total count.
     * @param {object} filters - Active filters including topic.
     * @returns {number} Ratio between 0 and 1.
     */
    function getTopicRatio(bucket, filters) {
        if (!filters.topic || filters.topic === "all") {
            return 1;
        }
        if (!bucket.total) {
            return 0;
        }
        const topicCount = bucket.topics[filters.topic] || 0;
        return topicCount / bucket.total;
    }

    /**
     * Get the hour/day filter ratio for a month bucket. Returns the fraction of activity matching the selected hour and/or day.
     * @param {object} bucket - Month bucket with hours, days, and heatmap arrays.
     * @param {object} filters - Active filters including hour and day.
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
        return bucket.total > 0 ? hourTotal / bucket.total : 0;
    }

    /**
     * Apply all active filters (topic, share type, day, hour) to a month bucket and return adjusted counts.
     * @param {object} bucket - Month bucket with posts, comments, total, and sub-indices.
     * @param {object} filters - Active filters to apply.
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
                monthPosts = bucket.shareTypes[typeKey];
            }
            monthComments = 0;
            monthTotal = monthPosts;
        }

        // Apply day/hour dimensional filter using the appropriate count
        const dimensionKey = hasDay && hasHour ? "both" : hasDay ? "day" : hasHour ? "hour" : null;
        if (useMonth && dimensionKey) {
            const filterCount = DIMENSION_COUNT_BY_KEY[dimensionKey](bucket, filters);
            const ratio = monthTotal > 0 ? filterCount / monthTotal : 0;
            monthPosts = Math.round(monthPosts * ratio);
            monthComments = Math.round(monthComments * ratio);
            monthTotal = filterCount;
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
            const keys = [];
            for (let cursor = startDate; cursor <= latestMonth; cursor = addMonths(cursor, 1)) {
                keys.push(
                    `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`,
                );
            }
            return keys;
        }

        const monthCount = Number(rangeKey.replace("m", ""));
        if (!monthCount || Number.isNaN(monthCount)) {
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
     * Build view from pre-computed aggregates - O(months) not O(events)
     * @param {object|null} analytics - Pre-computed analytics payload
     * @param {object} filters - Active filter state
     * @returns {object|null} View model or null when no analytics
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

        // Determine which months to include
        const targetMonths = monthKeys;

        if (!targetMonths.length) {
            return createEmptyView();
        }

        // Aggregate from pre-computed month buckets
        let posts = 0,
            comments = 0;
        const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0));
        const topicCounts = new Map();
        const contentMix = { textOnly: 0, links: 0, media: 0 };
        const hourCounts = Array(24).fill(0);
        const dayCounts = Array(7).fill(0);
        const activeDaysSet = new Set();
        const timeline = [];
        let timelineMax = 1;
        const monthMeta = {};
        const useWeeklyTimeline = Boolean(dayIndex) && WEEKLY_TIME_RANGES.has(filters.timeRange);
        const hasDay = filters.day !== null && filters.day !== undefined;
        const hasHour = filters.hour !== null && filters.hour !== undefined;

        for (const monthKey of targetMonths) {
            const bucket = months[monthKey];
            const baselineValue = bucket ? bucket.total : 0;
            let topicRatio = 1;
            if (!useWeeklyTimeline) {
                timelineMax = Math.max(timelineMax, baselineValue);
            }
            if (!bucket) {
                if (!useWeeklyTimeline) {
                    timeline.push({ key: monthKey, label: formatMonthLabel(monthKey), value: 0 });
                }
                continue;
            }

            topicRatio = getTopicRatio(bucket, filters);
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
                if (!useWeeklyTimeline) {
                    timeline.push({ key: monthKey, label: formatMonthLabel(monthKey), value: 0 });
                }
                continue;
            }

            posts += monthPosts;
            comments += monthComments;

            // Aggregate heatmap
            for (let d = 0; d < 7; d++) {
                for (let h = 0; h < 24; h++) {
                    heatmap[d][h] += bucket.heatmap[d][h];
                }
                dayCounts[d] += bucket.days[d];
            }
            for (let h = 0; h < 24; h++) {
                hourCounts[h] += bucket.hours[h];
            }

            // Content mix
            contentMix.textOnly += bucket.shareTypes.textOnly;
            contentMix.links += bucket.shareTypes.links;
            contentMix.media += bucket.shareTypes.media;

            // Topics
            for (const [topic, count] of Object.entries(bucket.topics)) {
                topicCounts.set(topic, (topicCounts.get(topic) || 0) + count);
            }

            // Active days
            for (const day of bucket.activeDays) {
                activeDaysSet.add(day);
            }

            if (!useWeeklyTimeline) {
                timeline.push({
                    key: monthKey,
                    label: formatMonthLabel(monthKey),
                    value: monthTotal,
                });
            }
        }

        if (useWeeklyTimeline) {
            const weekly = buildWeeklyTimeline(dayIndex, targetMonths, filters, monthMeta);
            timeline.push(...weekly.timeline);
            timelineMax = weekly.timelineMax;
        }

        // Sort and limit topics
        const topicsArray = Array.from(topicCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 12)
            .map(([topic, count]) => ({ topic, count }));

        // Calculate peaks
        const peakHour = getPeakFromArray(hourCounts);
        const peakDay = getPeakFromArray(dayCounts);

        // Calculate streaks
        const streaks = calculateStreaksFromDays(activeDaysSet);

        // Calculate trend
        const trend = computeTrendFromTimeline(timeline);

        return {
            timeline,
            timelineMax,
            heatmap,
            topics: topicsArray,
            contentMix,
            streaks,
            peakHour: { hour: peakHour.index, count: peakHour.value },
            peakDay: { dayIndex: peakDay.index, count: peakDay.value },
            trend,
            totals: {
                posts,
                comments,
                total: posts + comments,
            },
        };
    }

    /**
     * Build a weekly timeline from the day-level index for the given target months, applying all active filters.
     * @param {object} dayIndex - Day-level index mapping dateKey to daily counts.
     * @param {string[]} targetMonths - Array of "YYYY-MM" month keys to include.
     * @param {object} filters - Active filters (shareType, day, topic, hour).
     * @param {object} monthMeta - Per-month metadata with topicRatio and hourRatio.
     * @returns {{ timeline: Array, timelineMax: number }} Weekly timeline entries and max baseline value.
     */
    function buildWeeklyTimeline(dayIndex, targetMonths, filters, monthMeta) {
        /* v8 ignore next 3 */
        if (!dayIndex || !targetMonths.length) {
            return { timeline: [], timelineMax: 1 };
        }

        const [startYear, startMonth] = targetMonths[0].split("-").map(Number);
        const [endYear, endMonth] = targetMonths[targetMonths.length - 1].split("-").map(Number);
        const rangeStart = new Date(startYear, startMonth - 1, 1);
        const rangeEnd = endOfMonth(new Date(endYear, endMonth - 1, 1));
        const startWeek = startOfWeek(rangeStart);
        const endWeek = startOfWeek(rangeEnd);

        const weeks = [];
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

        const baselineTotals = new Array(weeks.length).fill(0);
        const startKey = formatDateKey(rangeStart);
        const endKey = formatDateKey(rangeEnd);
        const hasDay = filters.day !== null && filters.day !== undefined;
        const hasHour = filters.hour !== null && filters.hour !== undefined;

        for (const [dateKey, entry] of Object.entries(dayIndex)) {
            if (dateKey < startKey || dateKey > endKey) {
                /* v8 ignore next */
                continue;
            }
            const date = parseDateKey(dateKey);
            const weekKey = formatDateKey(startOfWeek(date));
            const index = weekIndex.get(weekKey);
            if (index === undefined) {
                /* v8 ignore next */
                continue;
            }

            const dayTotal = entry.total || 0;
            baselineTotals[index] += dayTotal;

            let value = dayTotal;
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
                const monthKey = dateKey.slice(0, 7);
                const meta = monthMeta[monthKey];
                const ratio = meta ? meta.topicRatio : 0;
                value *= ratio;
            }

            if (hasHour) {
                const monthKey = dateKey.slice(0, 7);
                const meta = monthMeta[monthKey];
                const ratio = meta ? meta.hourRatio : 0;
                value *= ratio;
            }

            weeks[index].value += value;
        }

        weeks.forEach((week) => {
            week.value = Math.round(week.value);
        });

        const timelineMax = baselineTotals.reduce((max, total) => Math.max(max, total), 1);

        return { timeline: weeks, timelineMax };
    }

    /**
     * Create an empty analytics view with zeroed-out values for all fields.
     * @returns {object} Empty view object.
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
     * Format a "YYYY-MM" month key as a human-readable "Mon YYYY" label.
     * @param {string} monthKey - Month key in "YYYY-MM" format.
     * @returns {string} Formatted label, e.g. "Jan 2025".
     */
    function formatMonthLabel(monthKey) {
        const [year, month] = monthKey.split("-").map(Number);
        return `${MONTH_LABELS[month - 1]} ${year}`;
    }

    /**
     * Find the index and value of the maximum element in a numeric array.
     * @param {number[]} arr - Array of numbers.
     * @returns {{ index: number, value: number }} Index and value of the peak element.
     */
    function getPeakFromArray(arr) {
        let maxVal = 0,
            maxIdx = 0;
        for (let i = 0; i < arr.length; i++) {
            if (arr[i] > maxVal) {
                maxVal = arr[i];
                maxIdx = i;
            }
        }
        return { index: maxIdx, value: maxVal };
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
        const parseDay = (key) => {
            const [year, month, day] = key.split("-").map(Number);
            return new Date(year, month - 1, day);
        };
        let longest = 1;
        let streak = 1;

        for (let i = 1; i < days.length; i++) {
            const prev = parseDay(days[i - 1]);
            const curr = parseDay(days[i]);
            const diff = (curr.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24);
            if (diff === 1) {
                streak++;
                longest = Math.max(longest, streak);
            } else {
                streak = 1;
            }
        }

        // Current streak from latest
        const latestDay = days[days.length - 1];
        let cursor = parseDay(latestDay);
        let current = 1;

        for (
            let prev = addDays(cursor, -1);
            daySet.has(formatDateKey(prev));
            prev = addDays(prev, -1)
        ) {
            current++;
            cursor = prev;
        }

        return { current, longest };
    }

    /**
     * Compute trend direction by comparing the sum of the recent half of the timeline to the older half.
     * @param {Array<{ value: number }>} timeline - Array of timeline entries with numeric values.
     * @returns {{ percent: number, direction: string, currentCount: number, previousCount: number } | null} Trend info, or null if insufficient data.
     */
    function computeTrendFromTimeline(timeline) {
        if (timeline.length < 2) {
            return null;
        }

        const half = Math.floor(timeline.length / 2);
        let recent = 0,
            older = 0;

        for (let i = 0; i < timeline.length; i++) {
            if (i >= half) {
                recent += timeline[i].value;
            } else {
                older += timeline[i].value;
            }
        }

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

    function generateInsights(view) {
        if (!view || !view.totals || view.totals.total === 0) {
            return { insights: [], tip: null };
        }

        const insights = [];
        const peakHour = view.peakHour.hour;
        const peakDayLabel = DAY_LABELS[view.peakDay.dayIndex];

        const TIME_OF_DAY_INSIGHTS = [
            {
                max: 5,
                id: "early-bird",
                title: "Early Bird",
                template: "Your peak hour is {hour}. Mornings are your power time.",
                icon: "rooster",
                accent: "accent-yellow",
            },
            {
                min: 21,
                id: "night-owl",
                title: "Night Owl",
                template: "Your peak hour is {hour}. Late hours work best for you.",
                icon: "owl",
                accent: "accent-purple",
            },
        ];
        const hourLabel = `${String(peakHour).padStart(2, "0")}:00`;
        const timeInsight = TIME_OF_DAY_INSIGHTS.find(
            (i) =>
                (i.max !== undefined && peakHour <= i.max) ||
                (i.min !== undefined && peakHour >= i.min),
        ) || {
            id: "steady-pace",
            title: "Steady Rhythm",
            template: "Most activity happens around {hour}. You keep a consistent rhythm.",
            icon: "calendar",
            accent: "accent-blue",
        };
        insights.push({
            id: timeInsight.id,
            title: timeInsight.title,
            body: timeInsight.template.replace("{hour}", hourLabel),
            icon: timeInsight.icon,
            accent: timeInsight.accent,
        });

        const TREND_INSIGHTS = {
            up: {
                id: "trending-up",
                title: "Trending Up",
                template: "Activity is up {pct}% compared to the previous period.",
                icon: "rocket",
                accent: "accent-blue",
            },
            down: {
                id: "slowing",
                title: "Taking a Breather",
                template: "Activity is down {pct}% compared to the previous period.",
                icon: "sloth",
                accent: "accent-purple",
            },
        };
        if (view.trend) {
            const trendDef = TREND_INSIGHTS[view.trend.direction];
            if (trendDef) {
                insights.push({
                    id: trendDef.id,
                    title: trendDef.title,
                    body: trendDef.template.replace(
                        "{pct}",
                        String(Math.abs(Math.round(view.trend.percent))),
                    ),
                    icon: trendDef.icon,
                    accent: trendDef.accent,
                });
            }
        }

        if (view.totals.total < 12) {
            insights.push({
                id: "quiet-stretch",
                title: "Quiet Stretch",
                body: "This period is lighter on activity. A small push could restart momentum.",
                icon: "monkey",
                accent: "accent-purple",
            });
        }

        const ratio = view.totals.posts ? view.totals.comments / view.totals.posts : 0;
        if (ratio >= 3) {
            insights.push({
                id: "super-engager",
                title: "Super Engager",
                body: `You comment ${ratio.toFixed(1)}x more than you post. You build community.`,
                icon: "handshake",
                accent: "accent-green",
            });
        }

        if (Array.isArray(view.topics) && view.topics.length) {
            const topTopic = view.topics[0];
            insights.push({
                id: "topic-master",
                title: "Topic Focus",
                body: `${topTopic.topic} shows up ${topTopic.count} times in your recent activity.`,
                icon: "trophy",
                accent: "accent-yellow",
            });
        }

        if (view.streaks.current >= 7) {
            insights.push({
                id: "streak",
                title: "Consistency Streak",
                body: `You have a ${view.streaks.current}-day activity streak going.`,
                icon: "flame",
                accent: "accent-red",
            });
        }

        insights.push({
            id: "weekday",
            title: "Peak Day",
            body: `${peakDayLabel} is your strongest day for activity.`,
            icon: "calendar",
            accent: "accent-blue",
        });

        const tip = `Try posting close to ${peakDayLabel} around ${String(peakHour).padStart(2, "0")}:00 for maximum consistency.`;

        return { insights, tip };
    }

    return {
        compute,
        buildView,
        generateInsights,
        DAY_LABELS,
        MONTH_LABELS,
    };
})();
