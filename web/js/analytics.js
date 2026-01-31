/* LinkedIn Analyzer - Analytics Engine */

const AnalyticsEngine = (() => {
    'use strict';

    const EMPTY_TOPIC_SET = new Set();

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
        if (!value || typeof value !== 'string') {
            return null;
        }
        const trimmed = value.trim();
        const [datePart, timePart] = trimmed.split(' ');
        if (!datePart || !timePart) {
            return null;
        }
        const [year, month, day] = datePart.split('-').map(Number);
        const [hour, minute, second] = timePart.split(':').map(Number);
        if (!year || !month || !day) {
            return null;
        }
        const date = new Date(Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0));
        return {
            date,
            year,
            month,
            day,
            hour: hour || 0,
            timestamp: date.getTime(),
            dayIndex: (date.getUTCDay() + 6) % 7,
            dateKey: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
            monthKey: `${year}-${String(month).padStart(2, '0')}`
        };
    }

    function normalizeText(text) {
        if (!text) return '';
        return String(text)
            .replace(/https?:\/\/\S+/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
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
            if (cleaned && !STOP_WORDS.has(cleaned)) {
                tokenSet.add(cleaned);
            }
        });

        words.forEach(word => {
            const cleaned = word.toLowerCase();
            if (!STOP_WORDS.has(cleaned)) {
                tokenSet.add(cleaned);
            }
        });

        return Array.from(tokenSet);
    }

    function buildEvent({ type, dateValue, text, hasMedia, hasLink }) {
        const dateInfo = parseLinkedInDate(dateValue);
        if (!dateInfo) return null;
        const topics = extractTopics(text);
        return {
            ...dateInfo,
            type,
            topicSet: topics.length ? new Set(topics) : EMPTY_TOPIC_SET,
            hasMedia: Boolean(hasMedia),
            hasLink: Boolean(hasLink)
        };
    }

    function compute(sharesData, commentsData) {
        const events = [];
        const contentMix = {
            textOnly: 0,
            links: 0,
            media: 0
        };

        if (Array.isArray(sharesData)) {
            sharesData.forEach(row => {
                const hasMedia = Boolean(String(row.MediaUrl || '').trim());
                const hasLink = Boolean(String(row.SharedUrl || '').trim());
                const event = buildEvent({
                    type: 'share',
                    dateValue: row.Date,
                    text: row.ShareCommentary,
                    hasMedia,
                    hasLink
                });
                if (event) {
                    events.push(event);
                    if (hasMedia) {
                        contentMix.media += 1;
                    } else if (hasLink) {
                        contentMix.links += 1;
                    } else {
                        contentMix.textOnly += 1;
                    }
                }
            });
        }

        if (Array.isArray(commentsData)) {
            commentsData.forEach(row => {
                const event = buildEvent({
                    type: 'comment',
                    dateValue: row.Date,
                    text: row.Message
                });
                if (event) {
                    events.push(event);
                }
            });
        }

        let latestDate = null;
        events.forEach(event => {
            if (!latestDate || event.date > latestDate) {
                latestDate = event.date;
            }
        });
        const totals = {
            posts: Array.isArray(sharesData) ? sharesData.length : 0,
            comments: Array.isArray(commentsData) ? commentsData.length : 0,
            total: events.length
        };

        const topicCounts = buildTopicCounts(events);

        return {
            events,
            latestDate,
            totals,
            contentMix,
            topicCounts,
            topics: Object.entries(topicCounts)
                .sort((a, b) => b[1] - a[1])
                .map(([topic, count]) => ({ topic, count }))
        };
    }

    function buildTopicCounts(events) {
        const counts = {};
        events.forEach(event => {
            event.topicSet.forEach(topic => {
                counts[topic] = (counts[topic] || 0) + 1;
            });
        });
        return counts;
    }

    function addMonths(date, months) {
        return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
    }

    function startOfMonth(date) {
        return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
    }

    function endOfMonth(date) {
        return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0, 23, 59, 59));
    }

    function getRange(latestDate, rangeKey, monthFocus) {
        if (!latestDate) return null;
        if (monthFocus) {
            const [year, month] = monthFocus.split('-').map(Number);
            if (!year || !month) return null;
            const start = new Date(Date.UTC(year, month - 1, 1));
            const end = endOfMonth(start);
            return { start, end, label: `${MONTH_LABELS[month - 1]} ${year}`, months: 1 };
        }
        if (rangeKey === 'all') {
            return { start: null, end: null, label: 'All time', months: null };
        }
        const months = Number(rangeKey.replace('m', ''));
        if (!months || Number.isNaN(months)) return null;
        const latestMonth = startOfMonth(latestDate);
        const start = startOfMonth(addMonths(latestMonth, -(months - 1)));
        const end = endOfMonth(latestMonth);
        return { start, end, label: `${months} months`, months };
    }

    function matchesFilters(event, filters) {
        if (filters.topic && filters.topic !== 'all') {
            if (!event.topicSet.has(filters.topic)) {
                return false;
            }
        }
        if (filters.day !== null && filters.day !== undefined) {
            if (event.dayIndex !== filters.day) {
                return false;
            }
        }
        if (filters.hour !== null && filters.hour !== undefined) {
            if (event.hour !== filters.hour) {
                return false;
            }
        }
        if (filters.shareType && filters.shareType !== 'all') {
            if (event.type !== 'share') {
                return false;
            }
            if (filters.shareType === 'media' && !event.hasMedia) {
                return false;
            }
            if (filters.shareType === 'links' && (!event.hasLink || event.hasMedia)) {
                return false;
            }
            if (filters.shareType === 'text' && (event.hasLink || event.hasMedia)) {
                return false;
            }
        }
        return true;
    }

    function isWithinRange(event, rangeInfo) {
        if (!rangeInfo || !rangeInfo.start || !rangeInfo.end) {
            return true;
        }
        return event.date >= rangeInfo.start && event.date <= rangeInfo.end;
    }

    function buildMonthSeries(start, end) {
        if (!start || !end) {
            return [];
        }
        const months = [];
        let cursor = new Date(start.getTime());
        while (cursor <= end) {
            const monthKey = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`;
            months.push(monthKey);
            cursor = addMonths(cursor, 1);
        }
        return months;
    }

    function buildTimeline(counts, rangeInfo, minDate, maxDate) {
        let start = rangeInfo?.start || null;
        let end = rangeInfo?.end || null;
        if (!start || !end) {
            if (!minDate || !maxDate) return [];
            start = startOfMonth(minDate);
            end = endOfMonth(maxDate);
        }
        const monthKeys = buildMonthSeries(start, end);
        return monthKeys.map(key => {
            const [year, month] = key.split('-').map(Number);
            const label = `${MONTH_LABELS[month - 1]} ${year}`;
            return {
                key,
                label,
                value: counts.get(key) || 0
            };
        });
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
        let current = 1;
        let streak = 1;

        for (let i = 1; i < days.length; i += 1) {
            const prev = parseDay(days[i - 1]);
            const curr = parseDay(days[i]);
            const diff = (curr - prev) / (1000 * 60 * 60 * 24);
            if (diff === 1) {
                streak += 1;
                longest = Math.max(longest, streak);
            } else {
                streak = 1;
            }
        }

        const latestDay = days[days.length - 1];
        let cursor = parseDay(latestDay);
        current = 1;
        while (true) {
            const prev = new Date(cursor.getTime() - 24 * 60 * 60 * 1000);
            const key = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}-${String(prev.getUTCDate()).padStart(2, '0')}`;
            if (daySet.has(key)) {
                current += 1;
                cursor = prev;
            } else {
                break;
            }
        }

        return { current, longest };
    }

    function getPeakHourFromCounts(counts) {
        let max = 0;
        let maxHour = 0;
        counts.forEach((count, hour) => {
            if (count > max) {
                max = count;
                maxHour = hour;
            }
        });
        return { hour: maxHour, count: max };
    }

    function getPeakDayFromCounts(counts) {
        let max = 0;
        let maxDay = 0;
        counts.forEach((count, index) => {
            if (count > max) {
                max = count;
                maxDay = index;
            }
        });
        return { dayIndex: maxDay, count: max };
    }

    function computeTrend(events, rangeInfo, filters) {
        if (!rangeInfo || !rangeInfo.start || !rangeInfo.end) {
            return null;
        }
        const currentStart = rangeInfo.start;
        const currentEnd = rangeInfo.end;
        const months = rangeInfo.months || 1;

        const previousEnd = new Date(Date.UTC(currentStart.getUTCFullYear(), currentStart.getUTCMonth(), 0, 23, 59, 59));
        const previousStart = startOfMonth(addMonths(previousEnd, -(months - 1)));

        let currentCount = 0;
        let previousCount = 0;
        events.forEach(event => {
            if (!matchesFilters(event, filters)) {
                return;
            }
            if (event.date >= currentStart && event.date <= currentEnd) {
                currentCount += 1;
            } else if (event.date >= previousStart && event.date <= previousEnd) {
                previousCount += 1;
            }
        });

        if (previousCount === 0) {
            return {
                percent: currentCount > 0 ? 100 : 0,
                direction: currentCount > 0 ? 'up' : 'flat',
                currentCount,
                previousCount
            };
        }

        const percent = ((currentCount - previousCount) / previousCount) * 100;
        let direction = 'flat';
        if (percent > 8) direction = 'up';
        if (percent < -12) direction = 'down';

        return { percent, direction, currentCount, previousCount };
    }

    function buildView(analytics, filters) {
        if (!analytics || !analytics.events.length) {
            return null;
        }
        const rangeInfo = getRange(analytics.latestDate, filters.timeRange, filters.monthFocus);
        const countsByMonth = new Map();
        const heatmap = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
        const topicCounts = {};
        const contentMix = { textOnly: 0, links: 0, media: 0 };
        const daySet = new Set();
        const hourCounts = new Array(24).fill(0);
        const dayCounts = new Array(7).fill(0);

        let posts = 0;
        let comments = 0;
        let minDate = null;
        let maxDate = null;

        analytics.events.forEach(event => {
            if (!isWithinRange(event, rangeInfo)) {
                return;
            }
            if (!matchesFilters(event, filters)) {
                return;
            }

            countsByMonth.set(event.monthKey, (countsByMonth.get(event.monthKey) || 0) + 1);
            heatmap[event.dayIndex][event.hour] += 1;
            daySet.add(event.dateKey);
            hourCounts[event.hour] += 1;
            dayCounts[event.dayIndex] += 1;

            if (event.type === 'share') {
                posts += 1;
                if (event.hasMedia) {
                    contentMix.media += 1;
                } else if (event.hasLink) {
                    contentMix.links += 1;
                } else {
                    contentMix.textOnly += 1;
                }
            } else {
                comments += 1;
            }

            event.topicSet.forEach(topic => {
                topicCounts[topic] = (topicCounts[topic] || 0) + 1;
            });

            if (!minDate || event.date < minDate) {
                minDate = event.date;
            }
            if (!maxDate || event.date > maxDate) {
                maxDate = event.date;
            }
        });

        const timeline = buildTimeline(countsByMonth, rangeInfo, minDate, maxDate);
        const topics = Object.entries(topicCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 12)
            .map(([topic, count]) => ({ topic, count }));
        const streaks = calculateStreaksFromDays(daySet);
        const peakHour = getPeakHourFromCounts(hourCounts);
        const peakDay = getPeakDayFromCounts(dayCounts);
        const trend = computeTrend(analytics.events, rangeInfo, filters);

        return {
            rangeInfo,
            timeline,
            heatmap,
            topics,
            contentMix,
            streaks,
            peakHour,
            peakDay,
            trend,
            totals: {
                posts,
                comments,
                total: posts + comments
            }
        };
    }

    function generateInsights(view) {
        if (!view || !view.events.length) {
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

        if (view.topics.length) {
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
