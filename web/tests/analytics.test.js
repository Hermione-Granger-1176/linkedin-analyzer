const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const AnalyticsEngine = require(path.join(__dirname, '..', 'js', 'analytics.js'));

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

test('compute aggregates totals and base indices', () => {
    const { shares, comments } = sampleData();
    const analytics = AnalyticsEngine.compute(shares, comments);

    assert.equal(analytics.totals.posts, 3);
    assert.equal(analytics.totals.comments, 2);
    assert.equal(analytics.totals.total, 5);

    assert.ok(Object.keys(analytics.months).length > 0);
    assert.ok(Object.keys(analytics.dayIndex).length > 0);
});

test('buildView respects topic and shareType filters', () => {
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

    assert.equal(viewAll.totals.total, 5);
    assert.equal(viewAll.contentMix.media, 1);

    const topTopics = viewAll.topics.map(item => item.topic);
    assert.ok(topTopics.includes('excel'));

    const viewTopic = AnalyticsEngine.buildView(analytics, {
        timeRange: 'all',
        topic: 'excel',
        monthFocus: null,
        day: null,
        hour: null,
        shareType: 'all'
    });

    assert.equal(viewTopic.totals.total, 3);

    const viewMedia = AnalyticsEngine.buildView(analytics, {
        timeRange: 'all',
        topic: 'all',
        monthFocus: null,
        day: null,
        hour: null,
        shareType: 'media'
    });

    assert.equal(viewMedia.totals.posts, 1);
    assert.equal(viewMedia.totals.comments, 0);
});

test('buildView respects day and hour filters', () => {
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

    assert.equal(view.totals.total, 1);
    assert.equal(view.totals.posts, 1);
    assert.equal(view.totals.comments, 0);
});

test('generateInsights handles empty views safely', () => {
    const result = AnalyticsEngine.generateInsights({ totals: { total: 0 } });
    assert.deepEqual(result.insights, []);
    assert.equal(result.tip, null);
});
