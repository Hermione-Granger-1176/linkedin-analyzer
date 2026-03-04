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
});
