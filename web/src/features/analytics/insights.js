/* LinkedIn Analyzer: Analytics insight generation */

import { DAY_LABELS } from "./constants.js";

/** @typedef {import("./activity.js").ActivityTrend} ActivityTrend */
/** @typedef {import("./activity.js").AnalyticsView} AnalyticsView */
/** @typedef {import("./activity.js").Insight} Insight */
/** @typedef {import("./activity.js").InsightsResult} InsightsResult */

/**
 * An insight card before its placeholders are filled.
 * @typedef {object} InsightTemplate
 * @property {string} id - Stable insight ID
 * @property {string} title - Card title
 * @property {string} template - Card text with "{placeholder}" slots
 * @property {string} icon - Icon name
 * @property {string} accent - Accent class name
 */

// Comment-to-post ratio tiers, highest threshold first so `find` matches the
// strongest tier a value qualifies for.
const ENGAGER_TIERS = Object.freeze([
    { min: 25, title: "Engagement Machine", note: "Conversations are clearly your superpower." },
    { min: 10, title: "Community Builder", note: "You invest heavily in other people's posts." },
    { min: 3, title: "Super Engager", note: "You build community." },
]);
// Activity-streak tiers, highest threshold first.
const STREAK_TIERS = Object.freeze([
    { min: 100, title: "Unstoppable Streak" },
    { min: 30, title: "Streak Master" },
    { min: 7, title: "Consistency Streak" },
]);
// Time-of-day archetypes, matched against the peak posting hour.
const TIME_OF_DAY_INSIGHTS = Object.freeze([
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
]);
// Trend cards keyed by the view's trend direction.
/** @type {Readonly<Partial<Record<ActivityTrend["direction"], InsightTemplate>>>} */
const TREND_INSIGHTS = Object.freeze({
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
});

// Shown when the peak hour matches no time-of-day archetype.
/** @type {Readonly<InsightTemplate>} */
const STEADY_PACE_INSIGHT = Object.freeze({
    id: "steady-pace",
    title: "Steady Rhythm",
    template: "Most activity happens around {hour}. You keep a consistent rhythm.",
    icon: "calendar",
    accent: "accent-blue",
});

/**
 * Format an hour of the day as a 24-hour clock time.
 * @param {number} hour - Hour from 0 to 23
 * @returns {string} Time such as "09:00"
 */
function formatHour(hour) {
    return `${String(hour).padStart(2, "0")}:00`;
}

/**
 * Turn a template and its filled-in text into an insight card.
 * @param {InsightTemplate} template - Card definition
 * @param {string} body - Card text with the placeholders filled in
 * @returns {Insight} The card
 */
function cardFromTemplate(template, body) {
    return {
        id: template.id,
        title: template.title,
        body,
        icon: template.icon,
        accent: template.accent,
    };
}

/**
 * @param {number} peakHour - Hour of the day with the most activity
 * @returns {Insight} The time-of-day card
 */
function timeOfDayInsight(peakHour) {
    const template =
        TIME_OF_DAY_INSIGHTS.find(
            (i) =>
                (i.max !== undefined && peakHour <= i.max) ||
                (i.min !== undefined && peakHour >= i.min),
        ) || STEADY_PACE_INSIGHT;
    return cardFromTemplate(template, template.template.replace("{hour}", formatHour(peakHour)));
}

/**
 * @param {ActivityTrend|null} trend - Activity change against the previous period
 * @returns {Insight|null} The trend card, or null without a trend to report
 */
function trendInsight(trend) {
    const template = trend && TREND_INSIGHTS[trend.direction];
    if (!trend || !template) {
        return null;
    }
    const percent = String(Math.abs(Math.round(trend.percent)));
    return cardFromTemplate(template, template.template.replace("{pct}", percent));
}

/**
 * @param {AnalyticsView["topicShift"]} topicShift - Topic change between periods
 * @returns {Insight|null} The focus-shift card, or null when the topic held steady
 */
function topicShiftInsight(topicShift) {
    if (!topicShift) {
        return null;
    }
    return {
        id: "topic-shift",
        title: "Focus Shift",
        body: `Your focus shifted from ${topicShift.from} to ${topicShift.to}.`,
        icon: "compass",
        accent: "accent-purple",
    };
}

