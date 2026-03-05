/* Insights page logic */

import { DataCache } from "./data-cache.js";
import { LoadingOverlay } from "./loading-overlay.js";
import { AppRouter } from "./router.js";
import { captureError } from "./sentry.js";
import { Session } from "./session.js";
import { Storage } from "./storage.js";
import { parseAnalyticsWorkerMessage } from "./worker-contracts.js";

export const InsightsPage = (() => {
    "use strict";

    /** @type {{ timeRange: string, topic: string, monthFocus: string|null, day: string|null, hour: string|null, shareType: string }} */
    const FILTER_DEFAULTS = Object.freeze({
        timeRange: "12m",
        topic: "all",
        monthFocus: null,
        day: null,
        hour: null,
        shareType: "all",
    });

    const RANGE_VALUES = new Set(["1m", "3m", "6m", "12m", "all"]);
    const CACHE_EVENTS = new Set(["analyticsChanged", "storageCleared", "filesChanged"]);
    const state = {
        filters: { ...FILTER_DEFAULTS },
        analyticsReady: false,
        hasData: false,
        currentInsights: null,
    };

    let elements = null;
    let worker = null;
    let requestId = 0;
    let pendingViewId = 0;
    let initialized = false;
    let needsBaseReload = true;
    let isApplyingRouteParams = false;

    /** Initialize insights page dependencies. */
    function init() {
        if (initialized) {
            return;
        }

        elements = resolveElements();
        if (!elements.insightsGrid || !elements.insightsEmpty) {
            return;
        }

        initialized = true;
        bindEvents();
        initWorker();

        DataCache.subscribe(handleCacheChange);
    }

    /**
     * Handle route activation and query param changes.
     * @param {object} params - Route query params
     */
    function onRouteChange(params) {
        if (!initialized) {
            init();
            /* v8 ignore next 3 */
            if (!initialized) {
                return;
            }
        }

        const range = parseRangeParam(params && params.range);
        applyRangeFromRoute(range);

        if (needsBaseReload || !state.analyticsReady) {
            loadBase();
            return;
        }

        if (!state.hasData) {
            updateVisibility();
            return;
        }

        requestView();
    }

    /** Cleanup when leaving route. */
    function onRouteLeave() {
        showInsightsLoading(false);
    }

    /**
     * Resolve insights DOM references.
     * @returns {object}
     */
    function resolveElements() {
        return {
            timeRangeButtons: document.querySelectorAll("#insightsTimeRangeButtons .filter-btn"),
            resetFiltersBtn: document.getElementById("insightsResetFiltersBtn"),
            insightsEmpty: document.getElementById("insightsEmpty"),
            insightsGrid: document.getElementById("insightsGrid"),
            insightTip: document.getElementById("insightTip"),
            insightTipText: document.getElementById("insightTipText"),
        };
    }

    /** Attach event listeners for time range buttons and reset. */
    function bindEvents() {
        elements.timeRangeButtons.forEach((button) => {
            button.addEventListener("click", () => handleTimeRangeChange(button));
            button.setAttribute(
                "aria-pressed",
                button.classList.contains("active") ? "true" : "false",
            );
        });
        if (elements.resetFiltersBtn) {
            elements.resetFiltersBtn.addEventListener("click", resetFilters);
        }
    }

    /**
     * Handle cache notifications from uploads/clear operations.
     * @param {Event} event
     */
    function handleCacheChange(event) {
        const type = event && event.type;
        if (!CACHE_EVENTS.has(type)) {
            return;
        }
        needsBaseReload = true;
        state.analyticsReady = false;
        state.hasData = false;
        state.currentInsights = null;
    }

    /** Create the analytics Web Worker. */
    function initWorker() {
        if (typeof Worker === "undefined" || worker) {
            return;
        }

        try {
            worker = new Worker(new URL("./analytics-worker.js", import.meta.url), {
                type: "module",
            });
            worker.addEventListener("message", handleWorkerMessage);
            worker.addEventListener("error", handleWorkerError);
        } catch (error) {
            worker = null;
            captureError(error, {
                module: "insights-ui",
                operation: "init-worker",
            });
            setEmptyState("Worker blocked", "Open this page from a local server (not file://).");
        }
    }

    /** Load analytics base from IndexedDB and send to worker. */
    async function loadBase() {
        showInsightsLoading(true);

        try {
            await Session.waitForCleanup();

            initWorker();
            /* v8 ignore next 5 */
            if (!worker) {
                setEmptyState(
                    "Insights not supported",
                    "Your browser does not support analytics workers.",
                );
                showInsightsLoading(false);
                return;
            }

            let analyticsBase = null;
            analyticsBase = DataCache.get("storage:analyticsBase") || null;

            if (!analyticsBase) {
                analyticsBase = await Storage.getAnalytics();
                DataCache.set("storage:analyticsBase", analyticsBase);
            }

            if (!analyticsBase || !analyticsBase.months) {
                setEmptyState(
                    "No data available yet",
                    "Upload Shares.csv or Comments.csv on the Home page.",
                );
                needsBaseReload = false;
                showInsightsLoading(false);
                return;
            }

            worker.postMessage({
                type: "initBase",
                payload: analyticsBase,
            });
            needsBaseReload = false;
        } catch (error) {
            captureError(error, {
                module: "insights-ui",
                operation: "load-base",
            });
            setEmptyState(
                "Storage error",
                "Unable to load saved analytics. Please re-upload your files.",
            );
            showInsightsLoading(false);
        }
    }

    /**
     * Handle messages from the analytics worker.
     * @param {MessageEvent} event - The message event from the worker.
     */
    function handleWorkerMessage(event) {
        const parsed = parseAnalyticsWorkerMessage(event.data || {});
        if (!parsed.valid) {
            captureError(new Error(parsed.error || "Invalid analytics worker payload."), {
                module: "insights-ui",
                operation: "worker-message-parse",
            });
            return;
        }

        const message = parsed.value;

        switch (message.type) {
            case "init":
                state.analyticsReady = true;
                state.hasData = Boolean(message.payload && message.payload.hasData);
                updateVisibility();
                requestView();
                return;
            case "view":
                if (message.requestId !== pendingViewId) {
                    return;
                }
                applyWorkerInsightsPayload(message.payload || {});
                return;
            case "error":
                captureError(
                    new Error(getWorkerMessage(message.payload, "Analytics worker error.")),
                    {
                        module: "insights-ui",
                        operation: "worker-error-payload",
                        requestId: message.requestId,
                    },
                );
                setEmptyState(
                    "Insights error",
                    getWorkerMessage(message.payload, "Analytics worker error."),
                );
                showInsightsLoading(false);
                return;
            /* v8 ignore next 2 */
            default:
                return;
        }
    }

    /**
     * Apply worker insights payload and render current cards.
     * @param {object} payload - Worker payload
     */
    function applyWorkerInsightsPayload(payload) {
        state.currentInsights = payload.insights || null;
        if (state.currentInsights) {
            renderInsights(state.currentInsights);
        }
        showInsightsLoading(false);
    }

    /**
     * Resolve a worker message text with fallback.
     * @param {object} payload - Worker payload
     * @param {string} fallback - Fallback message
     * @returns {string}
     */
    function getWorkerMessage(payload, fallback) {
        return payload && payload.message ? payload.message : fallback;
    }

    /**
     * Handle worker-level errors.
     * @param {ErrorEvent} event - Worker error event
     */
    function handleWorkerError(event) {
        captureError(
            event && event.error ? event.error : new Error("Insights worker error event"),
            {
                module: "insights-ui",
                operation: "worker-error-event",
            },
        );
        setEmptyState("Insights worker error", "Refresh the page and try again.");
        showInsightsLoading(false);
    }

    /** Send a view request to the worker with current filters. */
    function requestView() {
        if (!worker || !state.analyticsReady || !state.hasData) {
            return;
        }

        showInsightsLoading(true);
        const id = ++requestId;
        pendingViewId = id;
        worker.postMessage({
            type: "view",
            requestId: id,
            filters: { ...state.filters },
        });
    }

    /**
     * Handle click on a time range button.
     * @param {HTMLElement} button - The clicked time range button.
     */
    function handleTimeRangeChange(button) {
        const range = button.getAttribute("data-range");
        /* v8 ignore next 3 */
        if (!range) {
            return;
        }
        applyTimeRange(range);
    }

    /** Reset all filters to defaults and request a fresh view. */
    function resetFilters() {
        state.filters = { ...FILTER_DEFAULTS };
        setActiveTimeRange(FILTER_DEFAULTS.timeRange);
        syncRouteRange();
        requestView();
    }

    /**
     * Apply a new time range and request view.
     * @param {string} range - The time range key to apply.
     */
    function applyTimeRange(range) {
        const nextRange = parseRangeParam(range);
        state.filters = { ...FILTER_DEFAULTS, timeRange: nextRange };
        setActiveTimeRange(nextRange);
        syncRouteRange();
        requestView();
    }

    /**
     * Update the active class on time range buttons.
     * @param {string} range - The active time range key.
     */
    function setActiveTimeRange(range) {
        elements.timeRangeButtons.forEach((btn) => {
            const isActive = btn.getAttribute("data-range") === range;
            btn.classList.toggle("active", isActive);
            btn.setAttribute("aria-pressed", isActive ? "true" : "false");
        });
    }

    /** Toggle empty state vs insights grid based on data availability. */
    function updateVisibility() {
        if (!state.hasData) {
            setEmptyState(
                "No data available yet",
                "Upload Shares.csv or Comments.csv on the Home page.",
            );
            return;
        }
        hideEmptyState();
    }

    /**
     * Render insight cards and tip from the worker response.
     * @param {object} payload - The insights payload from the worker.
     */
    function renderInsights(payload) {
        const insights = payload.insights || [];
        const tip = payload.tip || null;

        elements.insightsGrid.innerHTML = "";
        insights.slice(0, 6).forEach((insight) => {
            const card = document.createElement("div");
            card.className = "insight-card";
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
        const heading = elements.insightsEmpty.querySelector("h2");
        const text = elements.insightsEmpty.querySelector("p");
        /* v8 ignore next 5 */
        if (heading) {
            heading.textContent = title;
        }
        if (text) {
            text.textContent = message;
        }
        elements.insightsEmpty.hidden = false;
        elements.insightsGrid.hidden = true;
        elements.insightTip.hidden = true;
    }

    /** Hide empty state and show insights grid. */
    function hideEmptyState() {
        elements.insightsEmpty.hidden = true;
        elements.insightsGrid.hidden = false;
    }

    /**
     * Parse route range query value.
     * @param {string} value - Raw route value
     * @returns {string}
     */
    function parseRangeParam(value) {
        const range = String(value || "").toLowerCase();
        return RANGE_VALUES.has(range) ? range : FILTER_DEFAULTS.timeRange;
    }

    /**
     * Apply route-provided range without rewriting route.
     * @param {string} range - Normalized range
     */
    function applyRangeFromRoute(range) {
        isApplyingRouteParams = true;
        state.filters = { ...FILTER_DEFAULTS, timeRange: range };
        setActiveTimeRange(range);
        isApplyingRouteParams = false;
    }

    /** Sync current range filter into route query params. */
    function syncRouteRange() {
        /* v8 ignore next 3 */
        if (isApplyingRouteParams) {
            return;
        }
        const currentRoute = AppRouter.getCurrentRoute();
        if (!currentRoute || currentRoute.name !== "insights") {
            return;
        }
        AppRouter.setParams({ range: state.filters.timeRange }, { replaceHistory: false });
    }

    /**
     * Toggle loading overlay for insights screen.
     * @param {boolean} isLoading - Whether loading is active
     */
    function showInsightsLoading(isLoading) {
        if (isLoading && !state.currentInsights) {
            renderInsightsSkeleton();
        }

        if (isLoading) {
            LoadingOverlay.show("insights");
            return;
        }
        LoadingOverlay.hide("insights");
    }

    /** Render temporary skeleton cards while insights are loading. */
    function renderInsightsSkeleton() {
        elements.insightsEmpty.hidden = true;
        elements.insightsGrid.hidden = false;
        elements.insightTip.hidden = true;

        elements.insightsGrid.innerHTML = `
            <div class="insight-card skeleton-insight">
                <div class="skeleton-block skeleton-icon"></div>
                <div class="skeleton-body">
                    <div class="skeleton-block skeleton-title"></div>
                    <div class="skeleton-block skeleton-meta skeleton-meta--wide"></div>
                    <div class="skeleton-block skeleton-meta skeleton-meta--mid"></div>
                </div>
            </div>
        `.repeat(3);
    }

    /**
     * Escape a string for safe HTML insertion.
     * @param {string} value - The string to escape.
     * @returns {string} The HTML-escaped string.
     */
    function escapeHtml(value) {
        const div = document.createElement("div");
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
            flame: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 10 C36 18 26 22 30 30 C32 34 40 34 40 42 C40 50 34 54 32 54 C26 54 22 48 22 42 C22 34 28 30 26 24" fill="none" stroke="currentColor" stroke-width="2"/></svg>`,
        };
        return icons[name] || icons.calendar;
    }

    return {
        init,
        onRouteChange,
        onRouteLeave,
    };
})();
