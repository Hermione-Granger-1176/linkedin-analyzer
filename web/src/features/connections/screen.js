/* Connections page logic */

import { AppRouter } from "../../app/router.js";
import {
    parseConnectionsWorkerMessage,
    parseStoredUploadFile,
    toStoredFileMetadata,
} from "../../app/worker-contracts.js";
import { markPerformance, measurePerformance } from "../../platform/observability/perf.js";
import { captureError } from "../../platform/observability/sentry.js";
import { DataCache } from "../../platform/persistence/data-cache.js";
import { Session } from "../../platform/persistence/session.js";
import { Storage } from "../../platform/persistence/storage.js";
import { hideChartTooltip, showChartTooltip } from "../../shared/ui/chart-tooltip.js";
import { SketchCharts } from "../../shared/ui/charts.js";
import { LoadingOverlay } from "../../shared/ui/loading-overlay.js";
import { createRangeFilter } from "../../shared/ui/time-range.js";

import { RANGE_KEYS, buildConnectionsView, normalizeConnectionRows } from "./view.js";

/** @typedef {import("../../app/router.js").RouteParams} RouteParams */
/** @typedef {import("../../app/worker-contracts.js").ConnectionsWorkerMessage} WorkerMessage */
/** @typedef {Extract<WorkerMessage, {type: "processed"}>} ProcessedMessage */
/** @typedef {Extract<WorkerMessage, {type: "error"}>} ErrorMessage */
/** @typedef {import("../../app/worker-contracts.js").StoredUploadFile} StoredUploadFile */
/** @typedef {import("../../platform/persistence/storage.js").StoredFile} StoredFile */
/** @typedef {import("./view.js").CleanedConnectionRow} CleanedConnectionRow */
/** @typedef {import("./view.js").ConnectionRow} ConnectionRow */
/** @typedef {import("./view.js").ConnectionsAnalytics} ConnectionsAnalytics */
/** @typedef {import("./view.js").ConnectionsView} ConnectionsView */
/** @typedef {import("./view.js").GrowthPoint} GrowthPoint */
/** @typedef {import("./view.js").ViewStats} ViewStats */

/**
 * DOM elements the connections screen reads and updates.
 * @typedef {object} ConnectionsElements
 * @property {NodeListOf<HTMLElement>} timeRangeButtons - Time range filter buttons
 * @property {HTMLSelectElement|null} timeRangeSelect - Compact time range select
 * @property {HTMLElement|null} resetFiltersBtn - Reset filters button
 * @property {HTMLElement} connectionsEmpty - Empty state container
 * @property {HTMLElement} connectionsGrid - Chart grid
 * @property {HTMLElement} connectionsStatsGrid - Stats bar
 * @property {HTMLElement} connStatTotal - Total connections stat
 * @property {HTMLElement} connStatRecent - Recent connections stat
 * @property {HTMLElement} connStatTopCompany - Top company stat
 * @property {HTMLElement} connStatNetworkAge - Network age stat
 * @property {HTMLCanvasElement} connectionGrowthChart - Growth timeline canvas
 * @property {HTMLCanvasElement} connectionCompaniesChart - Companies chart canvas
 * @property {HTMLCanvasElement} connectionPositionsChart - Positions chart canvas
 * @property {HTMLElement|null} chartTooltip - Shared chart tooltip
 */

