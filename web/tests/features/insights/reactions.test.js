import { describe, expect, it } from "vitest";

import { generateInsights } from "../../../src/features/analytics/insights.js";
import { buildInsightReaction } from "../../../src/features/insights/reactions.js";

/* Every id features/analytics/insights.js can put on a card, with the pose it
   is meant to get. The markers are the parts of the SVG that only that pose
   carries, so a pose swapped onto the wrong id fails here. */
const POSED_IDS = [
    ["early-bird", "M55 84 Q40 74 36 60"],
    ["night-owl", "M97 42 H114 V58 Q114 64 105.5 64 Q97 64 97 58 Z"],
    ["steady-pace", "M99.6 54.1 L112.1 41.6 A5.5 5.5 0 0 1 119.9 49.4 L107.4 61.9 Z"],
    ["trending-up", "M90 77 Q96 70 95 63"],
    ["slowing", "pip-drop"],
    ["topic-shift", "M114 40 L120 46 L114 52"],
    ["engagement-shift", "L99 40 V34"],
    ["quiet-stretch", "insight-reaction-zzz"],
    ["super-engager", "M110 58 V46 Q110 42 113 42 Q116 42 116 46 V58 Z"],
    ["topic-master", "pip-pencil"],
    ["streak", "M114 52 l9 -3"],
    ["weekday", "M99.6 54.1 L112.1 41.6 A5.5 5.5 0 0 1 119.9 49.4 L107.4 61.9 Z"],
];

describe("buildInsightReaction", () => {
    it("stamps a decorative, inert Pip that reuses the shared wobble filter", () => {
        const markup = buildInsightReaction("trending-up");

        expect(markup).toContain('class="insight-reaction"');
        expect(markup).toContain('aria-hidden="true"');
        expect(markup).toContain('focusable="false"');
        expect(markup).toContain('filter="url(#pipWobble)"');
    });

    it.each(POSED_IDS)("gives %s its own pose", (id, marker) => {
        expect(buildInsightReaction(id)).toContain(marker);
    });

    it("covers every insight id the analytics rules can generate", () => {
        // Drives the rules hard enough to emit all of them at once: a peak hour
        // of 03:00 for the early bird, a rising trend, a topic shift, a ratio
        // shift, a light period, a comment-heavy ratio, topics, and a streak.
        const view = {
            totals: { total: 8, posts: 1, comments: 30 },
            peakHour: { hour: 3 },
            peakDay: { dayIndex: 2 },
            trend: { direction: "up", percent: 42 },
            topicShift: { from: "hiring", to: "design" },
            ratioTrend: { direction: "more-engaging" },
            topics: [{ topic: "design", count: 12 }],
            streaks: { current: 120 },
        };
        const generated = generateInsights(view).insights.map((insight) => insight.id);
        // The two rules the above cannot reach at the same time: a peak hour is
        // one number, so it is early-bird or night-owl or steady-pace, and a
        // trend runs one way or the other.
        const alternatives = ["night-owl", "steady-pace", "slowing"];
        const posed = POSED_IDS.map(([id]) => id);

        expect(new Set([...generated, ...alternatives])).toEqual(new Set(posed));
    });

    it.each([["unknown-insight"], [""], [undefined], [null], ["constructor"], ["toString"]])(
        "falls back to the neutral pose for %s",
        (id) => {
            const markup = buildInsightReaction(id);

            expect(markup).toBe(buildInsightReaction("no-such-insight"));
            // The resting arms, and none of the props any posed id carries.
            expect(markup).toContain("M85 84 Q96 92 97 102");
            expect(markup).not.toContain("pip-pencil");
            expect(markup).not.toContain("insight-reaction-zzz");
        },
    );

    it("stands every pose upright except the doze, which leans on the card edge", () => {
        expect(buildInsightReaction("quiet-stretch")).toContain('transform="rotate(8 70 96)"');
        expect(buildInsightReaction("weekday")).toContain('transform="rotate(0 70 96)"');
    });

    it("renders as a single element that parses into real SVG", () => {
        const host = document.createElement("div");
        host.innerHTML = buildInsightReaction("topic-master");

        expect(host.childElementCount).toBe(1);
        expect(host.firstElementChild.tagName.toLowerCase()).toBe("svg");
        expect(host.firstElementChild.getAttribute("viewBox")).toBe("26 4 98 98");
    });
});
