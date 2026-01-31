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
        resetFiltersBtn: document.getElementById('resetFiltersBtn'),
        activeFilters: document.getElementById('activeFilters'),
        activeFiltersList: document.getElementById('activeFiltersList'),
        analyticsEmpty: document.getElementById('analyticsEmpty'),
        analyticsGrid: document.getElementById('analyticsGrid'),
        statsGrid: document.getElementById('statsGrid'),
        timelineChart: document.getElementById('timelineChart'),
        topicsChart: document.getElementById('topicsChart'),
        heatmapChart: document.getElementById('heatmapChart'),
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
        currentView: null
    };

    const WORKER_URL = 'js/analytics-worker.js?v=20260131-5';

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
        elements.resetFiltersBtn.addEventListener('click', resetFilters);
        elements.activeFiltersList.addEventListener('click', handleFilterChipClick);

        document.addEventListener('themechange', () => {
            if (state.currentView) {
                lastViewKey = state.currentView.key;
                renderAnalyticsView(state.currentView);
            }
        });

        [elements.timelineChart, elements.topicsChart, elements.heatmapChart].forEach(canvas => {
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

    function terminateWorker() {
        if (worker) {
            worker.terminate();
            worker = null;
        }
    }

    window.addEventListener('beforeunload', terminateWorker);
    window.addEventListener('pagehide', terminateWorker);

    async function loadBase() {
        try {
            const analyticsBase = await Storage.getAnalytics();
            if (!analyticsBase || !analyticsBase.months) {
                setEmptyState('No data available yet', 'Upload Shares.csv or Comments.csv on the Home page.');
                return;
            }
            if (!worker) {
                setEmptyState('Analytics not supported', 'Your browser does not support analytics workers.');
                return;
            }
            // Show loading state but keep grid visible for canvas sizing
            showAnalyticsLoading(true);
            worker.postMessage({
                type: 'initBase',
                payload: analyticsBase
            });
        } catch (error) {
            setEmptyState('Storage error', 'Unable to load saved data. Try clearing browser data and re-uploading.');
        }
    }

    function handleWorkerMessage(event) {
        const message = event.data || {};
        if (message.type === 'init') {
            state.analyticsReady = true;
            state.hasData = Boolean(message.payload && message.payload.hasData);
            updateVisibility();
            scheduleViewRequest(true);
            return;
        }
        if (message.type === 'view') {
            if (message.requestId !== pendingViewId) return;
            const payload = message.payload || {};
            state.currentView = payload.view || null;
            if (state.currentView) {
                // Use double requestAnimationFrame to ensure layout is computed after unhiding
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        renderAnalyticsView(state.currentView);
                    });
                });
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

    let renderRetryCount = 0;
    const MAX_RENDER_RETRIES = 5;
    let resizeObserver = null;
    let renderRetryTimer = null;

    function areChartsSized() {
        return [elements.timelineChart, elements.topicsChart, elements.heatmapChart].every(canvas => {
            if (!canvas) return false;
            const rect = canvas.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        });
    }

    function scheduleRenderWhenSized(view) {
        pendingRender = view;
        if (resizeObserver) return;
        const wrappers = [elements.timelineChart, elements.topicsChart, elements.heatmapChart]
            .map(canvas => canvas && canvas.parentElement)
            .filter(Boolean);
        if (typeof ResizeObserver !== 'undefined' && wrappers.length) {
            resizeObserver = new ResizeObserver(() => {
                if (!pendingRender || !areChartsSized()) return;
                const next = pendingRender;
                pendingRender = null;
                resizeObserver.disconnect();
                resizeObserver = null;
                renderRetryCount = 0;
                renderAnalyticsView(next);
            });
            wrappers.forEach(wrapper => resizeObserver.observe(wrapper));
            return;
        }
        if (renderRetryCount < MAX_RENDER_RETRIES) {
            renderRetryCount++;
            clearTimeout(renderRetryTimer);
            renderRetryTimer = setTimeout(() => {
                renderRetryTimer = null;
                if (!pendingRender) return;
                const next = pendingRender;
                pendingRender = null;
                renderAnalyticsView(next);
            }, 80);
        }
    }

    function renderAnalyticsView(view) {
        if (isRendering) {
            pendingRender = view;
            return;
        }
        try {
            if (!view) {
                setEmptyState('No analytics data', 'Try resetting filters.');
                showAnalyticsLoading(false);
                return;
            }
            if (typeof rough === 'undefined' || typeof SketchCharts === 'undefined') {
                setEmptyState('Charts unavailable', 'Required libraries failed to load. Please refresh the page.');
                showAnalyticsLoading(false);
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

            if (!areChartsSized()) {
                scheduleRenderWhenSized(view);
                return;
            }
            renderRetryCount = 0;

            isRendering = true;
            showAnalyticsLoading(true);
            SketchCharts.cancelAnimations();

            const animateTimeline = shouldAnimate(view);
            lastViewKey = view.key;

            SketchCharts.drawHeatmap(elements.heatmapChart, view.heatmap);
            SketchCharts.drawTopics(elements.topicsChart, view.topics, 1);

            if (animateTimeline) {
                const duration = Math.min(1200, Math.max(380, view.timeline.length * 45));
                SketchCharts.animateDraw((progress) => {
                    SketchCharts.drawTimeline(elements.timelineChart, view.timeline, state.filters.timeRange, progress, view.timelineMax);
                }, duration);
            } else {
                SketchCharts.drawTimeline(elements.timelineChart, view.timeline, state.filters.timeRange, 1, view.timelineMax);
            }
        } catch (renderError) {
            setEmptyState('Render error', 'Failed to draw charts. Please refresh the page.');
        } finally {
            if (isRendering) {
                showAnalyticsLoading(false);
                isRendering = false;
                if (pendingRender) {
                    const next = pendingRender;
                    pendingRender = null;
                    renderAnalyticsView(next);
                }
            }
        }
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

    function resetFilters() {
        state.filters = { ...FILTER_DEFAULTS };
        elements.timeRangeButtons.forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-range') === '12m');
        });
        scheduleViewRequest(true);
    }

    function resetFilterState(preserveTimeRange) {
        const timeRange = preserveTimeRange ? state.filters.timeRange : FILTER_DEFAULTS.timeRange;
        state.filters = { ...FILTER_DEFAULTS, timeRange };
    }

    function handleFilterChipClick(event) {
        const button = event.target.closest('button[data-filter]');
        if (!button) return;
        const filter = button.getAttribute('data-filter');
        if (filter === 'topic') {
            state.filters.topic = 'all';
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
        if (item && (item.type === 'month' || item.type === 'week' || item.type === 'heatmap' || item.type === 'topic')) {
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
        if (item.type === 'week') {
            const targetMonth = item.monthKey || item.key;
            state.filters.monthFocus = state.filters.monthFocus === targetMonth ? null : targetMonth;
            scheduleViewRequest(false);
        }
        if (item.type === 'topic') {
            state.filters.topic = state.filters.topic === item.key ? 'all' : item.key;
            scheduleViewRequest(false);
        }
        if (item.type === 'heatmap') {
            const isSame = state.filters.day === item.day && state.filters.hour === item.hour;
            state.filters.day = isSame ? null : item.day;
            state.filters.hour = isSame ? null : item.hour;
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
        if (document.visibilityState && document.visibilityState !== 'visible') {
            return false;
        }
        if (!view || !Array.isArray(view.timeline) || view.timeline.length > 48) {
            return false;
        }
        return view.totals.total < 4000;
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && state.currentView) {
            renderAnalyticsView(state.currentView);
        }
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
