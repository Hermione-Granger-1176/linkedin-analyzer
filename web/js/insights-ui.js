/* Insights page logic */

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

    const elements = {
        timeRangeButtons: document.querySelectorAll('#timeRangeButtons .filter-btn'),
        resetFiltersBtn: document.getElementById('resetFiltersBtn'),
        insightsEmpty: document.getElementById('insightsEmpty'),
        insightsGrid: document.getElementById('insightsGrid'),
        insightTip: document.getElementById('insightTip'),
        insightTipText: document.getElementById('insightTipText')
    };

    const state = {
        filters: { ...FILTER_DEFAULTS },
        analyticsReady: false,
        hasData: false,
        currentInsights: null
    };

    const WORKER_URL = 'js/analytics-worker.js?v=20260131-5';

    let worker = null;
    let requestId = 0;
    let pendingViewId = 0;

    /**
     * Initialize insights page: bind events, start worker, load data.
     */
    function init() {
        bindEvents();
        initWorker();
        loadBase();
    }

    /**
     * Attach event listeners for time range buttons and reset.
     */
    function bindEvents() {
        elements.timeRangeButtons.forEach(button => {
            button.addEventListener('click', () => handleTimeRangeChange(button));
        });
        elements.resetFiltersBtn.addEventListener('click', resetFilters);
    }

    /**
     * Create the analytics Web Worker.
     */
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

    /**
     * Load analytics base from IndexedDB and send to worker.
     */
    async function loadBase() {
        const analyticsBase = await Storage.getAnalytics();
        if (!analyticsBase || !analyticsBase.months) {
            setEmptyState('No data available yet', 'Upload Shares.csv or Comments.csv on the Home page.');
            return;
        }
        if (!worker) {
            setEmptyState('Insights not supported', 'Your browser does not support analytics workers.');
            return;
        }
        setEmptyState('Preparing insights', 'Crunching your data in the background.');
        worker.postMessage({
            type: 'initBase',
            payload: analyticsBase
        });
    }

    /**
     * Handle messages from the analytics worker.
     * @param {MessageEvent} event - The message event from the worker.
     */
    function handleWorkerMessage(event) {
        const message = event.data || {};
        if (message.type === 'init') {
            state.analyticsReady = true;
            state.hasData = Boolean(message.payload && message.payload.hasData);
            updateVisibility();
            requestView();
            return;
        }
        if (message.type === 'view') {
            if (message.requestId !== pendingViewId) return;
            const payload = message.payload || {};
            state.currentInsights = payload.insights || null;
            if (state.currentInsights) {
                renderInsights(state.currentInsights);
            }
            return;
        }
        if (message.type === 'error') {
            setEmptyState('Insights error', message.payload && message.payload.message ? message.payload.message : 'Analytics worker error.');
        }
    }

    /**
     * Handle worker-level errors.
     */
    function handleWorkerError() {
        setEmptyState('Insights worker error', 'Refresh the page and try again.');
    }

    /**
     * Send a view request to the worker with current filters.
     */
    function requestView() {
        if (!worker || !state.analyticsReady || !state.hasData) return;
        const id = ++requestId;
        pendingViewId = id;
        worker.postMessage({
            type: 'view',
            requestId: id,
            filters: { ...state.filters }
        });
    }

    /**
     * Handle click on a time range button.
     * @param {HTMLElement} button - The clicked time range button.
     */
    function handleTimeRangeChange(button) {
        const range = button.getAttribute('data-range');
        if (!range) return;
        applyTimeRange(range);
    }

    /**
     * Reset all filters to defaults and request a fresh view.
     */
    function resetFilters() {
        state.filters = { ...FILTER_DEFAULTS };
        setActiveTimeRange(FILTER_DEFAULTS.timeRange);
        requestView();
    }

    /**
     * Apply a new time range and request view.
     * @param {string} range - The time range key to apply.
     */
    function applyTimeRange(range) {
        state.filters = { ...FILTER_DEFAULTS, timeRange: range };
        setActiveTimeRange(range);
        requestView();
    }

    /**
     * Update the active class on time range buttons.
     * @param {string} range - The active time range key.
     */
    function setActiveTimeRange(range) {
        elements.timeRangeButtons.forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-range') === range);
        });
    }

    /**
     * Toggle empty state vs insights grid based on data availability.
     */
    function updateVisibility() {
        if (!state.hasData) {
            setEmptyState('No data available yet', 'Upload Shares.csv or Comments.csv on the Home page.');
            return;
        }
        hideEmptyState();
    }

    /**
     * Render insight cards and tip from the worker response.
     * @param {Object} payload - The insights payload from the worker.
     */
    function renderInsights(payload) {
        const insights = payload.insights || [];
        const tip = payload.tip || null;
        elements.insightsGrid.innerHTML = '';
        insights.slice(0, 6).forEach(insight => {
            const card = document.createElement('div');
            card.className = 'insight-card';
            card.dataset.accent = insight.accent;
            card.innerHTML = `
                <div class="insight-icon ${insight.accent}">${getInsightIcon(insight.icon)}</div>
                <div class="insight-body">
                    <h3>${escapeHtml(insight.title)}</h3>
                    <p>${escapeHtml(insight.body)}</p>
                </div>
            `;
            elements.insightsGrid.appendChild(card);
        });

        if (tip) {
            elements.insightTip.hidden = false;
            elements.insightTipText.textContent = tip;
        } else {
            elements.insightTip.hidden = true;
        }
    }

    /**
     * Show empty state with title and message.
     * @param {string} title - The heading text for the empty state.
     * @param {string} message - The descriptive message for the empty state.
     */
    function setEmptyState(title, message) {
        const heading = elements.insightsEmpty.querySelector('h2');
        const text = elements.insightsEmpty.querySelector('p');
        if (heading) heading.textContent = title;
        if (text) text.textContent = message;
        elements.insightsEmpty.hidden = false;
        elements.insightsGrid.hidden = true;
        elements.insightTip.hidden = true;
    }

    /**
     * Hide empty state and show insights grid.
     */
    function hideEmptyState() {
        elements.insightsEmpty.hidden = true;
        elements.insightsGrid.hidden = false;
    }

    /**
     * Escape a string for safe HTML insertion.
     * @param {string} value - The string to escape.
     * @returns {string} The HTML-escaped string.
     */
    function escapeHtml(value) {
        const div = document.createElement('div');
        div.textContent = value;
        return div.innerHTML;
    }

    /**
     * Return SVG markup for a named insight icon.
     * @param {string} name - The icon name.
     * @returns {string} The SVG markup string.
     */
    function getInsightIcon(name) {
        const icons = {
            rooster: `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="16" fill="none" stroke="currentColor" stroke-width="2"/><path d="M24 20 Q28 12 32 18 Q36 12 40 20" fill="none" stroke="currentColor" stroke-width="2"/><path d="M40 32 L50 28" fill="none" stroke="currentColor" stroke-width="2"/><path d="M22 44 Q32 52 42 44" fill="none" stroke="currentColor" stroke-width="2"/></svg>`,
            owl: `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="18" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="26" cy="30" r="4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="38" cy="30" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M30 40 L32 42 L34 40" fill="none" stroke="currentColor" stroke-width="2"/></svg>`,
            rocket: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 6 C44 12 52 24 52 34 C52 46 42 54 32 58 C22 54 12 46 12 34 C12 24 20 12 32 6 Z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="32" cy="30" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M26 58 L22 62 L30 60" fill="none" stroke="currentColor" stroke-width="2"/><path d="M38 58 L42 62 L34 60" fill="none" stroke="currentColor" stroke-width="2"/></svg>`,
            sloth: `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="18" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="26" cy="30" r="3" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="38" cy="30" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M28 40 Q32 44 36 40" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 24 Q32 18 44 24" fill="none" stroke="currentColor" stroke-width="2"/></svg>`,
            monkey: `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="16" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="18" cy="30" r="6" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="46" cy="30" r="6" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="26" cy="30" r="3" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="38" cy="30" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M26 40 Q32 44 38 40" fill="none" stroke="currentColor" stroke-width="2"/></svg>`,
            handshake: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M10 36 L24 24 L34 34" fill="none" stroke="currentColor" stroke-width="2"/><path d="M54 36 L40 24 L30 34" fill="none" stroke="currentColor" stroke-width="2"/><path d="M24 24 L32 18 L40 24" fill="none" stroke="currentColor" stroke-width="2"/></svg>`,
            trophy: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M20 12 H44 V24 C44 32 38 38 32 38 C26 38 20 32 20 24 Z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 12 H8 C8 24 14 30 20 30" fill="none" stroke="currentColor" stroke-width="2"/><path d="M48 12 H56 C56 24 50 30 44 30" fill="none" stroke="currentColor" stroke-width="2"/><path d="M28 38 V48 H36 V38" fill="none" stroke="currentColor" stroke-width="2"/><path d="M24 52 H40" fill="none" stroke="currentColor" stroke-width="2"/></svg>`,
            calendar: `<svg viewBox="0 0 64 64" aria-hidden="true"><rect x="12" y="16" width="40" height="36" rx="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 26 H52" fill="none" stroke="currentColor" stroke-width="2"/><path d="M22 12 V20 M42 12 V20" fill="none" stroke="currentColor" stroke-width="2"/><path d="M22 36 L28 42 L40 30" fill="none" stroke="currentColor" stroke-width="2"/></svg>`,
            flame: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 10 C36 18 26 22 30 30 C32 34 40 34 40 42 C40 50 34 54 32 54 C26 54 22 48 22 42 C22 34 28 30 26 24" fill="none" stroke="currentColor" stroke-width="2"/></svg>`
        };
        return icons[name] || icons.calendar;
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
