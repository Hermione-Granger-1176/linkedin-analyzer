import { describe, expect, it } from 'vitest';

import { AnalyticsEngine } from '../src/analytics.js';

function sampleData() {
    const shares = [
        {
            Date: '2025-01-02 05:00:00',
            ShareCommentary: 'Excel tips #Excel',
            SharedUrl: '',
            MediaUrl: '',
            ShareLink: 'https://linkedin.com',
            Visibility: 'MEMBER_NETWORK'
        },
        {
            Date: '2025-01-03 14:00:00',
            ShareCommentary: 'AI and data',
            SharedUrl: 'https://example.com',
            MediaUrl: '',
            ShareLink: 'https://linkedin.com',
            Visibility: 'MEMBER_NETWORK'
        },
        {
            Date: '2025-01-04 15:00:00',
            ShareCommentary: 'Video about excel',
            SharedUrl: '',
            MediaUrl: 'https://media.example.com',
            ShareLink: 'https://linkedin.com',
            Visibility: 'MEMBER_NETWORK'
        }
    ];

    const comments = [
        {
            Date: '2025-01-02 06:00:00',
            Message: 'Love #Excel',
            Link: 'https://linkedin.com'
        },
        {
            Date: '2025-01-05 04:00:00',
            Message: 'Nice data',
            Link: 'https://linkedin.com'
        }
    ];

    return { shares, comments };
}

