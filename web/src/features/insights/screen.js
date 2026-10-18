/* Insights page logic */

import { mount } from "svelte";

import { AppRouter } from "../../app/router.js";
import { parseAnalyticsWorkerMessage } from "../../app/worker-contracts.ts";
import { captureError } from "../../platform/observability/sentry.js";
import { DataCache } from "../../platform/persistence/data-cache.js";
import { Session } from "../../platform/persistence/session.js";
import { Storage } from "../../platform/persistence/storage.js";
import { INSIGHTS_EXPORT_CACHE_KEY } from "../../shared/constants.js";
import { LoadingOverlay } from "../../shared/ui/loading-overlay.js";
import { createRangeFilter } from "../../shared/ui/time-range.js";
import { createWorkerHandle } from "../../shared/worker-handle.js";
import { formatReplyRate, formatSentRatio } from "../messages/format.js";

import InsightCards from "./InsightCards.svelte";

/** @typedef {import("../../app/router.js").RouteParams} RouteParams */
/** @typedef {import("../../platform/persistence/storage.js").StoredAnalytics} StoredAnalytics */
/** @typedef {import("../analytics/screen.js").AnalyticsFilters} AnalyticsFilters */
/** @typedef {import("../analytics/screen.js").AnalyticsScreenView} AnalyticsScreenView */

/**
 * One narrative card produced by the worker's insight generator.
 * @typedef {object} InsightCard
 * @property {string} id - Insight identifier, used to pick Pip's reaction
 * @property {string} title - Card heading
 * @property {string} body - Card text
 * @property {string} icon - Icon name
 * @property {string} accent - Accent class requested by the worker
 */

/**
 * Insight cards and closing tip for one view.
 * @typedef {object} InsightsResult
 * @property {InsightCard[]} insights - Insight cards
 * @property {string|null} tip - Closing tip, if any
 */

/**
 * The functions the mounted card component exposes.
 * @typedef {object} InsightCardsView
 * @property {() => void} showSkeleton - Show placeholder cards
 * @property {(cards: InsightCard[]) => void} showCards - Show the worker's cards
 */

/** @typedef {{multiplier: number}} NetworkGrowth - Lifetime network-growth correlation */

/**
 * The analytics view as the insights screen keeps it.
 * @typedef {AnalyticsScreenView & {networkGrowth?: NetworkGrowth|null}} InsightsView
 */

/**
 * A worker "view" payload as the insights screen reads it.
 * @typedef {{view?: InsightsView|null, insights?: InsightsResult|null}} InsightsViewPayload
 */

/**
 * Persisted outreach summary produced by the messages worker.
 * @typedef {object} OutreachSummary
 * @property {number} selfInitiated - Conversations the user started
 * @property {number|null} replyRate - Reply fraction in [0, 1], or null
 * @property {number} unansweredContacts - Contacts who never replied
 * @property {number|null} sentReceivedRatio - Sent/received ratio, or null
 */

/**
 * DOM references the insights screen works with.
 * @typedef {object} InsightsElements
 * @property {NodeListOf<HTMLElement>} timeRangeButtons - Time range buttons
 * @property {HTMLSelectElement|null} timeRangeSelect - Compact time range select
 * @property {HTMLElement|null} resetFiltersBtn - Reset filters button
 * @property {HTMLElement} insightsEmpty - Empty state
 * @property {HTMLElement} insightsGrid - Insight card grid
 * @property {HTMLElement} insightTip - Tip container
 * @property {HTMLElement} insightTipText - Tip text node
 * @property {HTMLElement|null} allTime - All-time section
 * @property {HTMLElement|null} networkGrowthCard - Network growth stat card
 * @property {HTMLElement|null} networkGrowthValue - Network growth value
 * @property {HTMLElement|null} outreachInitiatedCard - Self-initiated stat card
 * @property {HTMLElement|null} statInitiated - Self-initiated value
 * @property {HTMLElement|null} outreachReplyCard - Reply rate stat card
 * @property {HTMLElement|null} statReplyRate - Reply rate value
 * @property {HTMLElement|null} outreachUnansweredCard - Unanswered stat card
 * @property {HTMLElement|null} statUnanswered - Unanswered value
 * @property {HTMLElement|null} outreachRatioCard - Sent/received stat card
 * @property {HTMLElement|null} statSentRatio - Sent/received value
 */

