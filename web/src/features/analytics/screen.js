/* Analytics page logic */

import rough from "roughjs/bundled/rough.esm.js";

import { AppRouter } from "../../app/router.js";
import { parseAnalyticsWorkerMessage } from "../../app/worker-contracts.ts";
import { captureError } from "../../platform/observability/sentry.js";
import { DataCache } from "../../platform/persistence/data-cache.js";
import { Session } from "../../platform/persistence/session.js";
import { Storage } from "../../platform/persistence/storage.js";
import { DomEvents } from "../../shared/dom-events.js";
import { hideChartTooltip, showChartTooltip } from "../../shared/ui/chart-tooltip.js";
import { SketchCharts } from "../../shared/ui/charts.js";
import { LoadingOverlay } from "../../shared/ui/loading-overlay.js";
import { prefersReducedMotion } from "../../shared/ui/motion.js";
import { createRangeFilter } from "../../shared/ui/time-range.js";
import { createWorkerHandle } from "../../shared/worker-handle.js";

import { DAY_LABELS, MONTH_LABELS } from "./constants.js";

/** @typedef {import("../../app/router.js").RouteParams} RouteParams */
/** @typedef {import("../../shared/ui/charts.js").TimelinePoint} TimelinePoint */
/** @typedef {import("../../shared/ui/charts.js").TopicPoint} TopicPoint */
/** @typedef {import("../../platform/persistence/storage.js").StoredAnalytics} StoredAnalytics */

/**
 * Filter state the analytics and insights screens send with a worker view request.
 * @typedef {object} AnalyticsFilters
 * @property {string} timeRange - Range key ("1m", "3m", "6m", "12m" or "all")
 * @property {string} topic - Topic filter, or "all"
 * @property {string|null} monthFocus - Focused month ("YYYY-MM"), or null
 * @property {number|null} day - Focused weekday index (0 = Monday), or null
 * @property {number|null} hour - Focused hour (0-23), or null
 * @property {string} shareType - Share type filter, or "all"
 */

/**
 * The parts of the analytics worker's view that this screen renders.
 * @typedef {object} AnalyticsScreenView
 * @property {TimelinePoint[]} timeline - Timeline buckets
 * @property {number} timelineMax - Y-axis maximum for the timeline
 * @property {number[][]} heatmap - 7x24 activity grid (days x hours)
 * @property {TopicPoint[]} topics - Topic bars
 * @property {{current: number, longest: number}} streaks - Activity streaks in days
 * @property {{hour: number, count: number}} peakHour - Busiest hour
 * @property {{posts: number, comments: number, total: number}} totals - Activity totals
 */

/**
 * A worker "view" payload as this screen reads it.
 * @typedef {{view?: AnalyticsScreenView|null}} AnalyticsViewPayload
 */

/** @typedef {"topic"|"monthFocus"|"day"|"hour"} FilterResetField - Filters a chip can clear */

/**
 * DOM references the analytics screen works with.
 * @typedef {object} AnalyticsElements
 * @property {NodeListOf<HTMLElement>} timeRangeButtons - Time range buttons
 * @property {HTMLSelectElement|null} timeRangeSelect - Compact time range select
 * @property {HTMLElement|null} resetFiltersBtn - Reset filters button
 * @property {HTMLElement} activeFilters - Active filters container
 * @property {HTMLElement} activeFiltersList - Active filter chip list
 * @property {HTMLElement} analyticsEmpty - Empty state
 * @property {HTMLElement} analyticsGrid - Chart grid
 * @property {HTMLElement} statsGrid - Stats bar
 * @property {HTMLCanvasElement} timelineChart - Timeline canvas
 * @property {HTMLCanvasElement} topicsChart - Topics canvas
 * @property {HTMLCanvasElement} heatmapChart - Heatmap canvas
 * @property {HTMLElement} statPosts - Posts stat value
 * @property {HTMLElement} statComments - Comments stat value
 * @property {HTMLElement} statTotal - Total stat value
 * @property {HTMLElement} statPeak - Peak hour stat value
 * @property {HTMLElement} statStreak - Streak stat value
 * @property {HTMLElement|null} chartTooltip - Chart tooltip
 */

