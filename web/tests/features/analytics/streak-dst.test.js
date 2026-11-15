import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AnalyticsEngine } from "../../../src/features/analytics/activity.js";

// Longest-streak detection compares local-midnight dates. Across a DST
// transition two consecutive calendar days are 23h (or 25h) apart. These tests
// pin a timezone that observes DST, so the boundary is checked the same way
// in every environment.
describe("AnalyticsEngine longest streak across DST boundaries", () => {
    const originalTz = process.env.TZ;

    beforeAll(() => {
        process.env.TZ = "America/New_York";
    });

    afterAll(() => {
        if (originalTz === undefined) {
            delete process.env.TZ;
        } else {
            process.env.TZ = originalTz;
        }
    });

    function shareOn(date) {
        return {
            Date: `${date} 12:00:00`,
            ShareCommentary: "post",
            SharedUrl: "",
            MediaUrl: "",
            ShareLink: "https://linkedin.com",
            Visibility: "MEMBER_NETWORK"
        };
    }

    function longestStreakFor(dates) {
        const analytics = AnalyticsEngine.compute(dates.map(shareOn), []);
        const view = AnalyticsEngine.buildView(analytics, {
            timeRange: "all",
            topic: "all",
            monthFocus: null,
            day: null,
            hour: null,
            shareType: "all"
        });
        return view.streaks.longest;
    }

    it("counts consecutive days spanning the spring-forward transition", () => {
        // US Eastern springs forward on 2025-03-09; local midnight 03-09 -> 03-10
        // is 23h apart. The three days form one streak of 3.
        expect(longestStreakFor(["2025-03-08", "2025-03-09", "2025-03-10"])).toBe(3);
    });

    it("counts consecutive days spanning the fall-back transition", () => {
        // US Eastern falls back on 2025-11-02; local midnight 11-02 -> 11-03
        // is 25h apart. The three days form one streak of 3.
        expect(longestStreakFor(["2025-11-01", "2025-11-02", "2025-11-03"])).toBe(3);
    });
});