export const InsightsPage = (() => {
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

    const RANGE_KEYS = Object.freeze(["1m", "3m", "6m", "12m", "all"]);
    /** @type {Set<unknown>} */
    const CACHE_EVENTS = new Set(["analyticsChanged", "storageCleared", "filesChanged"]);
    // Guard against a worker that constructs but never responds (chunk load
    // failure, silent hang): without this the loading overlay would stay up forever.
    const WORKER_TIMEOUT_MS = 30000;
    /** @type {{filters: AnalyticsFilters, analyticsReady: boolean, hasData: boolean, currentInsights: InsightsResult|null, currentView: InsightsView|null, currentViewRange: string|null, networkGrowth: NetworkGrowth|null, outreach: OutreachSummary|null, outreachLoaded: boolean}} */
    const state = {
        filters: { ...FILTER_DEFAULTS },
        analyticsReady: false,
        hasData: false,
        currentInsights: null,
        currentView: null,
        currentViewRange: null,
        // Lifetime values for the All-time section: networkGrowth rides on each
        // view (same value regardless of filters); outreach is loaded once from
        // storage since it is produced by the separate messages worker.
        networkGrowth: null,
        outreach: null,
        outreachLoaded: false,
    };

    // Assigned by init() before any handler that reads it can run.
    /** @type {InsightsElements} */
    let elements;
    const workers = createWorkerHandle({
        create: () =>
            new Worker(new URL("../analytics/analytics-worker.js", import.meta.url), {
                type: "module",
            }),
        onMessage: handleWorkerMessage,
        onError: handleWorkerError,
        onStartError: (error) => {
            captureError(error, {
                module: "insights-ui",
                operation: "init-worker",
            });
            setEmptyState("Worker blocked", "Open this page from a local server (not file://).");
        },
    });
    let requestId = 0;
    /** @type {import("../../app/worker-contracts.ts").RequestId} */
    let pendingViewId = 0;
    let initialized = false;
    let needsBaseReload = true;
    /** @type {import("../../shared/ui/time-range.js").RangeFilter|null} */
    let rangeFilter = null;
    // Mounted by init() before any handler that renders cards can run.
    /** @type {InsightCardsView} */
    let cardsView;

    /** Initialize insights page dependencies. */
    function init() {
        if (initialized) {
            return;
        }

        elements = resolveElements();
        /* v8 ignore next */
        if (!elements.insightsGrid || !elements.insightsEmpty) {
            return;
        }

        initialized = true;
        cardsView = /** @type {InsightCardsView} */ (
            /** @type {unknown} */ (mount(InsightCards, { target: elements.insightsGrid }))
        );
        bindEvents();
        workers.ensure();

        DataCache.subscribe(handleCacheChange);
    }

    /**
     * Handle route activation and query param changes.
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

        // Re-read the outreach summary on each route entry so stats saved after a
        // later Messages upload appear without a refresh. The latch keeps this to
        // one read per visit (filter changes re-enter here but find it loaded);
        // onRouteLeave clears the latch so the next entry reloads.
        loadOutreach();

        const filter = /** @type {import("../../shared/ui/time-range.js").RangeFilter} */ (
            rangeFilter
        );
        const range = filter.parse(params && params.range);
        state.filters = { ...FILTER_DEFAULTS, timeRange: range };
        filter.show(range);

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
        // Drop any in-flight worker watchdog so it cannot fire after navigation
        // and overwrite a now-hidden screen with a timeout message.
        workers.unwatch();
        // Allow the next entry to reload outreach (e.g. after the user uploads
        // Messages from another screen).
        state.outreachLoaded = false;
    }

    /**
     * Resolve insights DOM references.
     *
     * The static shell provides every node; init() bails out before binding
     * anything when the grid or the empty state is missing.
     * @returns {InsightsElements}
     */
    function resolveElements() {
        return {
            timeRangeButtons: /** @type {NodeListOf<HTMLElement>} */ (
                document.querySelectorAll("#insightsTimeRangeButtons .filter-btn")
            ),
            timeRangeSelect: /** @type {HTMLSelectElement|null} */ (
                document.getElementById("insightsTimeRangeSelect")
            ),
            resetFiltersBtn: document.getElementById("insightsResetFiltersBtn"),
            insightsEmpty: /** @type {HTMLElement} */ (document.getElementById("insightsEmpty")),
            insightsGrid: /** @type {HTMLElement} */ (document.getElementById("insightsGrid")),
            insightTip: /** @type {HTMLElement} */ (document.getElementById("insightTip")),
            insightTipText: /** @type {HTMLElement} */ (document.getElementById("insightTipText")),
            allTime: document.getElementById("insightsAllTime"),
            networkGrowthCard: document.getElementById("insightsNetworkGrowthCard"),
            networkGrowthValue: document.getElementById("insightsNetworkGrowthValue"),
            outreachInitiatedCard: document.getElementById("insightsOutreachInitiatedCard"),
            statInitiated: document.getElementById("insightsStatInitiated"),
            outreachReplyCard: document.getElementById("insightsOutreachReplyCard"),
            statReplyRate: document.getElementById("insightsStatReplyRate"),
            outreachUnansweredCard: document.getElementById("insightsOutreachUnansweredCard"),
            statUnanswered: document.getElementById("insightsStatUnanswered"),
            outreachRatioCard: document.getElementById("insightsOutreachRatioCard"),
            statSentRatio: document.getElementById("insightsStatSentRatio"),
        };
    }

    /** Attach event listeners for time range buttons and reset. */
    function bindEvents() {
        rangeFilter = createRangeFilter({
            ranges: RANGE_KEYS,
            fallback: FILTER_DEFAULTS.timeRange,
            buttons: elements.timeRangeButtons,
            select: elements.timeRangeSelect,
            resetButton: elements.resetFiltersBtn,
            route: { router: AppRouter, name: "insights" },
            onChange: (range) => {
                state.filters = { ...FILTER_DEFAULTS, timeRange: range };
                requestView();
            },
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
        state.currentInsights = null;
        state.currentView = null;
        state.currentViewRange = null;
    }

    /** Load the analytics base and send it to the worker. */
    async function loadBase() {
        showInsightsLoading(true);

        try {
            await Session.waitForCleanup();

            const worker = workers.ensure();
            /* v8 ignore next 5 */
            if (!worker) {
                setEmptyState(
                    "Insights not supported",
                    "Your browser does not support analytics workers.",
                );
                showInsightsLoading(false);
                return;
            }

            let analyticsBase =
                /** @type {StoredAnalytics|undefined} */ (DataCache.get("storage:analyticsBase")) ||
                null;

            if (!analyticsBase) {
                analyticsBase = await Storage.getAnalytics();
                DataCache.set("storage:analyticsBase", analyticsBase);
            }
            // The worker may have been replaced or stopped while storage was
            // read; a newer load owns it now, so this one steps aside.
            if (workers.current() !== worker) {
                return;
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
            workers.watch(WORKER_TIMEOUT_MS, () => {
                setEmptyState(
                    "Insights timeout",
                    "Insights worker did not respond in time. Try refreshing the page.",
                );
                workers.terminate();
                showInsightsLoading(false);
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
            /* v8 ignore next */
            captureError(new Error(parsed.error || "Invalid analytics worker payload."), {
                module: "insights-ui",
                operation: "worker-message-parse",
            });
            return;
        }

        const message = parsed.value;
        // The worker responded, so the loadBase watchdog is no longer needed.
        workers.unwatch();

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
                /* v8 ignore next */
                applyWorkerInsightsPayload(
                    /** @type {InsightsViewPayload} */ (message.payload || {}),
                );
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
     * @param {InsightsViewPayload} payload - Worker payload
     */
    function applyWorkerInsightsPayload(payload) {
        state.currentInsights = payload.insights || null;
        // Keep the complete view. The PDF export uses the timeline, topics, and
        // heatmap, and should not request data the screen already received.
        state.currentView = payload.view || null;
        // Recorded with the view, not read off the filters later: the filter is
        // updated the moment the user picks a range, while the view only arrives
        // when the worker answers. Publishing one against the other let a chart
        // of the last twelve months go out captioned "All time".
        state.currentViewRange = state.filters.timeRange;
        // networkGrowth is a lifetime value carried identically on every view.
        state.networkGrowth = (payload.view && payload.view.networkGrowth) || null;
        if (state.currentInsights) {
            renderInsights(state.currentInsights);
        }
        renderAllTime();
        showInsightsLoading(false);
    }

    /**
     * Render the All-time section from the lifetime networkGrowth (carried on
     * the view) and the persisted outreach summary. Each card hides when its
     * data is absent, and the whole section hides when neither is available.
     */
    function renderAllTime() {
        /* v8 ignore next 3 */
        if (!elements.allTime) {
            return;
        }
        const growth = state.networkGrowth;
        const outreach = state.outreach;

        toggleStatCard(
            elements.networkGrowthCard,
            elements.networkGrowthValue,
            growth ? `${growth.multiplier}×` : null,
        );
        toggleStatCard(
            elements.outreachInitiatedCard,
            elements.statInitiated,
            outreach ? String(outreach.selfInitiated) : null,
        );
        toggleStatCard(
            elements.outreachReplyCard,
            elements.statReplyRate,
            outreach ? formatReplyRate(outreach.replyRate) : null,
        );
        toggleStatCard(
            elements.outreachUnansweredCard,
            elements.statUnanswered,
            outreach ? String(outreach.unansweredContacts) : null,
        );
        toggleStatCard(
            elements.outreachRatioCard,
            elements.statSentRatio,
            outreach ? formatSentRatio(outreach.sentReceivedRatio) : null,
        );

        elements.allTime.hidden = !growth && !outreach;
        publishExportSnapshot();
    }

    /**
     * Publish what is currently on screen for the PDF export.
     *
     * The export button is global and cannot assume this screen has run, so it
     * has its own cold data path. Publishing here is the fast path: exporting
     * from the Insights screen then matches exactly what the user is looking at,
     * including the active time range.
     */
    function publishExportSnapshot() {
        DataCache.set(INSIGHTS_EXPORT_CACHE_KEY, {
            timeRange: state.filters.timeRange,
            insights: state.currentInsights ? state.currentInsights.insights || [] : [],
            tip: state.currentInsights ? state.currentInsights.tip || null : null,
            // Withhold a view whose range differs from the snapshot range. An outreach
            // read can publish while a new worker view is pending, including after
            // route reentry or a failed read. The export then recomputes the view.
            view: state.currentViewRange === state.filters.timeRange ? state.currentView : null,
            networkGrowth: state.networkGrowth,
            outreach: state.outreach,
        });
    }

    /**
     * Show a stat card with the given value, or hide it when value is null.
     * @param {HTMLElement|null} card - Stat card container
     * @param {HTMLElement|null} valueEl - Value node within the card
     * @param {string|null} value - Display value, or null to hide the card
     */
    function toggleStatCard(card, valueEl, value) {
        /* v8 ignore next 3 */
        if (!card || !valueEl) {
            return;
        }
        if (value === null) {
            card.hidden = true;
            return;
        }
        valueEl.textContent = value;
        card.hidden = false;
    }

    /**
     * Load the persisted outreach summary once. It is produced by the messages
     * worker (a different page), so the Insights page reads the small stored
     * summary rather than re-parsing the message export. Best-effort.
     * @returns {Promise<void>}
     */
    async function loadOutreach() {
        if (state.outreachLoaded) {
            return;
        }
        // Latch before the await so concurrent entries don't double-read; a load
        // failure clears it again so a later entry can retry.
        state.outreachLoaded = true;
        try {
            state.outreach = /** @type {typeof state.outreach} */ (await Storage.getOutreach());
        } catch (error) {
            state.outreachLoaded = false;
            captureError(error, { module: "insights-ui", operation: "load-outreach" });
            return;
        }
        renderAllTime();
    }

    /**
     * Resolve a worker message text with fallback.
     * @param {{message?: string}|null|undefined} payload - Worker payload
     * @param {string} fallback - Fallback message
     * @returns {string}
     */
    function getWorkerMessage(payload, fallback) {
        // Parser-normalized payloads normally carry a message. Use the fallback for malformed data.
        /* v8 ignore next */
        return payload && payload.message ? payload.message : fallback;
    }

    /**
     * Handle worker-level errors.
     * @param {ErrorEvent|MessageEvent} event - Worker error or messageerror event
     */
    function handleWorkerError(event) {
        captureError(
            event && "error" in event && event.error
                ? event.error
                : // Dispatched events have a type. Keep an "error" fallback for malformed events.
                  /* v8 ignore next */
                  new Error(`Insights worker ${event && event.type ? event.type : "error"} event`),
            {
                module: "insights-ui",
                operation: "worker-error-event",
            },
        );
        // Tear down the broken worker (clears the watchdog and nulls the
        // reference) so a later loadBase recreates a fresh worker rather than
        // posting to a dead one, and the stale watchdog cannot fire afterward.
        workers.terminate();
        setEmptyState("Insights worker error", "Refresh the page and try again.");
        showInsightsLoading(false);
    }

    /** Send a view request to the worker with current filters. */
    function requestView() {
        const worker = workers.current();
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
     * @param {InsightsResult} payload - The insights payload from the worker.
     */
    function renderInsights(payload) {
        const insights = payload.insights || [];
        const tip = payload.tip || null;

        cardsView.showCards(insights);

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
        // The static shell includes both nodes. Keep the guards for incomplete DOM setup.
        /* v8 ignore next */
        if (heading) {
            heading.textContent = title;
        }
        /* v8 ignore next */
        if (text) {
            text.textContent = message;
        }
        elements.insightsEmpty.hidden = false;
        elements.insightsGrid.hidden = true;
        elements.insightTip.hidden = true;
        // The All-time section is governed solely by renderAllTime (driven by
        // data presence), so it can still show lifetime outreach even when
        // there are no shares/comments for the filtered cards.
    }

    /** Hide empty state and show insights grid. */
    function hideEmptyState() {
        elements.insightsEmpty.hidden = true;
        elements.insightsGrid.hidden = false;
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

        cardsView.showSkeleton();
    }

    return {
        init,
        onRouteChange,
        onRouteLeave,
    };
})();
