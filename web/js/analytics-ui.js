/* Analytics page logic */

(function() {
    'use strict';

    const FILTER_DEFAULTS = Object.freeze({
        timeRange: '12m',
        topic: 'all',
        monthFocus: null,
        day: null,
        hour: null,
        shareType: 'all'
    });

    const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    const elements = {
        timeRangeButtons: document.querySelectorAll('#timeRangeButtons .filter-btn'),
        topicSelect: document.getElementById('topicSelect'),
        resetFiltersBtn: document.getElementById('resetFiltersBtn'),
        activeFilters: document.getElementById('activeFilters'),
        activeFiltersList: document.getElementById('activeFiltersList'),
        analyticsEmpty: document.getElementById('analyticsEmpty'),
        analyticsGrid: document.getElementById('analyticsGrid'),
        statsGrid: document.getElementById('statsGrid'),
        timelineChart: document.getElementById('timelineChart'),
        topicsChart: document.getElementById('topicsChart'),
        heatmapChart: document.getElementById('heatmapChart'),
        mixChart: document.getElementById('mixChart'),
        statPosts: document.getElementById('statPosts'),
        statComments: document.getElementById('statComments'),
        statTotal: document.getElementById('statTotal'),
        statPeak: document.getElementById('statPeak'),
        statStreak: document.getElementById('statStreak'),
        chartTooltip: document.getElementById('chartTooltip')
    };

    const state = {
        filters: { ...FILTER_DEFAULTS },
        analyticsReady: false,
        hasData: false,
        topics: [],
        currentView: null
    };

    const WORKER_URL = 'js/analytics-worker.js?v=20260131-1';

    let worker = null;
    let requestId = 0;
    let pendingViewId = 0;
    let lastViewKey = null;
    let lastRequestedKey = null;
    let debounceTimer = null;
    let isRendering = false;
    let pendingRender = null;

    function init() {
        bindEvents();
        initWorker();
        loadBase();
    }

    function bindEvents() {
        elements.timeRangeButtons.forEach(button => {
            button.addEventListener('click', () => handleTimeRangeChange(button));
        });
        elements.topicSelect.addEventListener('change', handleTopicChange);
        elements.resetFiltersBtn.addEventListener('click', resetFilters);
        elements.activeFiltersList.addEventListener('click', handleFilterChipClick);

        document.addEventListener('themechange', () => {
            if (state.currentView) {
                lastViewKey = state.currentView.key;
                renderAnalyticsView(state.currentView);
            }
        });

        [elements.timelineChart, elements.topicsChart, elements.heatmapChart, elements.mixChart].forEach(canvas => {
            if (!canvas) return;
            canvas.addEventListener('mousemove', handleChartHover);
            canvas.addEventListener('mouseleave', hideTooltip);
            canvas.addEventListener('click', handleChartClick);
        });
    }

    function initWorker() {
        if (typeof Worker === 'undefined') return;
        try {
            worker = new Worker(WORKER_URL);
            worker.addEventListener('message', handleWorkerMessage);
            worker.addEventListener('error', handleWorkerError);
        } catch (error) {
            worker = null;
            setEmptyState('Worker blocked', 'Open this page from a local server (not file://).');
        }
    }

    async function loadBase() {
        const analyticsBase = await Storage.getAnalytics();
        if (!analyticsBase || !Array.isArray(analyticsBase.events)) {
            setEmptyState('No data available yet', 'Upload Shares.csv or Comments.csv on the Home page.');
            return;
        }
        if (!worker) {
            setEmptyState('Analytics not supported', 'Your browser does not support analytics workers.');
            return;
        }
        setEmptyState('Preparing analytics', 'Crunching your data in the background.');
        worker.postMessage({
            type: 'initBase',
            payload: analyticsBase
        });
    }

    function handleWorkerMessage(event) {
        const message = event.data || {};
        if (message.type === 'init') {
            state.analyticsReady = true;
            state.hasData = Boolean(message.payload && message.payload.hasData);
            state.topics = (message.payload && message.payload.topics) ? message.payload.topics : [];
            updateTopicSelect();
            updateVisibility();
            scheduleViewRequest(true);
            return;
        }
        if (message.type === 'view') {
            if (message.requestId !== pendingViewId) return;
            const payload = message.payload || {};
            state.currentView = payload.view || null;
            if (state.currentView) {
                renderAnalyticsView(state.currentView);
            }
            return;
        }
        if (message.type === 'error') {
            setEmptyState('Analytics error', message.payload && message.payload.message ? message.payload.message : 'Analytics worker error.');
        }
    }

    function handleWorkerError() {
        setEmptyState('Analytics worker error', 'Refresh the page and try again.');
    }

    function getFilterKey(filters) {
        return [
            filters.timeRange,
            filters.topic,
            filters.monthFocus || 'none',
            filters.day !== null && filters.day !== undefined ? filters.day : 'none',
            filters.hour !== null && filters.hour !== undefined ? filters.hour : 'none',
            filters.shareType || 'all'
        ].join('|');
    }

    function scheduleViewRequest(force) {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        const delay = force ? 0 : 160;
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            requestView(force);
        }, delay);
    }

    function requestView(force) {
        if (!worker || !state.analyticsReady || !state.hasData) return;
        const key = getFilterKey(state.filters);
        if (!force && key === lastRequestedKey) {
            return;
        }
        lastRequestedKey = key;
        const id = ++requestId;
        pendingViewId = id;
        worker.postMessage({
            type: 'view',
            requestId: id,
            filters: { ...state.filters }
        });
        showAnalyticsLoading(true);
    }

    function renderAnalyticsView(view) {
        if (isRendering) {
            pendingRender = view;
            return;
        }
        isRendering = true;
        showAnalyticsLoading(true);
        try {
            if (!view) {
                setEmptyState('No analytics data', 'Try resetting filters.');
                return;
            }
            hideEmptyState();
            state.currentView = view;

            elements.statPosts.textContent = view.totals.posts;
            elements.statComments.textContent = view.totals.comments;
            elements.statTotal.textContent = view.totals.total;
            elements.statPeak.textContent = view.totals.total
                ? `${String(view.peakHour.hour).padStart(2, '0')}:00`
                : '-';
            elements.statStreak.textContent = view.totals.total
                ? `${view.streaks.current} days`
                : '0 days';

            renderActiveFilters();

            const animate = lastViewKey === null && shouldAnimate(view);
            lastViewKey = view.key;

            if (animate) {
                SketchCharts.animateDraw((progress) => {
                    SketchCharts.drawTimeline(elements.timelineChart, view.timeline, progress);
                }, 420);
            } else {
                SketchCharts.drawTimeline(elements.timelineChart, view.timeline, 1);
            }

            if (animate) {
                SketchCharts.animateDraw((progress) => {
                    SketchCharts.drawTopics(elements.topicsChart, view.topics, progress);
                }, 420);
            } else {
                SketchCharts.drawTopics(elements.topicsChart, view.topics, 1);
            }

            SketchCharts.drawHeatmap(elements.heatmapChart, view.heatmap);

            if (animate) {
                SketchCharts.animateDraw((progress) => {
                    SketchCharts.drawDonut(elements.mixChart, view.contentMix, progress);
                }, 420);
            } else {
                SketchCharts.drawDonut(elements.mixChart, view.contentMix, 1);
            }
        } finally {
            showAnalyticsLoading(false);
            isRendering = false;
            if (pendingRender) {
                const next = pendingRender;
                pendingRender = null;
                renderAnalyticsView(next);
            }
        }
    }

    function updateTopicSelect() {
        const current = state.filters.topic || 'all';
        elements.topicSelect.innerHTML = '<option value="all">All topics</option>';
        state.topics.slice(0, 40).forEach(topic => {
            const option = document.createElement('option');
            option.value = topic.topic;
            option.textContent = `${topic.topic} (${topic.count})`;
            elements.topicSelect.appendChild(option);
        });
        elements.topicSelect.value = current;
    }

    function updateVisibility() {
        if (!state.hasData) {
            setEmptyState('No data available yet', 'Upload Shares.csv or Comments.csv on the Home page.');
            return;
        }
        hideEmptyState();
    }

    function handleTimeRangeChange(button) {
        const range = button.getAttribute('data-range');
        if (!range) return;
        state.filters.timeRange = range;
        resetFilterState(true);
        elements.timeRangeButtons.forEach(btn => btn.classList.toggle('active', btn === button));
        scheduleViewRequest(true);
    }

    function handleTopicChange() {
        state.filters.topic = elements.topicSelect.value || 'all';
        scheduleViewRequest(false);
    }

    function resetFilters() {
        state.filters = { ...FILTER_DEFAULTS };
        elements.timeRangeButtons.forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-range') === '12m');
        });
        elements.topicSelect.value = 'all';
        scheduleViewRequest(true);
    }

    function resetFilterState(preserveTimeRange) {
        const timeRange = preserveTimeRange ? state.filters.timeRange : FILTER_DEFAULTS.timeRange;
        state.filters = { ...FILTER_DEFAULTS, timeRange };
        elements.topicSelect.value = 'all';
    }

    function handleFilterChipClick(event) {
        const button = event.target.closest('button[data-filter]');
        if (!button) return;
        const filter = button.getAttribute('data-filter');
        if (filter === 'topic') {
            state.filters.topic = 'all';
            elements.topicSelect.value = 'all';
        }
        if (filter === 'month') {
            state.filters.monthFocus = null;
        }
        if (filter === 'day') {
            state.filters.day = null;
        }
        if (filter === 'hour') {
            state.filters.hour = null;
        }
        if (filter === 'shareType') {
            state.filters.shareType = 'all';
        }
        scheduleViewRequest(false);
    }

    function renderActiveFilters() {
        const filters = [];
        if (state.filters.topic && state.filters.topic !== 'all') {
            filters.push({ key: 'topic', label: `Topic: ${state.filters.topic}` });
        }
        if (state.filters.monthFocus) {
            const [year, month] = state.filters.monthFocus.split('-').map(Number);
            const label = (year && month)
                ? `Month: ${MONTH_LABELS[month - 1]} ${year}`
                : `Month: ${state.filters.monthFocus}`;
            filters.push({ key: 'month', label });
        }
        if (state.filters.day !== null && state.filters.day !== undefined) {
            const label = DAY_LABELS[state.filters.day] || 'Unknown';
            filters.push({ key: 'day', label: `Day: ${label}` });
        }
        if (state.filters.hour !== null && state.filters.hour !== undefined) {
            filters.push({ key: 'hour', label: `Hour: ${String(state.filters.hour).padStart(2, '0')}:00` });
        }
        if (state.filters.shareType && state.filters.shareType !== 'all') {
            const map = { text: 'Text posts', links: 'Link posts', media: 'Media posts' };
            filters.push({ key: 'shareType', label: `Content: ${map[state.filters.shareType] || state.filters.shareType}` });
        }
        if (!filters.length) {
            elements.activeFilters.hidden = true;
            elements.activeFiltersList.innerHTML = '';
            return;
        }
        elements.activeFilters.hidden = false;
        elements.activeFiltersList.innerHTML = filters.map(filter =>
            `<span class="filter-chip">${filter.label}<button data-filter="${filter.key}" aria-label="Remove filter">x</button></span>`
        ).join('');
    }

    function handleChartHover(event) {
        const canvas = event.currentTarget;
        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        const item = SketchCharts.getItemAt(canvas, x, y);
        if (item && item.tooltip) {
            showTooltip(event.clientX, event.clientY, item.tooltip);
        } else {
            hideTooltip();
        }
        if (item && (item.type === 'month' || item.type === 'topic' || item.type === 'heatmap' || item.type === 'mix')) {
            canvas.style.cursor = 'pointer';
        } else {
            canvas.style.cursor = 'default';
        }
    }

    function handleChartClick(event) {
        const canvas = event.currentTarget;
        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        const item = SketchCharts.getItemAt(canvas, x, y);
        if (!item) return;
        if (item.type === 'month') {
            state.filters.monthFocus = state.filters.monthFocus === item.key ? null : item.key;
            scheduleViewRequest(false);
        }
        if (item.type === 'topic') {
            state.filters.topic = item.key;
            elements.topicSelect.value = item.key;
            scheduleViewRequest(false);
        }
        if (item.type === 'heatmap') {
            const isSame = state.filters.day === item.day && state.filters.hour === item.hour;
            state.filters.day = isSame ? null : item.day;
            state.filters.hour = isSame ? null : item.hour;
            scheduleViewRequest(false);
        }
        if (item.type === 'mix') {
            const map = { Text: 'text', Links: 'links', Media: 'media' };
            const value = map[item.label] || 'all';
            state.filters.shareType = state.filters.shareType === value ? 'all' : value;
            scheduleViewRequest(false);
        }
    }

    function showTooltip(clientX, clientY, text) {
        elements.chartTooltip.textContent = text;
        elements.chartTooltip.hidden = false;
        const tooltipRect = elements.chartTooltip.getBoundingClientRect();
        let left = clientX + 12;
        let top = clientY + 12;
        if (left + tooltipRect.width > window.innerWidth) {
            left = clientX - tooltipRect.width - 12;
        }
        if (top + tooltipRect.height > window.innerHeight) {
            top = clientY - tooltipRect.height - 12;
        }
        elements.chartTooltip.style.left = `${left}px`;
        elements.chartTooltip.style.top = `${top}px`;
    }

    function hideTooltip() {
        elements.chartTooltip.hidden = true;
    }

    function showAnalyticsLoading(isLoading) {
        elements.analyticsGrid.style.opacity = isLoading ? '0.5' : '1';
        elements.statsGrid.style.opacity = isLoading ? '0.5' : '1';
        elements.analyticsGrid.style.pointerEvents = isLoading ? 'none' : 'auto';
    }

    function setEmptyState(title, message) {
        const heading = elements.analyticsEmpty.querySelector('h2');
        const text = elements.analyticsEmpty.querySelector('p');
        if (heading) heading.textContent = title;
        if (text) text.textContent = message;
        elements.analyticsEmpty.hidden = false;
        elements.analyticsGrid.hidden = true;
        elements.statsGrid.hidden = true;
        elements.activeFilters.hidden = true;
        elements.activeFiltersList.innerHTML = '';
        showAnalyticsLoading(false);
    }

    function hideEmptyState() {
        elements.analyticsEmpty.hidden = true;
        elements.analyticsGrid.hidden = false;
        elements.statsGrid.hidden = false;
    }

    function shouldAnimate(view) {
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            return false;
        }
        return view.totals.total < 4000;
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
