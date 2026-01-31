/* LinkedIn Analyzer - Analytics Engine (Optimized) */

const AnalyticsEngine = (() => {
    'use strict';

    const STOP_WORDS = new Set([
        'the','a','an','and','or','but','in','on','at','to','for','of','with','by','from','up','about','into','through','during','before','after',
        'above','below','between','under','again','further','then','once','here','there','when','where','why','how','all','each','few','more','most',
        'other','some','such','no','nor','not','only','own','same','so','than','too','very','s','t','can','will','just','don','should','now','i',
        'you','he','she','it','we','they','what','which','who','this','that','these','those','am','is','are','was','were','be','been','being','have',
        'has','had','having','do','does','did','doing','would','could','ought','im','youre','hes','shes','its','were','theyre','ive','youve','weve',
        'theyve','id','youd','hed','shed','wed','theyd','ill','youll','hell','shell','well','theyll','isnt','arent','wasnt','werent','hasnt','havent',
        'hadnt','doesnt','dont','didnt','wont','wouldnt','couldnt','shouldnt','my','your','his','her','our','their','me','him','us','them','if',
        'because','as','until','while','also','even','much','many','get','got','like','know','think','make','see','one','two','new','want','way','use',
        'go','going','come','take','really','thing','things','something','say','said','people','time','year','years','day','days','good','first','ve','re',
        'll','d','m','let','need','back','still','every','look','www','https','http','com','linkedin','amp','hi','hello'
    ]);

    const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    function parseLinkedInDate(value) {
        if (!value || typeof value !== 'string') return null;
        const trimmed = value.trim();
        const [datePart, timePart] = trimmed.split(' ');
        if (!datePart || !timePart) return null;
        const [year, month, day] = datePart.split('-').map(Number);
        const [hour, minute] = timePart.split(':').map(Number);
        if (!year || !month || !day) return null;
        
        // LinkedIn exports data in UTC - create UTC date then convert to local
        const utcDate = new Date(Date.UTC(year, month - 1, day, hour || 0, minute || 0, 0));
        
        // Get local day and hour for the user's timezone
        const localHour = utcDate.getHours();
        const localDay = utcDate.getDay(); // 0 = Sunday
        const localDayIndex = (localDay + 6) % 7; // Convert to 0 = Monday
        
        // Get local date components for keys
        const localYear = utcDate.getFullYear();
        const localMonth = utcDate.getMonth() + 1;
        const localDayOfMonth = utcDate.getDate();
        
        return {
            timestamp: utcDate.getTime(),
            dayIndex: localDayIndex,
            hour: localHour,
            dateKey: `${localYear}-${String(localMonth).padStart(2, '0')}-${String(localDayOfMonth).padStart(2, '0')}`,
            monthKey: `${localYear}-${String(localMonth).padStart(2, '0')}`
        };
    }

    function normalizeText(text) {
        if (!text) return '';
        return String(text).replace(/https?:\/\/\S+/gi, ' ').replace(/\s+/g, ' ').trim();
    }

    function extractTopics(text) {
        const normalized = normalizeText(text);
        if (!normalized) return [];
        const hashtags = normalized.match(/#([A-Za-z0-9_]+)/g) || [];
        const textWithoutTags = normalized.replace(/#[A-Za-z0-9_]+/g, ' ');
        const words = textWithoutTags.match(/\b[a-zA-Z]{3,}\b/g) || [];
        const tokenSet = new Set();
        hashtags.forEach(tag => {
            const cleaned = tag.replace('#', '').toLowerCase();
            if (cleaned && !STOP_WORDS.has(cleaned)) tokenSet.add(cleaned);
        });
        words.forEach(word => {
            const cleaned = word.toLowerCase();
            if (!STOP_WORDS.has(cleaned)) tokenSet.add(cleaned);
        });
        return Array.from(tokenSet);
    }

    /**
     * FAANG-style: Pre-compute ALL aggregates during initial load.
     * This creates an indexed structure that allows O(1) filter lookups.
     */
    function compute(sharesData, commentsData) {
        // Pre-aggregated indices
        const monthIndex = new Map();      // monthKey -> { posts, comments, topics: Map, days: Map, hours: Map, shareTypes: Map }
        const topicCounts = new Map();     // topic -> count
        const globalHeatmap = Array.from({ length: 7 }, () => Array(24).fill(0));
        const globalContentMix = { textOnly: 0, links: 0, media: 0 };
        const activeDays = new Set();
        const dayIndex = new Map();        // dateKey -> { posts, comments, total, shareTypes }
        
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
                    activeDays: new Set()
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
                    shareTypes: { textOnly: 0, links: 0, media: 0 }
                });
            }
            return dayIndex.get(dateKey);
        }

        // Process shares
        if (Array.isArray(sharesData)) {
            for (let i = 0; i < sharesData.length; i++) {
                const row = sharesData[i];
                const dateInfo = parseLinkedInDate(row.Date);
                if (!dateInfo) continue;

                const hasMedia = Boolean(String(row.MediaUrl || '').trim());
                const hasLink = Boolean(String(row.SharedUrl || '').trim());
                const topics = extractTopics(row.ShareCommentary);
                const { timestamp, monthKey, dayIndex, hour, dateKey } = dateInfo;

                // Update global stats
                totalPosts++;
                latestTimestamp = Math.max(latestTimestamp, timestamp);
                earliestTimestamp = Math.min(earliestTimestamp, timestamp);
                globalHeatmap[dayIndex][hour]++;
                activeDays.add(dateKey);

                // Content mix
                if (hasMedia) {
                    globalContentMix.media++;
                } else if (hasLink) {
                    globalContentMix.links++;
                } else {
                    globalContentMix.textOnly++;
                }

                // Topics
                for (const topic of topics) {
                    topicCounts.set(topic, (topicCounts.get(topic) || 0) + 1);
                }

                // Month bucket
                const bucket = getMonthBucket(monthKey);
                bucket.posts++;
                bucket.total++;
                bucket.days[dayIndex]++;
                bucket.hours[hour]++;
                bucket.heatmap[dayIndex][hour]++;
                bucket.activeDays.add(dateKey);

                const dayBucket = getDayBucket(dateKey);
                dayBucket.posts++;
                dayBucket.total++;

                if (hasMedia) {
                    bucket.shareTypes.media++;
                    dayBucket.shareTypes.media++;
                } else if (hasLink) {
                    bucket.shareTypes.links++;
                    dayBucket.shareTypes.links++;
                } else {
                    bucket.shareTypes.textOnly++;
                    dayBucket.shareTypes.textOnly++;
                }

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
                if (!dateInfo) continue;

                const topics = extractTopics(row.Message);
                const { timestamp, monthKey, dayIndex, hour, dateKey } = dateInfo;

                totalComments++;
                latestTimestamp = Math.max(latestTimestamp, timestamp);
                earliestTimestamp = Math.min(earliestTimestamp, timestamp);
                globalHeatmap[dayIndex][hour]++;
                activeDays.add(dateKey);

                for (const topic of topics) {
                    topicCounts.set(topic, (topicCounts.get(topic) || 0) + 1);
                }

                const bucket = getMonthBucket(monthKey);
                bucket.comments++;
                bucket.total++;
                bucket.days[dayIndex]++;
                bucket.hours[hour]++;
                bucket.heatmap[dayIndex][hour]++;
                bucket.activeDays.add(dateKey);

                const dayBucket = getDayBucket(dateKey);
                dayBucket.comments++;
                dayBucket.total++;

                for (const topic of topics) {
                    bucket.topics.set(topic, (bucket.topics.get(topic) || 0) + 1);
                }
            }
        }

        // Sort topics by count
        const sortedTopics = Array.from(topicCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([topic, count]) => ({ topic, count }));

        // Convert month index to serializable format
        const months = {};
        for (const [key, bucket] of monthIndex) {
            months[key] = {
                posts: bucket.posts,
                comments: bucket.comments,
                total: bucket.total,
                topics: Object.fromEntries(bucket.topics),
                days: bucket.days,
                hours: bucket.hours,
                heatmap: bucket.heatmap,
                shareTypes: bucket.shareTypes,
                activeDays: Array.from(bucket.activeDays)
            };
        }

        const dayIndexData = {};
        for (const [key, bucket] of dayIndex) {
            dayIndexData[key] = bucket;
        }

        return {
            months,
            dayIndex: dayIndexData,
            topics: sortedTopics,
            globalHeatmap,
            contentMix: globalContentMix,
            activeDays: Array.from(activeDays),
            latestTimestamp: latestTimestamp || null,
            earliestTimestamp: earliestTimestamp === Infinity ? null : earliestTimestamp,
            totals: {
                posts: totalPosts,
                comments: totalComments,
                total: totalPosts + totalComments
            }
        };
    }

    function addMonths(date, months) {
        return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
    }

    function addDays(date, days) {
        return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
    }

    function startOfMonth(date) {
        return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
    }

    function endOfMonth(date) {
        return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
    }

    function parseDateKey(key) {
        const [year, month, day] = key.split('-').map(Number);
        return new Date(Date.UTC(year, month - 1, day));
    }

    function formatDateKey(date) {
        const year = date.getUTCFullYear();
        const month = String(date.getUTCMonth() + 1).padStart(2, '0');
        const day = String(date.getUTCDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    function startOfWeek(date) {
        const day = date.getUTCDay();
        const diff = (day + 6) % 7;
        return addDays(date, -diff);
    }

    function formatWeekLabel(date) {
        return `${MONTH_LABELS[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, '0')}`;
    }

    function getMonthKeysInRange(earliestTimestamp, latestTimestamp, rangeKey, monthFocus) {
        if (!latestTimestamp) return [];
        
        if (monthFocus) {
            return [monthFocus];
        }

        const latestDate = new Date(latestTimestamp);
        const latestMonth = startOfMonth(latestDate);

        if (rangeKey === 'all') {
            const startDate = earliestTimestamp ? startOfMonth(new Date(earliestTimestamp)) : latestMonth;
            const keys = [];
            let cursor = startDate;
            while (cursor <= latestMonth) {
                keys.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`);
                cursor = addMonths(cursor, 1);
            }
            return keys;
        }

        const monthCount = Number(rangeKey.replace('m', ''));
        if (!monthCount || Number.isNaN(monthCount)) return [];

        const keys = [];
        for (let i = 0; i < monthCount; i++) {
            const d = addMonths(latestMonth, -i);
            const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
            keys.push(key);
        }
        return keys.reverse();
    }

    /**
     * Build view from pre-computed aggregates - O(months) not O(events)
     */
    function buildView(analytics, filters) {
        if (!analytics || !analytics.months) return null;

        const { months, latestTimestamp, earliestTimestamp, dayIndex } = analytics;
        const monthKeys = getMonthKeysInRange(earliestTimestamp, latestTimestamp, filters.timeRange, filters.monthFocus);
        
        // Determine which months to include
        const targetMonths = monthKeys;

        if (!targetMonths.length) {
            return createEmptyView();
        }

        // Aggregate from pre-computed month buckets
        let posts = 0, comments = 0;
        const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0));
        const topicCounts = new Map();
        const contentMix = { textOnly: 0, links: 0, media: 0 };
        const hourCounts = Array(24).fill(0);
        const dayCounts = Array(7).fill(0);
        const activeDaysSet = new Set();
        const timeline = [];
        let timelineMax = 1;
        const monthMeta = {};
        const useWeeklyTimeline = Boolean(dayIndex) && (filters.timeRange === '1m' || filters.timeRange === '3m');
        const hasDay = filters.day !== null && filters.day !== undefined;
        const hasHour = filters.hour !== null && filters.hour !== undefined;

        for (const monthKey of targetMonths) {
            const bucket = months[monthKey];
            const baselineValue = bucket ? bucket.total : 0;
            if (!useWeeklyTimeline) {
                timelineMax = Math.max(timelineMax, baselineValue);
            }
            if (bucket) {
                const topicRatio = (filters.topic && filters.topic !== 'all')
                    ? (bucket.total > 0 ? (bucket.topics[filters.topic] || 0) / bucket.total : 0)
                    : 1;
                let hourRatio = 1;
                if (hasHour) {
                    if (hasDay) {
                        const dayTotal = bucket.days[filters.day] || 0;
                        const dayHour = bucket.heatmap[filters.day][filters.hour] || 0;
                        hourRatio = dayTotal > 0 ? dayHour / dayTotal : 0;
                    } else {
                        const hourTotal = bucket.hours[filters.hour] || 0;
                        hourRatio = bucket.total > 0 ? hourTotal / bucket.total : 0;
                    }
                }
                monthMeta[monthKey] = {
                    topicRatio,
                    hourRatio
                };
            }
            if (!bucket) {
                if (!useWeeklyTimeline) {
                    timeline.push({ key: monthKey, label: formatMonthLabel(monthKey), value: 0 });
                }
                continue;
            }

            // Apply filters
            let monthPosts = bucket.posts;
            let monthComments = bucket.comments;
            let monthTotal = bucket.total;
            let useMonth = true;

            // Topic filter - if topic specified, we need to check if month has that topic
            if (filters.topic && filters.topic !== 'all') {
                const topicCount = bucket.topics[filters.topic] || 0;
                if (topicCount === 0) {
                    useMonth = false;
                } else {
                    // Approximate: scale by topic prevalence in this month
                    const ratio = topicCount / monthTotal;
                    monthPosts = Math.round(bucket.posts * ratio);
                    monthComments = Math.round(bucket.comments * ratio);
                    monthTotal = topicCount;
                }
            }

            // ShareType filter
            if (filters.shareType && filters.shareType !== 'all' && useMonth) {
                if (filters.shareType === 'text') {
                    monthPosts = bucket.shareTypes.textOnly;
                } else if (filters.shareType === 'links') {
                    monthPosts = bucket.shareTypes.links;
                } else if (filters.shareType === 'media') {
                    monthPosts = bucket.shareTypes.media;
                }
                monthComments = 0; // shareType only applies to posts
                monthTotal = monthPosts;
            }

            // Day and Hour filters - use heatmap for intersection when both specified
            if (hasDay && hasHour && useMonth) {
                // Use heatmap for exact intersection
                const heatmapCount = bucket.heatmap[filters.day][filters.hour];
                const ratio = monthTotal > 0 ? heatmapCount / monthTotal : 0;
                monthPosts = Math.round(monthPosts * ratio);
                monthComments = Math.round(monthComments * ratio);
                monthTotal = heatmapCount;
            } else if (hasDay && useMonth) {
                const dayTotal = bucket.days[filters.day];
                const ratio = monthTotal > 0 ? dayTotal / monthTotal : 0;
                monthPosts = Math.round(monthPosts * ratio);
                monthComments = Math.round(monthComments * ratio);
                monthTotal = dayTotal;
            } else if (hasHour && useMonth) {
                const hourTotal = bucket.hours[filters.hour];
                const ratio = monthTotal > 0 ? hourTotal / monthTotal : 0;
                monthPosts = Math.round(monthPosts * ratio);
                monthComments = Math.round(monthComments * ratio);
                monthTotal = hourTotal;
            }

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
                timeline.push({ key: monthKey, label: formatMonthLabel(monthKey), value: monthTotal });
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
                total: posts + comments
            }
        };
    }

    function buildWeeklyTimeline(dayIndex, targetMonths, filters, monthMeta) {
        if (!dayIndex || !targetMonths.length) {
            return { timeline: [], timelineMax: 1 };
        }

        const [startYear, startMonth] = targetMonths[0].split('-').map(Number);
        const [endYear, endMonth] = targetMonths[targetMonths.length - 1].split('-').map(Number);
        const rangeStart = new Date(Date.UTC(startYear, startMonth - 1, 1));
        const rangeEnd = endOfMonth(new Date(Date.UTC(endYear, endMonth - 1, 1)));
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
                value: 0
            });
        }

        const baselineTotals = new Array(weeks.length).fill(0);
        const startKey = formatDateKey(rangeStart);
        const endKey = formatDateKey(rangeEnd);
        const hasDay = filters.day !== null && filters.day !== undefined;
        const hasHour = filters.hour !== null && filters.hour !== undefined;

        for (const [dateKey, entry] of Object.entries(dayIndex)) {
            if (dateKey < startKey || dateKey > endKey) continue;
            const date = parseDateKey(dateKey);
            const weekKey = formatDateKey(startOfWeek(date));
            const index = weekIndex.get(weekKey);
            if (index === undefined) continue;

            const dayTotal = entry.total || 0;
            baselineTotals[index] += dayTotal;

            let value = dayTotal;
            if (filters.shareType === 'text') {
                value = entry.shareTypes ? entry.shareTypes.textOnly : 0;
            } else if (filters.shareType === 'links') {
                value = entry.shareTypes ? entry.shareTypes.links : 0;
            } else if (filters.shareType === 'media') {
                value = entry.shareTypes ? entry.shareTypes.media : 0;
            }

            if (hasDay) {
                const dayIndexValue = (date.getUTCDay() + 6) % 7;
                if (dayIndexValue !== filters.day) {
                    value = 0;
                }
            }

            if (filters.topic && filters.topic !== 'all') {
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

        weeks.forEach(week => {
            week.value = Math.round(week.value);
        });

        let timelineMax = 1;
        for (const total of baselineTotals) {
            if (total > timelineMax) timelineMax = total;
        }

        return { timeline: weeks, timelineMax };
    }

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
            totals: { posts: 0, comments: 0, total: 0 }
        };
    }

    function formatMonthLabel(monthKey) {
        const [year, month] = monthKey.split('-').map(Number);
        return `${MONTH_LABELS[month - 1]} ${year}`;
    }

    function getPeakFromArray(arr) {
        let maxVal = 0, maxIdx = 0;
        for (let i = 0; i < arr.length; i++) {
            if (arr[i] > maxVal) {
                maxVal = arr[i];
                maxIdx = i;
            }
        }
        return { index: maxIdx, value: maxVal };
    }

    function calculateStreaksFromDays(daySet) {
        if (!daySet || daySet.size === 0) {
            return { current: 0, longest: 0 };
        }
        const days = Array.from(daySet).sort();
        const parseDay = (key) => {
            const [year, month, day] = key.split('-').map(Number);
            return new Date(Date.UTC(year, month - 1, day));
        };
        let longest = 1;
        let streak = 1;

        for (let i = 1; i < days.length; i++) {
            const prev = parseDay(days[i - 1]);
            const curr = parseDay(days[i]);
            const diff = (curr - prev) / (1000 * 60 * 60 * 24);
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
        while (true) {
            const prev = new Date(cursor.getTime() - 24 * 60 * 60 * 1000);
            const key = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}-${String(prev.getUTCDate()).padStart(2, '0')}`;
            if (daySet.has(key)) {
                current++;
                cursor = prev;
            } else {
                break;
            }
        }

        return { current, longest };
    }

    function computeTrendFromTimeline(timeline) {
        if (timeline.length < 2) return null;
        
        const half = Math.floor(timeline.length / 2);
        let recent = 0, older = 0;
        
        for (let i = 0; i < timeline.length; i++) {
            if (i >= half) {
                recent += timeline[i].value;
            } else {
                older += timeline[i].value;
            }
        }

        if (older === 0) {
            return { percent: recent > 0 ? 100 : 0, direction: recent > 0 ? 'up' : 'flat', currentCount: recent, previousCount: older };
        }

        const percent = ((recent - older) / older) * 100;
        let direction = 'flat';
        if (percent > 8) direction = 'up';
        if (percent < -12) direction = 'down';

        return { percent, direction, currentCount: recent, previousCount: older };
    }

    function generateInsights(view) {
        if (!view || !view.totals || view.totals.total === 0) {
            return { insights: [], tip: null };
        }

        const insights = [];
        const peakHour = view.peakHour.hour;
        const peakDayLabel = DAY_LABELS[view.peakDay.dayIndex];

        if (peakHour <= 5) {
            insights.push({
                id: 'early-bird',
                title: 'Early Bird',
                body: `Your peak hour is ${String(peakHour).padStart(2, '0')}:00. Mornings are your power time.`,
                icon: 'rooster',
                accent: 'accent-yellow'
            });
        } else if (peakHour >= 21) {
            insights.push({
                id: 'night-owl',
                title: 'Night Owl',
                body: `Your peak hour is ${String(peakHour).padStart(2, '0')}:00. Late hours work best for you.`,
                icon: 'owl',
                accent: 'accent-purple'
            });
        } else {
            insights.push({
                id: 'steady-pace',
                title: 'Steady Rhythm',
                body: `Most activity happens around ${String(peakHour).padStart(2, '0')}:00. You keep a consistent rhythm.`,
                icon: 'calendar',
                accent: 'accent-blue'
            });
        }

        if (view.trend) {
            if (view.trend.direction === 'up') {
                insights.push({
                    id: 'trending-up',
                    title: 'Trending Up',
                    body: `Activity is up ${Math.round(view.trend.percent)}% compared to the previous period.`,
                    icon: 'rocket',
                    accent: 'accent-blue'
                });
            } else if (view.trend.direction === 'down') {
                insights.push({
                    id: 'slowing',
                    title: 'Taking a Breather',
                    body: `Activity is down ${Math.abs(Math.round(view.trend.percent))}% compared to the previous period.`,
                    icon: 'sloth',
                    accent: 'accent-purple'
                });
            }
        }

        if (view.totals.total < 12) {
            insights.push({
                id: 'quiet-stretch',
                title: 'Quiet Stretch',
                body: 'This period is lighter on activity. A small push could restart momentum.',
                icon: 'monkey',
                accent: 'accent-purple'
            });
        }

        const ratio = view.totals.posts ? view.totals.comments / view.totals.posts : 0;
        if (ratio >= 3) {
            insights.push({
                id: 'super-engager',
                title: 'Super Engager',
                body: `You comment ${ratio.toFixed(1)}x more than you post. You build community.`,
                icon: 'handshake',
                accent: 'accent-green'
            });
        }

        if (Array.isArray(view.topics) && view.topics.length) {
            const topTopic = view.topics[0];
            insights.push({
                id: 'topic-master',
                title: 'Topic Focus',
                body: `${topTopic.topic} shows up ${topTopic.count} times in your recent activity.`,
                icon: 'trophy',
                accent: 'accent-yellow'
            });
        }

        if (view.streaks.current >= 7) {
            insights.push({
                id: 'streak',
                title: 'Consistency Streak',
                body: `You have a ${view.streaks.current}-day activity streak going.`,
                icon: 'flame',
                accent: 'accent-red'
            });
        }

        insights.push({
            id: 'weekday',
            title: 'Peak Day',
            body: `${peakDayLabel} is your strongest day for activity.`,
            icon: 'calendar',
            accent: 'accent-blue'
        });

        const tip = `Try posting close to ${peakDayLabel} around ${String(peakHour).padStart(2, '0')}:00 for maximum consistency.`;

        return { insights, tip };
    }

    return {
        compute,
        buildView,
        generateInsights,
        DAY_LABELS,
        MONTH_LABELS
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = AnalyticsEngine;
}