/**
 * @param {AnalyticsView["ratioTrend"]} ratioTrend - Change in the comment-to-post balance
 * @returns {Insight|null} The engagement-style card, or null when the balance held steady
 */
function engagementShiftInsight(ratioTrend) {
    if (!ratioTrend) {
        return null;
    }
    return {
        id: "engagement-shift",
        title: "Engagement Style Shift",
        body:
            ratioTrend.direction === "more-engaging"
                ? "You are commenting more and posting less than before, leaning into conversations."
                : "You are posting more and commenting less than before, leaning into creating.",
        icon: "scale",
        accent: "accent-blue",
    };
}

/**
 * @param {number} total - Posts and comments in the period
 * @returns {Insight|null} The quiet-stretch card, or null for an active period
 */
function quietStretchInsight(total) {
    if (total >= 12) {
        return null;
    }
    return {
        id: "quiet-stretch",
        title: "Quiet Stretch",
        body: "This period is lighter on activity. A small push could restart momentum.",
        icon: "monkey",
        accent: "accent-purple",
    };
}

/**
 * @param {{posts: number, comments: number}} totals - Posts and comments in the period
 * @returns {Insight|null} The engager card, or null below the lowest tier
 */
function superEngagerInsight(totals) {
    const ratio = totals.posts ? totals.comments / totals.posts : 0;
    const tier = ENGAGER_TIERS.find((candidate) => ratio >= candidate.min);
    if (!tier) {
        return null;
    }
    return {
        id: "super-engager",
        title: tier.title,
        body: `You comment ${ratio.toFixed(1)}x more than you post. ${tier.note}`,
        icon: "handshake",
        accent: "accent-green",
    };
}

/**
 * @param {AnalyticsView["topics"]} topics - Topics ranked by mentions
 * @returns {Insight|null} The top-topic card, or null without topics
 */
function topTopicInsight(topics) {
    if (!Array.isArray(topics) || !topics.length) {
        return null;
    }
    const topTopic = topics[0];
    return {
        id: "topic-master",
        title: "Topic Focus",
        body: `${topTopic.topic} shows up ${topTopic.count} times in your recent activity.`,
        icon: "trophy",
        accent: "accent-yellow",
    };
}

/**
 * @param {number} currentStreak - Consecutive active days up to the end of the period
 * @returns {Insight|null} The streak card, or null below the lowest tier
 */
function streakInsight(currentStreak) {
    const tier = STREAK_TIERS.find((candidate) => currentStreak >= candidate.min);
    if (!tier) {
        return null;
    }
    return {
        id: "streak",
        title: tier.title,
        body: `You have a ${currentStreak}-day activity streak going.`,
        icon: "flame",
        accent: "accent-red",
    };
}

/**
 * @param {string} dayLabel - Name of the busiest weekday
 * @returns {Insight} The peak-day card
 */
function peakDayInsight(dayLabel) {
    return {
        id: "weekday",
        title: "Peak Day",
        body: `${dayLabel} is your strongest day for activity.`,
        icon: "calendar",
        accent: "accent-blue",
    };
}

/**
 * @param {Insight|null} insight - A card, or null for a card that does not apply
 * @returns {insight is Insight} Whether there is a card
 */
function isInsight(insight) {
    return insight !== null;
}

/**
 * Derive the narrative insight cards and closing tip from a built view.
 * @param {AnalyticsView|null} view - View model produced by buildView
 * @returns {InsightsResult} Insight cards and tip
 */
export function generateInsights(view) {
    if (!view || !view.totals || view.totals.total === 0) {
        return { insights: [], tip: null };
    }

    const peakHour = view.peakHour.hour;
    const peakDayLabel = DAY_LABELS[view.peakDay.dayIndex];

    const insights = [
        timeOfDayInsight(peakHour),
        trendInsight(view.trend),
        topicShiftInsight(view.topicShift),
        engagementShiftInsight(view.ratioTrend),
        quietStretchInsight(view.totals.total),
        superEngagerInsight(view.totals),
        topTopicInsight(view.topics),
        streakInsight(view.streaks.current),
        peakDayInsight(peakDayLabel),
    ].filter(isInsight);

    // Pip speaks the tip in the app, so it is written in his voice.
    const tip = `You are sharpest on ${peakDayLabel} around ${formatHour(peakHour)}. I would post then.`;

    return { insights, tip };
}