export const AnalyticsPage = (() => {
    "use strict";

    /** @type {AnalyticsFilters} */
    const FILTER_DEFAULTS = Object.freeze({
        timeRange: "12m",
        topic: "all",
        monthFocus: null,
        day: null,
        hour: null,
        shareType: "all",
    });

    const RANGE_VALUES = new Set(["1m", "3m", "6m", "12m", "all"]);
    /** @type {Set<unknown>} */
    const CACHE_EVENTS = new Set(["analyticsChanged", "storageCleared", "filesChanged"]);
    /** @type {Set<string>} */
    const CLICKABLE_TYPES = new Set(["month", "week", "heatmap", "topic"]);
    const WORKER_TIMEOUT_MS = 30000;

    /** @type {Readonly<Record<string, (value: string|undefined, normalized: AnalyticsFilters) => void>>} */
    const ROUTE_FILTER_PARSERS = Object.freeze({
        range: (value, normalized) => {
            const range = String(value || "").toLowerCase();
            normalized.timeRange = RANGE_VALUES.has(range) ? range : FILTER_DEFAULTS.timeRange;
        },
        topic: (value, normalized) => {
            const topic = String(value || "").trim();
            if (topic) {
                normalized.topic = topic;
            }
        },
        month: (value, normalized) => {
            const month = String(value || "").trim();
            if (/^\d{4}-\d{2}$/.test(month)) {
                normalized.monthFocus = month;
            }
        },
        day: (value, normalized) => {
            const day = Number(value);
            if (Number.isInteger(day) && day >= 0 && day <= 6) {
                normalized.day = day;
            }
        },
        hour: (value, normalized) => {
            const hour = Number(value);
            if (Number.isInteger(hour) && hour >= 0 && hour <= 23) {
                normalized.hour = hour;
            }
        },
        shareType: (value, normalized) => {
            const shareType = String(value || "").trim();
            if (shareType) {
                normalized.shareType = shareType;
            }
        },
    });

    /** @type {Readonly<Record<string, (filters: AnalyticsFilters) => string|null>>} */
    const ROUTE_FILTER_SERIALIZERS = Object.freeze({
        topic: (filters) => (filters.topic && filters.topic !== "all" ? filters.topic : null),
        month: (filters) => filters.monthFocus || null,
        day: (filters) =>
            filters.day !== null && filters.day !== undefined ? String(filters.day) : null,
        hour: (filters) =>
            filters.hour !== null && filters.hour !== undefined ? String(filters.hour) : null,
        shareType: (filters) =>
            filters.shareType && filters.shareType !== "all" ? filters.shareType : null,
    });

    /** @type {Readonly<Record<string, {field: FilterResetField, value: string|null}>>} */
    const FILTER_RESET_MAP = Object.freeze({
        topic: { field: "topic", value: "all" },
        month: { field: "monthFocus", value: null },
        day: { field: "day", value: null },
        hour: { field: "hour", value: null },
    });

    const TIMELINE_ANIMATION = {
        minDuration: 380,
        maxDuration: 1200,
        msPerPoint: 45,
    };

    /** @type {{filters: AnalyticsFilters, analyticsReady: boolean, hasData: boolean, currentView: AnalyticsScreenView|null}} */
    const state = {
        filters: { ...FILTER_DEFAULTS },
        analyticsReady: false,
        hasData: false,
        currentView: null,
    };

    // Assigned by init() before any handler that reads it can run.
    /** @type {AnalyticsElements} */
    let elements;
    /** @type {HTMLCanvasElement[]} */
    let chartCanvases = [];
    let initialized = false;
    let needsBaseReload = true;
    let isApplyingRouteParams = false;
    /** @type {import("../../shared/ui/time-range.js").RangeFilter|null} */
    let rangeFilter = null;

    const workers = createWorkerHandle({
        create: () =>
            new Worker(new URL("./analytics-worker.js", import.meta.url), {
                type: "module",
            }),
        onMessage: handleWorkerMessage,
        onError: handleWorkerError,
        onStartError: (error) => {
            captureError(error, {
                module: "analytics-ui",
                operation: "init-worker",
            });
            setEmptyState("Worker blocked", "Open this page from a local server (not file://).");
        },
    });
    let requestId = 0;
    /** @type {import("../../app/worker-contracts.ts").RequestId} */
    let pendingViewId = 0;
    /** @type {string|null} */
    let lastRequestedKey = null;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let debounceTimer = null;
    let isRendering = false;
    /** @type {AnalyticsScreenView|null} */
    let pendingRender = null;

    let renderRetryCount = 0;
    const MAX_RENDER_RETRIES = 5;
    /** @type {ResizeObserver|null} */
    let resizeObserver = null;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let renderRetryTimer = null;

    /** Initialize analytics page: bind events and worker lifecycle. */
    function init() {
        if (initialized) {
            return;
        }

        elements = resolveElements();
        if (!elements.analyticsGrid || !elements.timelineChart) {
            return;
        }

        chartCanvases = [
            elements.timelineChart,
            elements.topicsChart,
            elements.heatmapChart,
        ].filter(Boolean);

        initialized = true;
        bindEvents();
        workers.ensure();

        DataCache.subscribe(handleCacheChange);
    }

    /**
     * Handle route activation and URL param changes.
     * @param {RouteParams} params - Route query params
     */
    function onRouteChange(params) {
        if (!initialized) {
            init();
        }
        /* v8 ignore next 2 */
        if (!initialized) {
            return;
        }

        const filtersFromRoute = parseRouteFilters(params || {});
        const filtersChanged = applyFiltersFromRoute(filtersFromRoute);

        if (needsBaseReload || !state.analyticsReady) {
            loadBase();
            return;
        }

        if (!state.hasData) {
            updateVisibility();
            return;
        }

        if (filtersChanged || !state.currentView) {
            scheduleViewRequest(true);
        }
    }

    /** Cleanup when leaving analytics route. */
    function onRouteLeave() {
        hideTooltip();
        showAnalyticsLoading(false);
    }

    /**
     * Resolve analytics DOM element references.
     *
     * The static shell provides every node; init() bails out before binding
     * anything when the grid or the timeline canvas is missing.
     * @returns {AnalyticsElements}
     */
    function resolveElements() {
        /**
         * Look up an element the static shell always provides.
         * @template {HTMLElement} [T=HTMLElement]
         * @param {string} id - Element ID
         * @returns {T}
         */
        const byId = (id) => /** @type {T} */ (document.getElementById(id));
        return {
            timeRangeButtons: /** @type {NodeListOf<HTMLElement>} */ (
                document.querySelectorAll("#analyticsTimeRangeButtons .filter-btn")
            ),
            timeRangeSelect: /** @type {HTMLSelectElement|null} */ (
                document.getElementById("analyticsTimeRangeSelect")
            ),
            resetFiltersBtn: document.getElementById("analyticsResetFiltersBtn"),
            activeFilters: byId("activeFilters"),
            activeFiltersList: byId("activeFiltersList"),
            analyticsEmpty: byId("analyticsEmpty"),
            analyticsGrid: byId("analyticsGrid"),
            statsGrid: byId("statsGrid"),
            timelineChart: byId("timelineChart"),
            topicsChart: byId("topicsChart"),
            heatmapChart: byId("heatmapChart"),
            statPosts: byId("statPosts"),
            statComments: byId("statComments"),
            statTotal: byId("statTotal"),
            statPeak: byId("statPeak"),
            statStreak: byId("statStreak"),
            chartTooltip: document.getElementById("chartTooltip"),
        };
    }

    /** Attach event listeners for filters, charts, theme, and visibility. */
    function bindEvents() {
        // No route option: this screen writes its other filters into the route
        // beside the range, so it syncs the whole set itself.
        rangeFilter = createRangeFilter({
            ranges: RANGE_VALUES,
            fallback: FILTER_DEFAULTS.timeRange,
            buttons: elements.timeRangeButtons,
            select: elements.timeRangeSelect,
            resetButton: elements.resetFiltersBtn,
            onChange: (range) => {
                state.filters = { ...FILTER_DEFAULTS, timeRange: range };
                syncRouteFromFilters();
                scheduleViewRequest(true);
            },
        });
        if (elements.activeFiltersList) {
            elements.activeFiltersList.addEventListener("click", handleFilterChipClick);
        }

        window.addEventListener("beforeunload", workers.terminate);
        window.addEventListener("pagehide", workers.terminate);

        document.addEventListener("themechange", () => {
            if (state.currentView) {
                renderAnalyticsView(state.currentView);
            }
        });

        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible" && state.currentView) {
                renderAnalyticsView(state.currentView);
            }
        });

        chartCanvases.forEach((canvas) => {
            canvas.addEventListener("mousemove", handleChartHover);
            canvas.addEventListener("mouseleave", hideTooltip);
            canvas.addEventListener("click", handleChartClick);
            canvas.setAttribute("tabindex", "0");
        });
    }

    /**
     * Handle cache notifications from uploads/clear operations.
     * @param {{type?: unknown}} event - Notification payload
     */
    function handleCacheChange(event) {
        const type = event && event.type;
        if (!CACHE_EVENTS.has(type)) {
            return;
        }

        needsBaseReload = true;
        state.analyticsReady = false;
        state.hasData = false;
        state.currentView = null;
        lastRequestedKey = null;
    }

    /** Load analytics base data from IndexedDB and send to worker. */
    async function loadBase() {
        try {
            await Session.waitForCleanup();

            const worker = workers.ensure();
            if (!worker) {
                setEmptyState(
                    "Analytics not supported",
                    "Your browser does not support analytics workers.",
                );
                return;
            }

            let analyticsBase =
                /** @type {StoredAnalytics|undefined} */ (DataCache.get("storage:analyticsBase")) ||
                null;

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
                return;
            }

            showAnalyticsLoading(true);
            worker.postMessage({
                type: "initBase",
                payload: analyticsBase,
            });
            workers.watch(WORKER_TIMEOUT_MS, () => {
                setEmptyState(
                    "Worker timeout",
                    "Analytics worker did not respond in time. Try refreshing the page.",
                );
                workers.terminate();
            });
            needsBaseReload = false;
        } catch (error) {
            captureError(error, {
                module: "analytics-ui",
                operation: "load-base",
            });
            setEmptyState(
                "Storage error",
                "Unable to load saved data. Try clearing browser data and re-uploading.",
            );
            showAnalyticsLoading(false);
        }
    }

    /**
     * Handle messages received from the analytics worker.
     * @param {MessageEvent} event - The message event from the worker.
     */
    function handleWorkerMessage(event) {
        const parsed = parseAnalyticsWorkerMessage(event.data || {});
        if (!parsed.valid) {
            // invalid() returns an error string. Keep the fallback for malformed worker data.
            /* v8 ignore next */
            captureError(new Error(parsed.error || "Invalid analytics worker message."), {
                module: "analytics-ui",
                operation: "worker-message-parse",
            });
            return;
        }

        const message = parsed.value;

        switch (message.type) {
            case "init":
                workers.unwatch();
                state.analyticsReady = true;
                state.hasData = Boolean(message.payload && message.payload.hasData);
                updateVisibility();
                scheduleViewRequest(true);
                return;
            case "view":
                if (message.requestId !== pendingViewId) {
                    return;
                }
                // The parser returns an object. Keep the fallback for malformed worker data.
                /* v8 ignore next */
                applyWorkerViewPayload(/** @type {AnalyticsViewPayload} */ (message.payload || {}));
                return;
            case "error":
                workers.unwatch();
                captureError(
                    new Error(getWorkerMessage(message.payload, "Analytics worker error.")),
                    {
                        module: "analytics-ui",
                        operation: "worker-error-payload",
                        requestId: message.requestId,
                    },
                );
                setEmptyState(
                    "Analytics error",
                    getWorkerMessage(message.payload, "Analytics worker error."),
                );
                return;
            /* v8 ignore next 2 */
            default:
                return;
        }
    }

    /**
     * Apply worker view payload to analytics state and trigger rendering.
     * @param {AnalyticsViewPayload} payload - Worker payload
     */
    function applyWorkerViewPayload(payload) {
        state.currentView = payload.view || null;
        if (!state.currentView) {
            showAnalyticsLoading(false);
            return;
        }

        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                renderAnalyticsView(state.currentView);
            });
        });
    }

    /**
     * Resolve a worker message text with fallback.
     * @param {{message?: string}|null|undefined} payload - Worker payload
     * @param {string} fallback - Fallback message
     * @returns {string}
     */
    function getWorkerMessage(payload, fallback) {
        // Keep the fallback for malformed worker data that omits the message.
        /* v8 ignore next */
        return payload && payload.message ? payload.message : fallback;
    }

    /**
     * Handle worker-level errors.
     * @param {ErrorEvent|MessageEvent} event - Worker error or messageerror event
     */
    function handleWorkerError(event) {
        const workerError =
            event && "error" in event && event.error
                ? event.error
                : new Error(`Analytics worker ${event && event.type ? event.type : "error"} event`);
        captureError(workerError, {
            module: "analytics-ui",
            operation: "worker-error-event",
        });
        // Tear down the broken worker: this clears the in-flight loadBase watchdog
        // (so it cannot fire ~30s later and overwrite the screen) and nulls the
        // reference so a subsequent loadBase recreates a fresh worker instead of
        // posting to a dead one (the handle reuses a worker while one is set).
        workers.terminate();
        setEmptyState("Analytics worker error", "Refresh the page and try again.");
    }

    /**
     * Build a unique string key from the current filter state.
     * @param {AnalyticsFilters} filters - The current filter state.
     * @returns {string} A pipe-delimited key representing the filters.
     */
    function getFilterKey(filters) {
        return [
            filters.timeRange,
            filters.topic,
            filters.monthFocus || "none",
            filters.day !== null && filters.day !== undefined ? filters.day : "none",
            filters.hour !== null && filters.hour !== undefined ? filters.hour : "none",
            // Use "all" when the filter state does not include a share type.
            /* v8 ignore next */
            filters.shareType || "all",
        ].join("|");
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
        const worker = workers.current();
        if (!worker || !state.analyticsReady || !state.hasData) {
            return;
        }

        const key = getFilterKey(state.filters);
        if (!force && key === lastRequestedKey) {
            return;
        }

        lastRequestedKey = key;
        const id = ++requestId;
        pendingViewId = id;
        worker.postMessage({
            type: "view",
            requestId: id,
            filters: { ...state.filters },
        });
        showAnalyticsLoading(true);
    }

    /**
     * Check whether all chart canvases have non-zero dimensions.
     * @returns {boolean} True if all canvases are sized.
     */
    function areChartsSized() {
        return chartCanvases.every((canvas) => {
            const rect = canvas.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        });
    }

    /**
     * Defer rendering until chart containers have layout dimensions.
     * @param {AnalyticsScreenView} view - The analytics view data to render once sized.
     */
    function scheduleRenderWhenSized(view) {
        pendingRender = view;
        /* v8 ignore next 3 */
        if (resizeObserver) {
            return;
        }

        const wrappers = /** @type {HTMLElement[]} */ (
            chartCanvases.map((canvas) => canvas.parentElement).filter(Boolean)
        );
        if (typeof ResizeObserver !== "undefined" && wrappers.length) {
            resizeObserver = new ResizeObserver(() => {
                /* v8 ignore next 3 */
                if (!pendingRender || !areChartsSized()) {
                    return;
                }
                const next = pendingRender;
                pendingRender = null;
                /** @type {ResizeObserver} */ (resizeObserver).disconnect();
                resizeObserver = null;
                renderRetryCount = 0;
                renderAnalyticsView(next);
            });
            wrappers.forEach((wrapper) =>
                /** @type {ResizeObserver} */ (resizeObserver).observe(wrapper),
            );
            return;
        }

        /* v8 ignore next 11 */
        if (renderRetryCount < MAX_RENDER_RETRIES) {
            renderRetryCount += 1;
            // clearTimeout ignores null at runtime; the cast only satisfies its signature.
            clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (renderRetryTimer));
            renderRetryTimer = setTimeout(() => {
                renderRetryTimer = null;
                if (!pendingRender) {
                    return;
                }
                const next = pendingRender;
                pendingRender = null;
                renderAnalyticsView(next);
            }, 80);
        }
    }

    /**
     * Update the stats bar with totals from the current view.
     * @param {AnalyticsScreenView} view - The view containing totals, peakHour, and streaks.
     */
    function updateStats(view) {
        elements.statPosts.textContent = String(view.totals.posts);
        elements.statComments.textContent = String(view.totals.comments);
        elements.statTotal.textContent = String(view.totals.total);
        elements.statPeak.textContent = view.totals.total
            ? `${String(view.peakHour.hour).padStart(2, "0")}:00`
            : "-";
        elements.statStreak.textContent = view.totals.total
            ? `${view.streaks.current} days`
            : "0 days";
    }

    /**
     * Calculate animation duration based on timeline length.
     * @param {number} pointCount - The number of data points in the timeline.
     * @returns {number} Animation duration in milliseconds.
     */
    function getTimelineAnimationDuration(pointCount) {
        return Math.min(
            TIMELINE_ANIMATION.maxDuration,
            Math.max(TIMELINE_ANIMATION.minDuration, pointCount * TIMELINE_ANIMATION.msPerPoint),
        );
    }

    /**
     * Draw all three chart canvases from the view data.
     * @param {AnalyticsScreenView} view - The view containing timeline, topics, and heatmap data.
     */
    function renderCharts(view) {
        SketchCharts.drawHeatmap(elements.heatmapChart, view.heatmap, "No activity in this range yet.");
        SketchCharts.drawTopics(elements.topicsChart, view.topics, 1, "No topics in this range yet.");

        if (shouldAnimate(view)) {
            const duration = getTimelineAnimationDuration(view.timeline.length);
            SketchCharts.animateDraw((progress) => {
                SketchCharts.drawTimeline(
                    elements.timelineChart,
                    view.timeline,
                    state.filters.timeRange,
                    progress,
                    view.timelineMax,
                );
            }, duration);
            return;
        }

        SketchCharts.drawTimeline(
            elements.timelineChart,
            view.timeline,
            state.filters.timeRange,
            1,
            view.timelineMax,
        );
    }

    /**
     * Main render entry point: update stats, filters, and charts.
     * @param {AnalyticsScreenView|null} view - The analytics view data to render.
     */
    function renderAnalyticsView(view) {
        if (isRendering) {
            pendingRender = view;
            return;
        }

        try {
            // Callers pass a view object. Keep the branch for malformed worker data.
            /* v8 ignore next */
            if (!view) {
                setEmptyState("No analytics data", "Try resetting filters.");
                showAnalyticsLoading(false);
                return;
            }

            /* v8 ignore next 5 */
            if (!rough) {
                setEmptyState(
                    "Charts unavailable",
                    "Required libraries failed to load. Please refresh the page.",
                );
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
        } catch (error) {
            captureError(error, {
                module: "analytics-ui",
                operation: "render-view",
            });
            setEmptyState("Render error", "Failed to draw charts. Please refresh the page.");
        } finally {
            /* v8 ignore next 9 */
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
            setEmptyState(
                "No data available yet",
                "Upload Shares.csv or Comments.csv on the Home page.",
            );
            return;
        }
        hideEmptyState();
    }

    /**
     * Handle click on an active filter chip to remove it.
     * @param {Event} event - The click event.
     */
    function handleFilterChipClick(event) {
        const button = DomEvents.closest(event, "button[data-filter]");
        if (!button) {
            return;
        }

        const filter = button.getAttribute("data-filter");
        const entry = filter ? FILTER_RESET_MAP[filter] : null;
        if (entry) {
            /** @type {Record<FilterResetField, string|number|null>} */ (state.filters)[
                entry.field
            ] = entry.value;
            syncRouteFromFilters();
            scheduleViewRequest(false);
        }
    }

    /** Render the list of active filter chips. */
    function renderActiveFilters() {
        const filters = [];

        if (state.filters.topic && state.filters.topic !== "all") {
            filters.push({ key: "topic", label: `Topic: ${state.filters.topic}` });
        }
        if (state.filters.monthFocus) {
            const [year, month] = state.filters.monthFocus.split("-").map(Number);
            const label =
                year && month
                    ? `Month: ${MONTH_LABELS[month - 1]} ${year}`
                    : `Month: ${state.filters.monthFocus}`;
            filters.push({ key: "month", label });
        }
        if (state.filters.day !== null && state.filters.day !== undefined) {
            // Use "Unknown" when the selected day has no label in DAY_LABELS.
            /* v8 ignore next */
            const label = DAY_LABELS[state.filters.day] || "Unknown";
            filters.push({ key: "day", label: `Day: ${label}` });
        }
        if (state.filters.hour !== null && state.filters.hour !== undefined) {
            filters.push({
                key: "hour",
                label: `Hour: ${String(state.filters.hour).padStart(2, "0")}:00`,
            });
        }

        if (!filters.length) {
            elements.activeFilters.hidden = true;
            elements.activeFiltersList.replaceChildren();
            return;
        }

        elements.activeFilters.hidden = false;
        const fragment = document.createDocumentFragment();
        filters.forEach((filter) => {
            fragment.appendChild(createFilterChip(filter));
        });
        elements.activeFiltersList.replaceChildren(fragment);
    }

    /**
     * Create one active-filter chip element.
     * @param {{key: string, label: string}} filter - Filter descriptor
     * @returns {HTMLElement}
     */
    function createFilterChip(filter) {
        const chip = document.createElement("span");
        chip.className = "filter-chip";
        chip.append(document.createTextNode(filter.label));

        const button = document.createElement("button");
        button.setAttribute("data-filter", filter.key);
        button.setAttribute("aria-label", "Remove filter");
        button.textContent = "x";

        chip.appendChild(button);
        return chip;
    }

    /**
     * Handle mousemove on chart canvas for tooltip and cursor.
     * @param {MouseEvent} event - The mousemove event.
     */
    function handleChartHover(event) {
        const canvas = /** @type {HTMLCanvasElement} */ (event.currentTarget);
        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        const item = SketchCharts.getItemAt(canvas, x, y);
        if (item && item.tooltip) {
            showTooltip(event.clientX, event.clientY, item.tooltip);
        } else {
            hideTooltip();
        }

        canvas.style.cursor = item && CLICKABLE_TYPES.has(item.type) ? "pointer" : "default";
    }

    /**
     * Handle click on chart canvas to toggle filters.
     * @param {MouseEvent} event - The click event.
     */
    function handleChartClick(event) {
        const canvas = /** @type {HTMLCanvasElement} */ (event.currentTarget);
        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        const item = SketchCharts.getItemAt(canvas, x, y);
        if (!item) {
            return;
        }

        switch (item.type) {
            case "month":
                state.filters.monthFocus = state.filters.monthFocus === item.key ? null : item.key;
                break;
            case "week": {
                const targetMonth = item.monthKey || item.key;
                state.filters.monthFocus =
                    state.filters.monthFocus === targetMonth ? null : targetMonth;
                break;
            }
            case "topic":
                state.filters.topic = state.filters.topic === item.key ? "all" : item.key;
                break;
            case "heatmap": {
                const isSame = state.filters.day === item.day && state.filters.hour === item.hour;
                state.filters.day = isSame ? null : item.day;
                state.filters.hour = isSame ? null : item.hour;
                break;
            }
            default:
                return;
        }

        syncRouteFromFilters();
        scheduleViewRequest(false);
    }

    /**
     * Position and show the chart tooltip.
     * @param {number} clientX - The client X coordinate.
     * @param {number} clientY - The client Y coordinate.
     * @param {string} text - The tooltip text to display.
     */
    function showTooltip(clientX, clientY, text) {
        showChartTooltip(elements.chartTooltip, clientX, clientY, text);
    }

    /** Hide the chart tooltip. */
    function hideTooltip() {
        hideChartTooltip(elements.chartTooltip);
    }

    /**
     * Toggle loading visuals for analytics screen.
     * @param {boolean} isLoading - Whether analytics is loading
     */
    function showAnalyticsLoading(isLoading) {
        elements.analyticsGrid.style.opacity = isLoading ? "0.55" : "1";
        elements.statsGrid.style.opacity = isLoading ? "0.55" : "1";
        elements.analyticsGrid.style.pointerEvents = isLoading ? "none" : "auto";

        if (isLoading) {
            LoadingOverlay.show("analytics");
        } else {
            LoadingOverlay.hide("analytics");
        }
    }

    /**
     * Show the empty state with a title and message.
     * @param {string} title - The heading text for the empty state.
     * @param {string} message - The description text for the empty state.
     */
    function setEmptyState(title, message) {
        const heading = elements.analyticsEmpty.querySelector("h2");
        const text = elements.analyticsEmpty.querySelector("p");

        if (heading) {
            heading.textContent = title;
        }
        if (text) {
            text.textContent = message;
        }

        elements.analyticsEmpty.hidden = false;
        elements.analyticsGrid.hidden = true;
        elements.statsGrid.hidden = true;
        elements.activeFilters.hidden = true;
        elements.activeFiltersList.replaceChildren();
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
     * @param {AnalyticsScreenView} view - The analytics view to check.
     * @returns {boolean} True if the timeline should animate.
     */
    function shouldAnimate(view) {
        if (prefersReducedMotion()) {
            return false;
        }
        if (document.visibilityState && document.visibilityState !== "visible") {
            return false;
        }
        if (
            !view ||
            !Array.isArray(view.timeline) ||
            view.timeline.length < 2 ||
            view.timeline.length > 48
        ) {
            return false;
        }
        return view.totals.total < 4000;
    }

    /**
     * Parse route query params into a normalized filter object.
     * @param {RouteParams} params - Route query params
     * @returns {AnalyticsFilters}
     */
    function parseRouteFilters(params) {
        const normalized = { ...FILTER_DEFAULTS };

        Object.entries(ROUTE_FILTER_PARSERS).forEach(([paramKey, parser]) => {
            parser(params[paramKey], normalized);
        });

        return normalized;
    }

    /**
     * Apply parsed route filters to state.
     * @param {AnalyticsFilters} nextFilters - Parsed filters
     * @returns {boolean} Whether filters changed
     */
    function applyFiltersFromRoute(nextFilters) {
        const previousKey = getFilterKey(state.filters);
        isApplyingRouteParams = true;
        state.filters = { ...nextFilters };
        /** @type {import("../../shared/ui/time-range.js").RangeFilter} */ (rangeFilter).show(
            state.filters.timeRange,
        );
        renderActiveFilters();
        isApplyingRouteParams = false;
        return previousKey !== getFilterKey(state.filters);
    }

    /** Sync active filter state into route query parameters. */
    function syncRouteFromFilters() {
        /* v8 ignore next 3 */
        if (isApplyingRouteParams) {
            return;
        }

        const currentRoute = AppRouter.getCurrentRoute();
        if (!currentRoute || currentRoute.name !== "analytics") {
            return;
        }

        /** @type {Record<string, string>} */
        const params = {
            range: state.filters.timeRange,
        };

        Object.entries(ROUTE_FILTER_SERIALIZERS).forEach(([paramKey, serializer]) => {
            const value = serializer(state.filters);
            if (value !== null && value !== undefined && value !== "") {
                params[paramKey] = value;
            }
        });

        AppRouter.setParams(params, { replaceHistory: false });
    }

    return {
        init,
        onRouteChange,
        onRouteLeave,
    };
})();
