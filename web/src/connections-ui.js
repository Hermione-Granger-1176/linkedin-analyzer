/* Connections page logic */

import { SketchCharts } from "./charts.js";
import { DataCache } from "./data-cache.js";
import { LoadingOverlay } from "./loading-overlay.js";
import { AppRouter } from "./router.js";
import { captureError } from "./sentry.js";
import { Session } from "./session.js";
import { Storage } from "./storage.js";
import { reportPerformanceMeasure } from "./telemetry.js";
import { hideChartTooltip, showChartTooltip } from "./ui/chart-tooltip.js";
import { parseConnectionsWorkerMessage, parseStoredUploadFile } from "./worker-contracts.js";

export const ConnectionsPage = (() => {
    "use strict";

    /** @type {{ timeRange: string }} */
    const FILTER_DEFAULTS = Object.freeze({
        timeRange: "12m",
    });

    const RANGE_DAYS = Object.freeze({
        "1m": 30,
        "3m": 91,
        "6m": 182,
        "12m": 365,
    });

    const RANGE_VALUES = new Set(["1m", "3m", "6m", "12m", "all"]);
    const CACHE_EVENTS = new Set(["filesChanged", "storageCleared"]);
    const WORKER_TIMEOUT_MS = 30000;
    const TOP_N = 10;

    const state = {
        filters: { ...FILTER_DEFAULTS },
        dataReady: false,
        hasData: false,
        allRows: null,
        allTimeline: null,
        workerStats: null,
        currentView: null,
    };

    let elements = null;
    let chartCanvases = [];
    let initialized = false;
    let isApplyingRouteParams = false;

    let worker = null;
    let requestId = 0;
    let pendingRequestId = 0;
    let workerTimeoutId = null;

    /** Initialize connections page: bind events, worker, and cache subscription. */
    function init() {
        if (initialized) {
            return;
        }

        elements = resolveElements();
        if (!elements.connectionsGrid || !elements.connectionGrowthChart) {
            return;
        }

        chartCanvases = [
            elements.connectionGrowthChart,
            elements.connectionCompaniesChart,
            elements.connectionPositionsChart,
            /* v8 ignore next */
        ].filter(Boolean);

        initialized = true;
        bindEvents();
        initWorker();

        DataCache.subscribe(handleCacheChange);
    }

    /**
     * Handle route activation and URL param changes.
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

        const nextRange = parseRangeParam(params && params.range);
        const changed = applyRangeFromRoute(nextRange);

        if (!state.dataReady) {
            loadData();
            return;
        }

        if (!state.hasData) {
            updateVisibility();
            return;
        }

        if (changed || !state.currentView) {
            applyFiltersAndRender();
        }
    }

    /** Cleanup when leaving connections route. */
    function onRouteLeave() {
        hideTooltip();
        showConnectionsLoading(false);
    }

    /**
     * Resolve connections DOM element references.
     * @returns {object}
     */
    function resolveElements() {
        return {
            timeRangeButtons: document.querySelectorAll("#connectionsTimeRangeButtons .filter-btn"),
            resetFiltersBtn: document.getElementById("connectionsResetFiltersBtn"),
            connectionsEmpty: document.getElementById("connectionsEmpty"),
            connectionsGrid: document.getElementById("connectionsGrid"),
            connectionsStatsGrid: document.getElementById("connectionsStatsGrid"),
            connStatTotal: document.getElementById("connStatTotal"),
            connStatRecent: document.getElementById("connStatRecent"),
            connStatTopCompany: document.getElementById("connStatTopCompany"),
            connStatNetworkAge: document.getElementById("connStatNetworkAge"),
            connectionGrowthChart: document.getElementById("connectionGrowthChart"),
            connectionCompaniesChart: document.getElementById("connectionCompaniesChart"),
            connectionPositionsChart: document.getElementById("connectionPositionsChart"),
            chartTooltip: document.getElementById("chartTooltip"),
        };
    }

    /** Attach event listeners for filters and chart interactions. */
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

        window.addEventListener("beforeunload", terminateWorker);
        window.addEventListener("pagehide", terminateWorker);

        document.addEventListener("themechange", () => {
            if (state.currentView) {
                renderView(state.currentView);
            }
        });

        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible" && state.currentView) {
                renderView(state.currentView);
            }
        });

        chartCanvases.forEach((canvas) => {
            canvas.addEventListener("mousemove", handleChartHover);
            canvas.addEventListener("mouseleave", hideTooltip);
            canvas.setAttribute("tabindex", "0");
        });
    }

    /** Create the connections Web Worker. */
    function initWorker() {
        if (typeof Worker === "undefined" || worker) {
            return;
        }

        try {
            worker = new Worker(new URL("./connections-worker.js", import.meta.url), {
                type: "module",
            });
            worker.addEventListener("message", handleWorkerMessage);
            worker.addEventListener("error", handleWorkerError);
        } catch (error) {
            worker = null;
            captureError(error, {
                module: "connections-ui",
                operation: "init-worker",
            });
        }
    }

    /** Terminate the connections Web Worker to free resources. */
    function terminateWorker() {
        if (!worker) {
            return;
        }
        worker.terminate();
        worker = null;
        clearWorkerTimeout();
    }

    /** Clear any in-flight worker watchdog timeout. */
    function clearWorkerTimeout() {
        if (!workerTimeoutId) {
            return;
        }
        window.clearTimeout(workerTimeoutId);
        workerTimeoutId = null;
    }

    /**
     * Handle cache notifications from uploads or clear operations.
     * @param {object} event - Notification payload
     */
    function handleCacheChange(event) {
        const type = event && event.type;
        if (!CACHE_EVENTS.has(type)) {
            return;
        }

        if (type === "filesChanged" && event.fileType && event.fileType !== "connections") {
            return;
        }

        state.dataReady = false;
        state.hasData = false;
        state.allRows = null;
        state.allTimeline = null;
        state.workerStats = null;
        state.currentView = null;
    }

    /** Load connections CSV from IndexedDB and send to worker for parsing. */
    async function loadData() {
        showConnectionsLoading(true);
        markPerformance("connections:idb-read:start");

        try {
            await Session.waitForCleanup();

            initWorker();

            const file = await loadConnectionsFile();
            markPerformance("connections:idb-read:end");
            measurePerformance(
                "connections:idb-read",
                "connections:idb-read:start",
                "connections:idb-read:end",
            );
            if (!file || !file.text) {
                setEmptyState(
                    "No connections data available yet",
                    "Upload Connections.csv on the Home page to see your network analytics.",
                );
                showConnectionsLoading(false);
                return;
            }

            if (!worker) {
                setEmptyState(
                    "Connections not supported",
                    "Your browser does not support Web Workers. Open this page from a local server (not file://).",
                );
                showConnectionsLoading(false);
                return;
            }

            const id = ++requestId;
            pendingRequestId = id;
            clearWorkerTimeout();
            workerTimeoutId = window.setTimeout(() => {
                if (pendingRequestId !== id) {
                    return;
                }
                pendingRequestId = 0;
                setEmptyState(
                    "Connections timeout",
                    "Parsing took too long. Please retry the upload.",
                );
                showConnectionsLoading(false);
                terminateWorker();
            }, WORKER_TIMEOUT_MS);
            markPerformance("connections:worker-parse:start");
            worker.postMessage({
                type: "process",
                requestId: id,
                payload: { connectionsCsv: file.text },
            });
            /* v8 ignore next 7 */
        } catch (error) {
            captureError(error, {
                module: "connections-ui",
                operation: "load-data",
            });
            clearWorkerTimeout();
            setEmptyState(
                "Storage error",
                "Unable to load saved data. Try clearing browser data and re-uploading.",
            );
            showConnectionsLoading(false);
        }
    }

    /**
     * Load the connections file from DataCache or IndexedDB.
     * @returns {Promise<object|null>} The stored file record or null
     */
    async function loadConnectionsFile() {
        const cacheKey = "storage:file:connections";

        const cached = normalizeConnectionsFile(DataCache.get(cacheKey) || null, "cache");
        if (cached) {
            return cached;
        }

        const file = normalizeConnectionsFile(await Storage.getFile("connections"), "storage");
        if (file) {
            DataCache.set(cacheKey, file);
        }
        return file;
    }

    /**
     * Validate one stored connections file record.
     * @param {object|null} file - Raw storage payload
     * @param {'cache'|'storage'} source - Data source identifier
     * @returns {object|null}
     */
    function normalizeConnectionsFile(file, source) {
        if (!file) {
            return null;
        }

        const parsed = parseStoredUploadFile(file);
        if (parsed.valid && parsed.value.type === "connections") {
            return parsed.value;
        }

        if (typeof file.text === "string") {
            return {
                type: "connections",
                name: typeof file.name === "string" ? file.name : "Connections.csv",
                text: file.text,
                rowCount: Number.isFinite(file.rowCount) ? file.rowCount : 0,
                updatedAt: Number.isFinite(file.updatedAt) ? file.updatedAt : Date.now(),
            };
        }

        captureError(
            new Error(
                parsed.valid
                    ? "Unexpected file type in connections cache."
                    : parsed.error || "Invalid connections file payload.",
            ),
            {
                module: "connections-ui",
                operation: "parse-stored-file",
                source,
            },
        );
        return null;
    }

    /**
     * Handle messages received from the connections worker.
     * @param {MessageEvent} event - The message event from the worker
     */
    function handleWorkerMessage(event) {
        const parsed = parseConnectionsWorkerMessage(event.data || {});
        if (!parsed.valid) {
            captureError(new Error(parsed.error || "Invalid connections worker message."), {
                module: "connections-ui",
                operation: "worker-message-parse",
            });
            return;
        }

        const message = parsed.value;

        const HANDLERS = {
            processed: handleParsedPayload,
            error: handleWorkerErrorPayload,
        };

        const handler = HANDLERS[message.type];
        /* v8 ignore next 3 */
        if (!handler) {
            return;
        }
        handler(message);
    }

    /**
     * Process the parsed connections data from the worker.
     * @param {object} message - Worker message with parsed payload
     */
    function handleParsedPayload(message) {
        if (message.requestId !== pendingRequestId) {
            return;
        }

        clearWorkerTimeout();
        markPerformance("connections:worker-parse:end");
        measurePerformance(
            "connections:worker-parse",
            "connections:worker-parse:start",
            "connections:worker-parse:end",
        );

        const payload = message.payload || {};

        if (!payload.success) {
            setEmptyState("Connections error", payload.error || "Unable to parse Connections.csv.");
            showConnectionsLoading(false);
            return;
        }

        /* v8 ignore next 2 */
        const analytics = payload.analytics || {};
        const rawRows = payload.rows || [];

        /* Normalize field names for client-side filtering (worker returns title-case keys) */
        markPerformance("connections:normalize:start");
        const rows = rawRows.map((row) => ({
            connectedOn: parseConnectedOn(row["Connected On"]),
            company: (row.Company || "").trim(),
            position: (row.Position || "").trim(),
        }));
        markPerformance("connections:normalize:end");
        measurePerformance(
            "connections:normalize",
            "connections:normalize:start",
            "connections:normalize:end",
        );

        state.dataReady = true;
        state.hasData = rows.length > 0;
        state.allRows = rows;
        state.allTimeline = analytics.growthTimeline || [];
        state.workerStats = analytics.stats || {};

        updateVisibility();

        if (!state.hasData) {
            showConnectionsLoading(false);
            return;
        }

        markPerformance("connections:render:start");
        applyFiltersAndRender();
        markPerformance("connections:render:end");
        measurePerformance(
            "connections:render",
            "connections:render:start",
            "connections:render:end",
        );
    }

    /**
     * Handle error payloads from the worker.
     * @param {object} message - Worker error message
     */
    function handleWorkerErrorPayload(message) {
        clearWorkerTimeout();
        const text =
            message.payload && message.payload.message
                ? message.payload.message
                : "Unable to parse Connections.csv.";
        captureError(new Error(text), {
            module: "connections-ui",
            operation: "worker-error-payload",
            requestId: message.requestId,
        });
        setEmptyState("Connections error", text);
        showConnectionsLoading(false);
    }

    /**
     * Handle worker-level errors (uncaught exceptions).
     * @param {ErrorEvent} event - Worker error event
     */
    function handleWorkerError(event) {
        clearWorkerTimeout();
        captureError(
            event && event.error ? event.error : new Error("Connections worker error event"),
            {
                module: "connections-ui",
                operation: "worker-error-event",
            },
        );
        setEmptyState("Worker error", "Refresh the page and try again.");
        showConnectionsLoading(false);
    }

    /**
     * Mark a performance point if available.
     * @param {string} name - Mark name
     */
    function markPerformance(name) {
        /* v8 ignore next 3 */
        if (typeof performance === "undefined" || typeof performance.mark !== "function") {
            return;
        }
        performance.mark(name);
    }

    /**
     * Measure a performance range if available.
     * @param {string} name - Measure name
     * @param {string} start - Start mark
     * @param {string} end - End mark
     */
    function measurePerformance(name, start, end) {
        /* v8 ignore next 3 */
        if (typeof performance === "undefined" || typeof performance.measure !== "function") {
            return;
        }
        try {
            performance.measure(name, start, end);

            if (typeof performance.getEntriesByName === "function") {
                const entries = performance.getEntriesByName(name);
                const lastEntry = entries.length ? entries[entries.length - 1] : null;
                if (
                    lastEntry &&
                    lastEntry.entryType === "measure" &&
                    Number.isFinite(lastEntry.duration)
                ) {
                    reportPerformanceMeasure(name, lastEntry.duration, {
                        module: "connections-ui",
                    });
                }
            }
            /* v8 ignore next 3 */
        } catch {
            // Ignore missing marks to keep instrumentation resilient.
        }
    }

    /**
     * Apply client-side time-range filter and recompute the view.
     * Growth chart always shows ALL-TIME data for context.
     * Company and position are filtered by range; stats combine all-time and range-specific values.
     */
    function applyFiltersAndRender() {
        if (!state.allRows || !state.allRows.length) {
            return;
        }

        const filtered = filterRowsByRange(state.allRows, state.filters.timeRange);
        const companies = aggregateField(filtered, "company");
        const positions = aggregateField(filtered, "position");
        const ws = state.workerStats;
        const stats = {
            total: (ws && ws.total) || state.allRows.length,
            recent: filtered.length,
            topCompany: findTopValue(filtered, "company"),
            networkAge: formatNetworkAge((ws && ws.networkAgeMonths) || 0),
        };

        const view = {
            timeline: state.allTimeline,
            companies,
            positions,
            stats,
        };

        state.currentView = view;
        renderView(view);
    }

    /**
     * Parse a cleaned "Connected On" date string into a timestamp.
     * @param {string} dateStr - ISO-style date string (YYYY-MM-DD)
     * @returns {number} Epoch milliseconds, or 0 if unparseable
     */
    function parseConnectedOn(dateStr) {
        /* v8 ignore next 6 */
        if (!dateStr || typeof dateStr !== "string") {
            return 0;
        }
        const parts = dateStr.split("-");
        if (parts.length !== 3) {
            return 0;
        }
        const y = Number(parts[0]);
        const m = Number(parts[1]);
        const d = Number(parts[2]);
        if (Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) {
            return 0;
        }
        return new Date(y, m - 1, d).getTime();
    }

    /**
     * Filter connection rows by the selected time range.
     * @param {Array<object>} rows - All parsed connection rows
     * @param {string} range - Time range key ('1m', '3m', '6m', '12m', 'all')
     * @returns {Array<object>} Filtered rows within the range
     */
    function filterRowsByRange(rows, range) {
        if (range === "all") {
            return rows;
        }

        const days = RANGE_DAYS[range];
        /* v8 ignore next 3 */
        if (!days) {
            return rows;
        }

        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        return rows.filter((row) => row.connectedOn >= cutoff);
    }

    /**
     * Aggregate a string field into {topic, count} pairs, sorted descending.
     * @param {Array<object>} rows - Connection rows to aggregate
     * @param {string} field - Field name to aggregate ('company' or 'position')
     * @returns {Array<{topic: string, count: number}>} Top N aggregated entries
     */
    function aggregateField(rows, field) {
        const counts = Object.create(null);
        for (const row of rows) {
            const value = row[field];
            /* v8 ignore next 3 */
            if (!value) {
                continue;
            }
            counts[value] = (counts[value] || 0) + 1;
        }

        return Object.entries(counts)
            .map(([topic, count]) => ({ topic, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, TOP_N);
    }

    /**
     * Find the most frequent value for a given field.
     * @param {Array<object>} rows - Connection rows
     * @param {string} field - Field name
     * @returns {string} Most frequent value or '-'
     */
    function findTopValue(rows, field) {
        if (!rows.length) {
            return "-";
        }

        const counts = Object.create(null);
        let maxKey = "";
        let maxCount = 0;
        for (const row of rows) {
            const value = row[field];
            /* v8 ignore next 3 */
            if (!value) {
                continue;
            }
            const next = (counts[value] || 0) + 1;
            counts[value] = next;
            if (next > maxCount) {
                maxCount = next;
                maxKey = value;
            }
        }

        return maxKey || "-";
    }

    /**
     * Format a network age in months as a human-readable string.
     * @param {number} months - Network age from worker stats
     * @returns {string} Human-readable network age (e.g. '3.2 yr')
     */
    function formatNetworkAge(months) {
        if (!months) {
            return "-";
        }
        if (months < 12) {
            return `${months} mo`;
        }
        return `${(months / 12).toFixed(1)} yr`;
    }

    /**
     * Render the full connections view: stats, charts, and loading state.
     * @param {object} view - The computed view data
     */
    function renderView(view) {
        /* v8 ignore next 6 */
        if (!view) {
            setEmptyState("No connections data", "Try resetting filters.");
            showConnectionsLoading(false);
            return;
        }

        /* v8 ignore next 7 */
        if (!SketchCharts) {
            setEmptyState(
                "Charts unavailable",
                "Required libraries failed to load. Please refresh the page.",
            );
            showConnectionsLoading(false);
            return;
        }

        hideEmptyState();
        updateStats(view.stats);
        renderCharts(view);
        showConnectionsLoading(false);
    }

    /**
     * Update the stats bar with current view statistics.
     * @param {{total: number, recent: number, topCompany: string, networkAge: string}} stats
     */
    function updateStats(stats) {
        elements.connStatTotal.textContent = stats.total.toLocaleString();
        elements.connStatRecent.textContent = stats.recent.toLocaleString();
        elements.connStatTopCompany.textContent = stats.topCompany;
        elements.connStatNetworkAge.textContent = stats.networkAge;
    }

    /**
     * Draw the growth timeline and company/position bar charts.
     * @param {object} view - The computed view data
     */
    function renderCharts(view) {
        SketchCharts.drawTimeline(elements.connectionGrowthChart, view.timeline, "all", 1, 0);

        SketchCharts.drawTopics(elements.connectionCompaniesChart, view.companies, 1);
        SketchCharts.drawTopics(elements.connectionPositionsChart, view.positions, 1);
    }

    /** Toggle empty state vs content grid based on data availability. */
    function updateVisibility() {
        if (!state.hasData) {
            setEmptyState(
                "No connections data available yet",
                "Upload Connections.csv on the Home page to see your network analytics.",
            );
            return;
        }
        hideEmptyState();
    }

    /**
     * Handle click on a time range button.
     * @param {HTMLElement} button - The clicked time range button element
     */
    function handleTimeRangeChange(button) {
        const range = button.getAttribute("data-range");
        /* v8 ignore next 3 */
        if (!range) {
            return;
        }
        applyTimeRange(range);
    }

    /** Reset filters to defaults and re-render. */
    function resetFilters() {
        state.filters = { ...FILTER_DEFAULTS };
        setActiveTimeRange(FILTER_DEFAULTS.timeRange);
        syncRouteRange();
        applyFiltersAndRender();
    }

    /**
     * Apply a new time range and re-render.
     * @param {string} range - Time range key
     */
    function applyTimeRange(range) {
        const nextRange = RANGE_VALUES.has(range) ? range : FILTER_DEFAULTS.timeRange;
        state.filters = { ...FILTER_DEFAULTS, timeRange: nextRange };
        setActiveTimeRange(nextRange);
        syncRouteRange();
        applyFiltersAndRender();
    }

    /**
     * Update the active class on time range buttons.
     * @param {string} range - The active time range identifier
     */
    function setActiveTimeRange(range) {
        elements.timeRangeButtons.forEach((btn) => {
            const isActive = btn.getAttribute("data-range") === range;
            btn.classList.toggle("active", isActive);
            btn.setAttribute("aria-pressed", isActive ? "true" : "false");
        });
    }

    /**
     * Parse a route range query value into a valid range key.
     * @param {string} value - Raw route value
     * @returns {string} Validated range key
     */
    function parseRangeParam(value) {
        const range = String(value || "").toLowerCase();
        return RANGE_VALUES.has(range) ? range : FILTER_DEFAULTS.timeRange;
    }

    /**
     * Apply range from route params without triggering route sync.
     * @param {string} range - Validated range key
     * @returns {boolean} Whether the range changed
     */
    function applyRangeFromRoute(range) {
        const previous = state.filters.timeRange;
        isApplyingRouteParams = true;
        state.filters.timeRange = range;
        setActiveTimeRange(range);
        isApplyingRouteParams = false;
        return previous !== range;
    }

    /** Sync active time range into route query parameters. */
    function syncRouteRange() {
        /* v8 ignore next 3 */
        if (isApplyingRouteParams) {
            return;
        }

        const currentRoute = AppRouter.getCurrentRoute();
        if (!currentRoute || currentRoute.name !== "connections") {
            return;
        }

        AppRouter.setParams({ range: state.filters.timeRange }, { replaceHistory: false });
    }

    /**
     * Handle mousemove on chart canvas for tooltip display.
     * @param {MouseEvent} event - The mousemove event
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
    }

    /**
     * Position and show the chart tooltip.
     * @param {number} clientX - The client X coordinate
     * @param {number} clientY - The client Y coordinate
     * @param {string} text - The tooltip text to display
     */
    function showTooltip(clientX, clientY, text) {
        showChartTooltip(elements.chartTooltip, clientX, clientY, text);
    }

    /** Hide the chart tooltip. */
    function hideTooltip() {
        hideChartTooltip(elements.chartTooltip);
    }

    /**
     * Toggle loading visuals for connections screen.
     * @param {boolean} isLoading - Whether connections data is loading
     */
    function showConnectionsLoading(isLoading) {
        /* v8 ignore next 3 */
        if (!elements.connectionsGrid) {
            return;
        }

        elements.connectionsGrid.style.opacity = isLoading ? "0.55" : "1";
        elements.connectionsGrid.style.pointerEvents = isLoading ? "none" : "auto";

        if (elements.connectionsStatsGrid) {
            elements.connectionsStatsGrid.style.opacity = isLoading ? "0.55" : "1";
        }

        if (isLoading) {
            LoadingOverlay.show("connections");
        } else {
            LoadingOverlay.hide("connections");
        }
    }

    /**
     * Show the empty state with a title and message.
     * @param {string} title - The heading text for the empty state
     * @param {string} message - The description text for the empty state
     */
    function setEmptyState(title, message) {
        const heading = elements.connectionsEmpty.querySelector("h2");
        const text = elements.connectionsEmpty.querySelector("p");

        /* v8 ignore next 5 */
        if (heading) {
            heading.textContent = title;
        }
        if (text) {
            text.textContent = message;
        }

        elements.connectionsEmpty.hidden = false;
        elements.connectionsGrid.hidden = true;
        elements.connectionsStatsGrid.hidden = true;
        showConnectionsLoading(false);
    }

    /** Hide the empty state and show the connections grid. */
    function hideEmptyState() {
        elements.connectionsEmpty.hidden = true;
        elements.connectionsGrid.hidden = false;
        elements.connectionsStatsGrid.hidden = false;
    }

    return {
        init,
        onRouteChange,
        onRouteLeave,
    };
})();