export const ConnectionsPage = (() => {
    "use strict";

    /** @type {{ timeRange: string }} */
    const FILTER_DEFAULTS = Object.freeze({
        timeRange: "12m",
    });

    /** @type {Set<string|undefined>} */
    const CACHE_EVENTS = new Set(["filesChanged", "storageCleared"]);
    const WORKER_TIMEOUT_MS = 30000;

    /**
     * @type {{filters: {timeRange: string}, dataReady: boolean, hasData: boolean,
     * allRows: ConnectionRow[]|null, allTimeline: GrowthPoint[]|null,
     * workerStats: {total?: number, networkAgeMonths?: number}|null,
     * currentView: ConnectionsView|null}}
     */
    const state = {
        filters: { ...FILTER_DEFAULTS },
        dataReady: false,
        hasData: false,
        allRows: null,
        allTimeline: null,
        workerStats: null,
        currentView: null,
    };

    // Assigned by init() before any handler that reads it can run.
    /** @type {ConnectionsElements} */
    let elements;
    /** @type {HTMLCanvasElement[]} */
    let chartCanvases = [];
    let initialized = false;
    /** @type {import("../../shared/ui/time-range.js").RangeFilter|null} */
    let rangeFilter = null;

    /** @type {Worker|null} */
    let worker = null;
    let requestId = 0;
    let pendingRequestId = 0;
    /** @type {number|null} */
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

        const filter = /** @type {import("../../shared/ui/time-range.js").RangeFilter} */ (
            rangeFilter
        );
        const nextRange = filter.parse(params && params.range);
        const changed = nextRange !== state.filters.timeRange;
        state.filters.timeRange = nextRange;
        filter.show(nextRange);

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
     * @returns {ConnectionsElements}
     */
    function resolveElements() {
        // The connections screen shell provides these nodes; init() checks the grid.
        return /** @type {ConnectionsElements} */ ({
            timeRangeButtons: document.querySelectorAll("#connectionsTimeRangeButtons .filter-btn"),
            timeRangeSelect: document.getElementById("connectionsTimeRangeSelect"),
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
        });
    }

    /** Attach event listeners for filters and chart interactions. */
    function bindEvents() {
        rangeFilter = createRangeFilter({
            ranges: RANGE_KEYS,
            fallback: FILTER_DEFAULTS.timeRange,
            buttons: elements.timeRangeButtons,
            select: elements.timeRangeSelect,
            resetButton: elements.resetFiltersBtn,
            route: { router: AppRouter, name: "connections" },
            onChange: (range) => {
                state.filters = { ...FILTER_DEFAULTS, timeRange: range };
                applyFiltersAndRender();
            },
        });

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
            worker.addEventListener("messageerror", handleWorkerError);
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
     * @param {{type?: string, fileType?: string}} event - Notification payload
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
            if (!file || !file.blob) {
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
                // A response clears this timeout. Keep the check for a stale callback.
                /* v8 ignore next 3 */
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
                payload: { connectionsCsv: file.blob },
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
     * @returns {Promise<StoredUploadFile|null>} The stored file record or null
     */
    async function loadConnectionsFile() {
        const cacheKey = "storage:file:connections";

        // The cache holds metadata only, so always load the record (with its
        // Blob) from storage when parsing. The worker reads the Blob, so the
        // page never holds the file text.
        const file = normalizeConnectionsFile(await Storage.getFile("connections"), "storage");
        if (file && !file.blob) {
            // Metadata exists but the file record is gone (cleared in another
            // tab / degraded persistence). Treat it as a load failure so the
            // catch shows the storage-error UI, matching clean/messages, rather
            // than the "not uploaded" empty state.
            throw new Error("Stored connections file record is missing.");
        }
        if (file) {
            DataCache.set(cacheKey, toStoredFileMetadata(file));
        }
        return file;
    }

    /**
     * Validate one stored connections file record.
     * @param {StoredFile|null} file - Raw storage payload
     * @param {'cache'|'storage'} source - Data source identifier
     * @returns {StoredUploadFile|null}
     */
    function normalizeConnectionsFile(file, source) {
        if (!file) {
            return null;
        }

        const parsed = parseStoredUploadFile(file);
        if (parsed.valid && parsed.value.type === "connections") {
            return parsed.value;
        }

        if (typeof Blob !== "undefined" && file.blob instanceof Blob) {
            return {
                type: "connections",
                name: typeof file.name === "string" ? file.name : "Connections.csv",
                blob: file.blob,
                rowCount: Number.isFinite(file.rowCount) ? file.rowCount : 0,
                updatedAt: Number.isFinite(file.updatedAt) ? file.updatedAt : Date.now(),
            };
        }

        captureError(
            new Error(
                // A valid parse carries text and invalid() returns an error. Keep this
                // branch for malformed parsed data.
                /* v8 ignore next 3 */
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
            // invalid() returns an error string. Keep the fallback for malformed worker data.
            /* v8 ignore next */
            captureError(new Error(parsed.error || "Invalid connections worker message."), {
                module: "connections-ui",
                operation: "worker-message-parse",
            });
            return;
        }

        const message = parsed.value;
        if (message.type === "processed") {
            handleParsedPayload(message);
            return;
        }
        handleWorkerErrorPayload(message);
    }

    /**
     * Process the parsed connections data from the worker.
     * @param {ProcessedMessage} message - Worker message with parsed payload
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

        // The contract parser returns an object. Keep the fallback for malformed worker data.
        /* v8 ignore next */
        const payload = message.payload || {};

        if (!payload.success) {
            setEmptyState("Connections error", payload.error || "Unable to parse Connections.csv.");
            showConnectionsLoading(false);
            return;
        }

        // The worker posts the analytics and rows processConnections() built.
        const analytics = /** @type {Partial<ConnectionsAnalytics>} */ (payload.analytics || {});
        // The parser returns an array. Keep the fallback for malformed worker data.
        /* v8 ignore next */
        const rawRows = /** @type {CleanedConnectionRow[]} */ (payload.rows || []);

        markPerformance("connections:normalize:start");
        const rows = normalizeConnectionRows(rawRows);
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
     * @param {ErrorMessage} message - Worker error message
     */
    function handleWorkerErrorPayload(message) {
        clearWorkerTimeout();
        // The contract parser returns a message. Keep the fallback for malformed worker data.
        /* v8 ignore next 4 */
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
     * @param {ErrorEvent|MessageEvent} event - Worker error or messageerror event
     */
    function handleWorkerError(event) {
        clearWorkerTimeout();
        captureError(
            event && "error" in event && event.error
                ? event.error
                : // Dispatched events have a type. Keep an "error" fallback for malformed events.
                  /* v8 ignore next */
                  new Error(
                      `Connections worker ${event && event.type ? event.type : "error"} event`,
                  ),
            {
                module: "connections-ui",
                operation: "worker-error-event",
            },
        );
        terminateWorker();
        setEmptyState("Worker error", "Refresh the page and try again.");
        showConnectionsLoading(false);
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

        const view = buildConnectionsView(
            state.allRows,
            state.allTimeline,
            state.workerStats,
            state.filters.timeRange,
        );

        state.currentView = view;
        renderView(view);
    }

    /**
     * Render the full connections view: stats, charts, and loading state.
     * @param {ConnectionsView} view - The computed view data
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
     * @param {ViewStats} stats - Stats bar values
     */
    function updateStats(stats) {
        elements.connStatTotal.textContent = stats.total.toLocaleString();
        elements.connStatRecent.textContent = stats.recent.toLocaleString();
        elements.connStatTopCompany.textContent = stats.topCompany;
        elements.connStatNetworkAge.textContent = stats.networkAge;
    }

    /**
     * Draw the growth timeline and company/position bar charts.
     * @param {ConnectionsView} view - The computed view data
     */
    function renderCharts(view) {
        SketchCharts.drawTimeline(
            elements.connectionGrowthChart,
            view.timeline,
            "all",
            1,
            0,
            "No connection growth yet.",
        );

        SketchCharts.drawTopics(
            elements.connectionCompaniesChart,
            view.companies,
            1,
            "No companies in this range.",
        );
        SketchCharts.drawTopics(
            elements.connectionPositionsChart,
            view.positions,
            1,
            "No positions in this range.",
        );
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

        /* v8 ignore next */
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

        // The static shell includes both nodes. Keep the guards for incomplete DOM setup.
        /* v8 ignore next */
        if (heading) {
            heading.textContent = title;
        }
        /* v8 ignore next */
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
