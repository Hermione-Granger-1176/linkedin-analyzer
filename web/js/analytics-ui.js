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

    const CHART_CANVASES = [elements.timelineChart, elements.topicsChart, elements.heatmapChart].filter(Boolean);
    const TIMELINE_ANIMATION = {
        minDuration: 380,
        maxDuration: 1200,
        msPerPoint: 45
    };

    const state = {
        filters: { ...FILTER_DEFAULTS },
        analyticsReady: false,
        hasData: false,
        currentView: null
    };

    const WORKER_URL = 'js/analytics-worker.js?v=20260228-2';

    let worker = null;
    let requestId = 0;
    let pendingViewId = 0;
    let lastRequestedKey = null;
    let debounceTimer = null;
    let isRendering = false;
    let pendingRender = null;

    /** Initialize analytics page: bind events, start worker, load data. */
    function init() {
        bindEvents();
        initWorker();
        loadBase();
    }

    /** Attach event listeners for filters, charts, theme, and visibility. */
    function bindEvents() {
        elements.timeRangeButtons.forEach(button => {
            button.addEventListener('click', () => handleTimeRangeChange(button));
        });
        elements.resetFiltersBtn.addEventListener('click', resetFilters);
        elements.activeFiltersList.addEventListener('click', handleFilterChipClick);

        window.addEventListener('beforeunload', terminateWorker);
        window.addEventListener('pagehide', terminateWorker);

        document.addEventListener('themechange', () => {
            if (state.currentView) {
                renderAnalyticsView(state.currentView);
            }
        });

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && state.currentView) {
                renderAnalyticsView(state.currentView);
            }
        });

        CHART_CANVASES.forEach(canvas => {
            canvas.addEventListener('mousemove', handleChartHover);
            canvas.addEventListener('mouseleave', hideTooltip);
            canvas.addEventListener('click', handleChartClick);
        });
    }

    /** Create the analytics Web Worker. */
    function initWorker() {
        if (typeof Worker === 'undefined') return;
        try {
            worker = new Worker(WORKER_URL);
            worker.addEventListener('message', handleWorkerMessage);
            worker.addEventListener('error', handleWorkerError);
        } catch {
            worker = null;
            setEmptyState('Worker blocked', 'Open this page from a local server (not file://).');
        }
    }

    /** Terminate the analytics Web Worker to free resources. */
    function terminateWorker() {
        if (worker) {
            worker.terminate();
            worker = null;
        }
    }


    /** Load analytics base data from IndexedDB and send to worker. */
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
        } catch {
            setEmptyState('Storage error', 'Unable to load saved data. Try clearing browser data and re-uploading.');
        }
    }

    /**
     * Handle messages received from the analytics worker.
     * @param {MessageEvent} event - The message event from the worker.
     */
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

    /** Handle worker-level errors. */
    function handleWorkerError() {
        setEmptyState('Analytics worker error', 'Refresh the page and try again.');
    }

    /**
     * Build a unique string key from the current filter state.
     * @param {Object} filters - The current filter state.
     * @returns {string} A pipe-delimited key representing the filters.
     */
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

    /**
     * Debounce and schedule a view request to the worker.
     * @param {boolean} force - Whether to bypass the debounce delay.
     */
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

    /**
     * Send a view request to the worker with current filters.
     * @param {boolean} force - Whether to send even if the filter key hasn't changed.
     */
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

    /**
     * Check whether all chart canvases have non-zero dimensions.
     * @returns {boolean} True if all canvases are sized.
     */
    function areChartsSized() {
        return CHART_CANVASES.every(canvas => {
            const rect = canvas.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        });
    }

    /**
     * Defer rendering until chart containers have layout dimensions.
     * @param {Object} view - The analytics view data to render once sized.
     */
    function scheduleRenderWhenSized(view) {
        pendingRender = view;
        if (resizeObserver) return;
        const wrappers = CHART_CANVASES.map(canvas => canvas.parentElement).filter(Boolean);
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

    /**
     * Update the stats bar with totals from the current view.
     * @param {Object} view - The analytics view containing totals, peakHour, and streaks.
     */
    function updateStats(view) {
        elements.statPosts.textContent = view.totals.posts;
        elements.statComments.textContent = view.totals.comments;
        elements.statTotal.textContent = view.totals.total;
        elements.statPeak.textContent = view.totals.total
            ? `${String(view.peakHour.hour).padStart(2, '0')}:00`
            : '-';
        elements.statStreak.textContent = view.totals.total
            ? `${view.streaks.current} days`
            : '0 days';
    }

    /**
     * Calculate animation duration based on timeline length.
     * @param {number} pointCount - The number of data points in the timeline.
     * @returns {number} Animation duration in milliseconds.
     */
    function getTimelineAnimationDuration(pointCount) {
        return Math.min(
            TIMELINE_ANIMATION.maxDuration,
            Math.max(TIMELINE_ANIMATION.minDuration, pointCount * TIMELINE_ANIMATION.msPerPoint)
        );
    }

    /**
     * Draw all three chart canvases from the view data.
     * @param {Object} view - The analytics view containing timeline, topics, and heatmap data.
     */
    function renderCharts(view) {
        SketchCharts.drawHeatmap(elements.heatmapChart, view.heatmap);
        SketchCharts.drawTopics(elements.topicsChart, view.topics, 1);

        if (shouldAnimate(view)) {
            const duration = getTimelineAnimationDuration(view.timeline.length);
            SketchCharts.animateDraw((progress) => {
                SketchCharts.drawTimeline(elements.timelineChart, view.timeline, state.filters.timeRange, progress, view.timelineMax);
            }, duration);
            return;
        }

        SketchCharts.drawTimeline(elements.timelineChart, view.timeline, state.filters.timeRange, 1, view.timelineMax);
    }

    /**
     * Main render entry point: update stats, filters, and charts.
     * @param {Object} view - The analytics view data to render.
     */
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
            updateStats(view);

            renderActiveFilters();

            if (!areChartsSized()) {
                scheduleRenderWhenSized(view);
                return;
            }
            renderRetryCount = 0;

            isRendering = true;
            showAnalyticsLoading(true);
            SketchCharts.cancelAnimations();
            renderCharts(view);
        } catch {
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

    /** Toggle empty state vs analytics grid based on data availability. */
    function updateVisibility() {
        if (!state.hasData) {
            setEmptyState('No data available yet', 'Upload Shares.csv or Comments.csv on the Home page.');
            return;
        }
        hideEmptyState();
    }

    /**
     * Handle click on a time range button.
     * @param {HTMLElement} button - The clicked time range button element.
     */
    function handleTimeRangeChange(button) {
        const range = button.getAttribute('data-range');
        if (!range) return;
        applyTimeRange(range);
    }

    /** Reset all filters to defaults and request a fresh view. */
    function resetFilters() {
        state.filters = { ...FILTER_DEFAULTS };
        setActiveTimeRange(FILTER_DEFAULTS.timeRange);
        scheduleViewRequest(true);
    }

    /**
     * Reset filter state, optionally keeping the current time range.
     * @param {boolean} preserveTimeRange - Whether to keep the current time range.
     */
    function resetFilterState(preserveTimeRange) {
        const timeRange = preserveTimeRange ? state.filters.timeRange : FILTER_DEFAULTS.timeRange;
        state.filters = { ...FILTER_DEFAULTS, timeRange };
    }

    /**
     * Apply a new time range, reset other filters, and request view.
     * @param {string} range - The time range identifier (e.g. '12m', '6m').
     */
    function applyTimeRange(range) {
        state.filters.timeRange = range;
        resetFilterState(true);
        setActiveTimeRange(range);
        scheduleViewRequest(true);
    }

    /**
     * Update the active class on time range buttons.
     * @param {string} range - The active time range identifier.
     */
    function setActiveTimeRange(range) {
        elements.timeRangeButtons.forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-range') === range);
        });
    }

    /**
     * Handle click on an active filter chip to remove it.
     * @param {Event} event - The click event.
     */
    function handleFilterChipClick(event) {
        const button = event.target.closest('button[data-filter]');
        if (!button) return;
        const filter = button.getAttribute('data-filter');
        const FILTER_RESET_MAP = {
            topic: () => { state.filters.topic = 'all'; },
            month: () => { state.filters.monthFocus = null; },
            day: () => { state.filters.day = null; },
            hour: () => { state.filters.hour = null; }
        };
        const resetFn = FILTER_RESET_MAP[filter];
        if (resetFn) resetFn();
        scheduleViewRequest(false);
    }

    /** Render the list of active filter chips. */
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

    /**
     * Handle mousemove on chart canvas for tooltip and cursor.
     * @param {MouseEvent} event - The mousemove event.
     */
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
        const CLICKABLE_TYPES = new Set(['month', 'week', 'heatmap', 'topic']);
        if (item && CLICKABLE_TYPES.has(item.type)) {
            canvas.style.cursor = 'pointer';
        } else {
            canvas.style.cursor = 'default';
        }
    }

    /**
     * Handle click on chart canvas to toggle filters.
     * @param {MouseEvent} event - The click event.
     */
    function handleChartClick(event) {
        const canvas = event.currentTarget;
        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        const item = SketchCharts.getItemAt(canvas, x, y);
        if (!item) return;
        switch (item.type) {
            case 'month':
                state.filters.monthFocus = state.filters.monthFocus === item.key ? null : item.key;
                scheduleViewRequest(false);
                break;
            case 'week': {
                const targetMonth = item.monthKey || item.key;
                state.filters.monthFocus = state.filters.monthFocus === targetMonth ? null : targetMonth;
                scheduleViewRequest(false);
                break;
            }
            case 'topic':
                state.filters.topic = state.filters.topic === item.key ? 'all' : item.key;
                scheduleViewRequest(false);
                break;
            case 'heatmap': {
                const isSame = state.filters.day === item.day && state.filters.hour === item.hour;
                state.filters.day = isSame ? null : item.day;
                state.filters.hour = isSame ? null : item.hour;
                scheduleViewRequest(false);
                break;
            }
            default:
                break;
        }
    }

    /**
     * Position and show the chart tooltip.
     * @param {number} clientX - The client X coordinate.
     * @param {number} clientY - The client Y coordinate.
     * @param {string} text - The tooltip text to display.
     */
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

    /** Hide the chart tooltip. */
    function hideTooltip() {
        elements.chartTooltip.hidden = true;
    }

    /**
     * Toggle loading opacity on the analytics grid.
     * @param {boolean} isLoading - Whether the analytics is currently loading.
     */
    function showAnalyticsLoading(isLoading) {
        elements.analyticsGrid.style.opacity = isLoading ? '0.5' : '1';
        elements.statsGrid.style.opacity = isLoading ? '0.5' : '1';
        elements.analyticsGrid.style.pointerEvents = isLoading ? 'none' : 'auto';
    }

    /**
     * Show the empty state with a title and message.
     * @param {string} title - The heading text for the empty state.
     * @param {string} message - The description text for the empty state.
     */
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

    /** Hide the empty state and show the analytics grid. */
    function hideEmptyState() {
        elements.analyticsEmpty.hidden = true;
        elements.analyticsGrid.hidden = false;
        elements.statsGrid.hidden = false;
    }

    /**
     * Determine whether timeline animation should play.
     * @param {Object} view - The analytics view to check.
     * @returns {boolean} True if the timeline should animate.
     */
    function shouldAnimate(view) {
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            return false;
        }
        if (document.visibilityState && document.visibilityState !== 'visible') {
            return false;
        }
        if (!view || !Array.isArray(view.timeline) || view.timeline.length < 2 || view.timeline.length > 48) {
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