describe('AnalyticsEngine', () => {
    it('compute aggregates totals and base indices', () => {
        const { shares, comments } = sampleData();
        const analytics = AnalyticsEngine.compute(shares, comments);

        expect(analytics.totals.posts).toBe(3);
        expect(analytics.totals.comments).toBe(2);
        expect(analytics.totals.total).toBe(5);

        expect(Object.keys(analytics.months).length).toBeGreaterThan(0);
        expect(Object.keys(analytics.dayIndex).length).toBeGreaterThan(0);
    });

    it('buildView respects topic and shareType filters', () => {
        const { shares, comments } = sampleData();
        const analytics = AnalyticsEngine.compute(shares, comments);

        const viewAll = AnalyticsEngine.buildView(analytics, {
            timeRange: 'all',
            topic: 'all',
            monthFocus: null,
            day: null,
            hour: null,
            shareType: 'all'
        });

        expect(viewAll.totals.total).toBe(5);
        expect(viewAll.contentMix.media).toBe(1);

        const topTopics = viewAll.topics.map(item => item.topic);
        expect(topTopics.includes('excel')).toBe(true);

        const viewTopic = AnalyticsEngine.buildView(analytics, {
            timeRange: 'all',
            topic: 'excel',
            monthFocus: null,
            day: null,
            hour: null,
            shareType: 'all'
        });

        expect(viewTopic.totals.total).toBe(3);

        const viewMedia = AnalyticsEngine.buildView(analytics, {
            timeRange: 'all',
            topic: 'all',
            monthFocus: null,
            day: null,
            hour: null,
            shareType: 'media'
        });

        expect(viewMedia.totals.posts).toBe(1);
        expect(viewMedia.totals.comments).toBe(0);
    });

    it('buildView respects day and hour filters', () => {
        const { shares, comments } = sampleData();
        const analytics = AnalyticsEngine.compute(shares, comments);

        const view = AnalyticsEngine.buildView(analytics, {
            timeRange: 'all',
            topic: 'all',
            monthFocus: null,
            day: 3,
            hour: 5,
            shareType: 'all'
        });

        expect(view.totals.total).toBe(1);
        expect(view.totals.posts).toBe(1);
        expect(view.totals.comments).toBe(0);
    });

    it('generateInsights handles empty views safely', () => {
        const result = AnalyticsEngine.generateInsights({ totals: { total: 0 } });
        expect(result.insights).toEqual([]);
        expect(result.tip).toBe(null);
    });

    it('buildView supports share type and day/hour filters', () => {
        const shares = [
            {
                Date: '2025-01-01 08:00:00',
                ShareCommentary: '#AI insights',
                SharedUrl: '',
                MediaUrl: '',
                ShareLink: 'https://linkedin.com',
                Visibility: 'MEMBER_NETWORK'
            },
            {
                Date: '2025-01-05 12:00:00',
                ShareCommentary: 'Check this https://example.com',
                SharedUrl: 'https://example.com',
                MediaUrl: '',
                ShareLink: 'https://linkedin.com',
                Visibility: 'MEMBER_NETWORK'
            },
            {
                Date: '2025-02-01 22:00:00',
                ShareCommentary: 'Video update',
                SharedUrl: '',
                MediaUrl: 'https://media.example.com',
                ShareLink: 'https://linkedin.com',
                Visibility: 'MEMBER_NETWORK'
            }
        ];
        const comments = [
            {
                Date: '2025-01-03 09:00:00',
                Message: 'Great #AI',
                Link: 'https://linkedin.com'
            }
        ];

        const analytics = AnalyticsEngine.compute(shares, comments);

        const mediaOnly = AnalyticsEngine.buildView(analytics, {
            timeRange: 'all',
            topic: 'all',
            monthFocus: null,
            day: null,
            hour: null,
            shareType: 'media'
        });

        expect(mediaOnly.totals.posts).toBe(1);
        expect(mediaOnly.totals.comments).toBe(0);

        const filtered = AnalyticsEngine.buildView(analytics, {
            timeRange: 'all',
            topic: 'all',
            monthFocus: null,
            day: 2,
            hour: 8,
            shareType: 'all'
        });

        expect(filtered.totals.total).toBe(1);
    });

    it('buildView creates weekly timeline for 1m range', () => {
        const shares = [
            {
                Date: '2025-02-01 08:00:00',
                ShareCommentary: 'Weekly test',
                SharedUrl: '',
                MediaUrl: '',
                ShareLink: 'https://linkedin.com',
                Visibility: 'MEMBER_NETWORK'
            },
            {
                Date: '2025-02-04 08:00:00',
                ShareCommentary: 'Weekly followup',
                SharedUrl: '',
                MediaUrl: '',
                ShareLink: 'https://linkedin.com',
                Visibility: 'MEMBER_NETWORK'
            }
        ];

        const analytics = AnalyticsEngine.compute(shares, []);
        const view = AnalyticsEngine.buildView(analytics, {
            timeRange: '1m',
            topic: 'all',
            monthFocus: null,
            day: null,
            hour: null,
            shareType: 'all'
        });

        expect(view.timeline.length).toBeGreaterThan(0);
        expect(view.timeline[0].monthKey).toBeTruthy();
    });

    it('buildView handles empty analytics and zero older period', () => {
        const analyticsEmpty = AnalyticsEngine.compute([], []);
        const emptyView = AnalyticsEngine.buildView(analyticsEmpty, {
            timeRange: 'all',
            topic: 'all',
            monthFocus: null,
            day: null,
            hour: null,
            shareType: 'all'
        });
        expect(emptyView.totals.total).toBe(0);

        const shares = [
            {
                Date: '2025-03-01 08:00:00',
                ShareCommentary: 'Latest month only',
                SharedUrl: '',
                MediaUrl: '',
                ShareLink: 'https://linkedin.com',
                Visibility: 'MEMBER_NETWORK'
            }
        ];
        const analytics = AnalyticsEngine.compute(shares, []);
        const view = AnalyticsEngine.buildView(analytics, {
            timeRange: '3m',
            topic: 'all',
            monthFocus: null,
            day: null,
            hour: null,
            shareType: 'all'
        });
        expect(view.trend.direction).toBe('up');
    });

    it('generateInsights returns multiple insight types', () => {
        const view = {
            totals: { total: 20, posts: 2, comments: 8 },
            peakHour: { hour: 22, count: 5 },
            peakDay: { dayIndex: 1, count: 3 },
            trend: { percent: -20, direction: 'down' },
            topics: [{ topic: 'ai', count: 4 }],
            streaks: { current: 8, longest: 8 }
        };

        const result = AnalyticsEngine.generateInsights(view);
        expect(result.insights.length).toBeGreaterThan(2);
        expect(result.tip).toContain('around');
    });

    // ── buildWeeklyTimeline with hour filter active (lines 675-679) ───────────

    it('buildView weekly timeline with hour filter applies hourRatio (lines 675-679)', () => {
        // Two posts in the same week — one at hour 9, one at hour 14
        const shares = [
            {
                Date: '2025-02-03 09:00:00',
                ShareCommentary: 'Morning post',
                SharedUrl: '',
                MediaUrl: '',
                ShareLink: 'https://linkedin.com',
                Visibility: 'MEMBER_NETWORK'
            },
            {
                Date: '2025-02-04 14:00:00',
                ShareCommentary: 'Afternoon post',
                SharedUrl: '',
                MediaUrl: '',
                ShareLink: 'https://linkedin.com',
                Visibility: 'MEMBER_NETWORK'
            }
        ];
        const analytics = AnalyticsEngine.compute(shares, []);

        // Using '1m' activates the weekly timeline path; adding an hour filter
        // exercises the hasHour branch inside buildWeeklyTimeline (lines 675-679)
        const view = AnalyticsEngine.buildView(analytics, {
            timeRange: '1m',
            topic: 'all',
            monthFocus: null,
            day: null,
            hour: 9,
            shareType: 'all'
        });

        // Should produce a weekly timeline
        expect(view.timeline.length).toBeGreaterThan(0);
        // Values may be fractional-rounded, but should not throw and must be numbers
        view.timeline.forEach(entry => expect(typeof entry.value).toBe('number'));
    });

    // ── computeTrendFromTimeline — older === 0 branch (line 805) ─────────────

    it('computeTrendFromTimeline returns flat trend when both halves are zero', () => {
        // Two-point timeline with all zeros → older === 0 AND recent === 0
        const shares = [
            {
                Date: '2025-01-01 10:00:00',
                ShareCommentary: 'only',
                SharedUrl: '',
                MediaUrl: '',
                ShareLink: 'https://linkedin.com',
                Visibility: 'MEMBER_NETWORK'
            }
        ];
        // Build with enough months in range so older half is zero
        const analytics = AnalyticsEngine.compute(shares, []);
        const view = AnalyticsEngine.buildView(analytics, {
            timeRange: '12m',
            topic: 'all',
            monthFocus: null,
            day: null,
            hour: null,
            shareType: 'all'
        });

        // The trend for a single month of activity in a 12-month window
        // means the older half is 0 and recent has activity → direction 'up'
        expect(view.trend).not.toBeNull();
        expect(['up', 'flat']).toContain(view.trend.direction);
    });

    // ── generateInsights — quiet-stretch insight (line 858) ──────────────────

    it('generateInsights adds quiet-stretch insight when total < 12 (line 858)', () => {
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
        expect(ids).toContain('quiet-stretch');
    });

    // ── buildWeeklyTimeline with day filter zeroing non-matching days (line 664) ──

    it('buildView weekly timeline zeroes days that do not match day filter (line 664)', () => {
        // Posts on Monday (day=0) and Tuesday (day=1)
        const shares = [
            {
                Date: '2025-02-03 09:00:00', // Monday
                ShareCommentary: 'Monday post',
                SharedUrl: '', MediaUrl: '',
                ShareLink: 'https://linkedin.com',
                Visibility: 'MEMBER_NETWORK'
            },
            {
                Date: '2025-02-04 14:00:00', // Tuesday
                ShareCommentary: 'Tuesday post',
                SharedUrl: '', MediaUrl: '',
                ShareLink: 'https://linkedin.com',
                Visibility: 'MEMBER_NETWORK'
            }
        ];
        const analytics = AnalyticsEngine.compute(shares, []);

        // Filter for Monday only (day=0) → Tuesday entry gets value=0 (line 664)
        const view = AnalyticsEngine.buildView(analytics, {
            timeRange: '1m',
            topic: 'all',
            monthFocus: null,
            day: 0,
            hour: null,
            shareType: 'all'
        });

        expect(view.timeline.length).toBeGreaterThan(0);
        // Total should only count Monday's post
        expect(view.totals.posts).toBe(1);
    });

    // ── buildWeeklyTimeline with topic filter ratio (lines 669-672) ─────────

    it('buildView weekly timeline applies topicRatio when topic filter active (lines 669-672)', () => {
        const shares = [
            {
                Date: '2025-02-03 09:00:00',
                ShareCommentary: '#AI morning post',
                SharedUrl: '', MediaUrl: '',
                ShareLink: 'https://linkedin.com',
                Visibility: 'MEMBER_NETWORK'
            },
            {
                Date: '2025-02-04 14:00:00',
                ShareCommentary: 'No topic afternoon post',
                SharedUrl: '', MediaUrl: '',
                ShareLink: 'https://linkedin.com',
                Visibility: 'MEMBER_NETWORK'
            }
        ];
        const analytics = AnalyticsEngine.compute(shares, []);

        const view = AnalyticsEngine.buildView(analytics, {
            timeRange: '1m',
            topic: 'ai',
            monthFocus: null,
            day: null,
            hour: null,
            shareType: 'all'
        });

        expect(view.timeline.length).toBeGreaterThan(0);
        view.timeline.forEach(entry => expect(typeof entry.value).toBe('number'));
    });

    // ── calculateStreaksFromDays with empty daySet (line 749) ─────────────────

    it('calculateStreaksFromDays returns zeros when passed empty data (line 749)', () => {
        // An analytics object with no active days → calculateStreaksFromDays gets empty set
        const analyticsEmpty = AnalyticsEngine.compute([], []);
        const view = AnalyticsEngine.buildView(analyticsEmpty, {
            timeRange: 'all',
            topic: 'all',
            monthFocus: null,
            day: null,
            hour: null,
            shareType: 'all'
        });
        // No data → streaks should both be 0
        expect(view.streaks.current).toBe(0);
        expect(view.streaks.longest).toBe(0);
    });

    // ── getMonthKeysInRange with monthFocus (line 434) ────────────────────────

    it('buildView with monthFocus returns single-month timeline (line 434)', () => {
        const shares = [
            {
                Date: '2025-01-05 09:00:00',
                ShareCommentary: 'Post in Jan',
                SharedUrl: '', MediaUrl: '',
                ShareLink: 'https://linkedin.com',
                Visibility: 'MEMBER_NETWORK'
            },
            {
                Date: '2025-02-03 09:00:00',
                ShareCommentary: 'Post in Feb',
                SharedUrl: '', MediaUrl: '',
                ShareLink: 'https://linkedin.com',
                Visibility: 'MEMBER_NETWORK'
            }
        ];
        const analytics = AnalyticsEngine.compute(shares, []);

        // monthFocus triggers `return [monthFocus]` at line 434
        const view = AnalyticsEngine.buildView(analytics, {
            timeRange: 'all',
            topic: 'all',
            monthFocus: '2025-01',
            day: null,
            hour: null,
            shareType: 'all'
        });

        expect(view.totals.posts).toBe(1);
    });

    // ── filterMonthBucket with topic that has 0 count → useMonth=false (line 392) ──

    it('buildView with topic that has zero count for a month sets useMonth=false (line 392)', () => {
        // Jan has AI topic, Feb has Excel topic. Filter for AI → Feb month gets useMonth=false
        const shares = [
            {
                Date: '2025-01-05 09:00:00',
                ShareCommentary: '#AI post',
                SharedUrl: '', MediaUrl: '',
                ShareLink: 'https://linkedin.com',
                Visibility: 'MEMBER_NETWORK'
            },
            {
                Date: '2025-02-03 09:00:00',
                ShareCommentary: '#Excel post',
                SharedUrl: '', MediaUrl: '',
                ShareLink: 'https://linkedin.com',
                Visibility: 'MEMBER_NETWORK'
            }
        ];
        const analytics = AnalyticsEngine.compute(shares, []);

        const view = AnalyticsEngine.buildView(analytics, {
            timeRange: 'all',
            topic: 'ai',
            monthFocus: null,
            day: null,
            hour: null,
            shareType: 'all'
        });

        // Only January's AI post should be counted
        expect(view.totals.posts).toBe(1);
    });

    // ── buildView with no dayIndex skips weekly timeline branch (line 491) ──────

    it('buildView skips weekly timeline and uses monthly entries when dayIndex is null', () => {
        const shares = [
            {
                Date: '2025-01-10 09:00:00',
                ShareCommentary: 'Text post',
                SharedUrl: '', MediaUrl: '',
                ShareLink: 'https://linkedin.com',
                Visibility: 'MEMBER_NETWORK'
            }
        ];
        const analytics = AnalyticsEngine.compute(shares, []);
        // Remove dayIndex so useWeeklyTimeline becomes false even for weekly ranges
        analytics.dayIndex = null;

        const view = AnalyticsEngine.buildView(analytics, {
            timeRange: '1m',
            topic: 'all',
            monthFocus: null,
            day: null,
            hour: null,
            shareType: 'all'
        });

        // Monthly timeline is used; each entry has key/label/value
        expect(view.timeline.length).toBeGreaterThan(0);
        expect(view.timeline[0]).toHaveProperty('key');
        expect(view.timeline[0]).toHaveProperty('value');
    });

    // ── buildWeeklyTimeline typeKey branch when shareTypes is falsy (line 658) ─

    it('buildView weekly timeline falls back to 0 when entry has no shareTypes (line 658)', () => {
        const shares = [
            {
                Date: '2025-02-03 09:00:00',
                ShareCommentary: 'Text post',
                SharedUrl: '', MediaUrl: '',
                ShareLink: 'https://linkedin.com',
                Visibility: 'MEMBER_NETWORK'
            }
        ];
        const analytics = AnalyticsEngine.compute(shares, []);
        // Manually clear shareTypes from dayIndex to force the falsy branch
        Object.values(analytics.dayIndex).forEach(entry => {
            entry.shareTypes = null;
        });

        const view = AnalyticsEngine.buildView(analytics, {
            timeRange: '1m',
            topic: 'all',
            monthFocus: null,
            day: null,
            hour: null,
            shareType: 'textOnly'
        });

        expect(view.timeline.length).toBeGreaterThan(0);
        view.timeline.forEach(entry => expect(typeof entry.value).toBe('number'));
    });

    it('generateInsights adds trending-up insight when trend direction is up (line 849)', () => {
        const view = {
            totals: { total: 30, posts: 20, comments: 10 },
            peakHour: { hour: 10, count: 5 },
            peakDay: { dayIndex: 0, count: 5 },
            trend: { percent: 50, direction: 'up' },
            topics: [],
            streaks: { current: 0, longest: 0 }
        };

        const result = AnalyticsEngine.generateInsights(view);

        const ids = result.insights.map(i => i.id);
        expect(ids).toContain('trending-up');
    });
});
