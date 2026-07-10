/* LinkedIn Analyzer - Analytics insight generation */

import { DAY_LABELS } from "./analytics-constants.js";

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

/**
 * Derive the narrative insight cards and closing tip from a built view.
 * @param {object|null} view - View model produced by buildView
 * @returns {{ insights: object[], tip: string|null }} Insight cards and tip
 */
export function generateInsights(view) {
    if (!view || !view.totals || view.totals.total === 0) {
        return { insights: [], tip: null };
    }

    const insights = [];
    const peakHour = view.peakHour.hour;
    const peakDayLabel = DAY_LABELS[view.peakDay.dayIndex];

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

    if (view.topicShift) {
        insights.push({
            id: "topic-shift",
            title: "Focus Shift",
            body: `Your focus shifted from ${view.topicShift.from} to ${view.topicShift.to}.`,
            icon: "compass",
            accent: "accent-purple",
        });
    }

    if (view.ratioTrend) {
        insights.push({
            id: "engagement-shift",
            title: "Engagement Style Shift",
            body:
                view.ratioTrend.direction === "more-engaging"
                    ? "You are commenting more and posting less than before, leaning into conversations."
                    : "You are posting more and commenting less than before, leaning into creating.",
            icon: "scale",
            accent: "accent-blue",
        });
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
    const engagerTier = ENGAGER_TIERS.find((tier) => ratio >= tier.min);
    if (engagerTier) {
        insights.push({
            id: "super-engager",
            title: engagerTier.title,
            body: `You comment ${ratio.toFixed(1)}x more than you post. ${engagerTier.note}`,
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

    const streakTier = STREAK_TIERS.find((tier) => view.streaks.current >= tier.min);
    if (streakTier) {
        insights.push({
            id: "streak",
            title: streakTier.title,
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
