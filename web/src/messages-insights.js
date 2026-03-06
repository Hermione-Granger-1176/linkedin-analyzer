/* Messages insights page logic */

import { LinkedInCleaner } from "./cleaner.js";
import { DataCache } from "./data-cache.js";
import { ExcelGenerator } from "./excel.js";
import { LoadingOverlay } from "./loading-overlay.js";
import { MessagesAnalytics } from "./messages-analytics.js";
import { AppRouter } from "./router.js";
import { captureError } from "./sentry.js";
import { Session } from "./session.js";
import { Storage } from "./storage.js";
import { reportPerformanceMeasure } from "./telemetry.js";
import { parseMessagesWorkerMessage, parseStoredUploadFile } from "./worker-contracts.js";

export const MessagesPage = (() => {
    "use strict";

    /** @type {{ timeRange: string }} */
    const FILTER_DEFAULTS = Object.freeze({
        timeRange: "12m",
    });
    const RANGE_MONTHS = Object.freeze({
        "1m": 1,
        "3m": 3,
        "6m": 6,
        "12m": 12,
    });
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const WORKER_TIMEOUT_MS = 30000;

    const SHORT_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "2-digit",
        year: "numeric",
    });

    const elements = {
        timeRangeButtons: document.querySelectorAll("#messagesTimeRangeButtons .filter-btn"),
        resetFiltersBtn: document.getElementById("messagesResetFiltersBtn"),
        topContactsExportBtn: /** @type {HTMLButtonElement|null} */ (
            document.getElementById("topContactsExportBtn")
        ),
        silentConnectionsExportBtn: /** @type {HTMLButtonElement|null} */ (
            document.getElementById("silentConnectionsExportBtn")
        ),
        fadingConversationsExportBtn: /** @type {HTMLButtonElement|null} */ (
            document.getElementById("fadingConversationsExportBtn")
        ),
        messagesEmpty: document.getElementById("messagesEmpty"),
        messagesLayout: document.getElementById("messagesLayout"),
        topContactsList: document.getElementById("topContactsList"),
        silentConnectionsList: document.getElementById("silentConnectionsList"),
        fadingConversationsList: document.getElementById("fadingConversationsList"),
        msgStatMessages: document.getElementById("msgStatMessages"),
        msgStatContacts: document.getElementById("msgStatContacts"),
        msgStatConnected: document.getElementById("msgStatConnected"),
        msgStatFading: document.getElementById("msgStatFading"),
        messagesTip: document.getElementById("messagesTip"),
        messagesTipText: document.getElementById("messagesTipText"),
    };

    const state = {
        filters: { ...FILTER_DEFAULTS },
        messageState: null,
        connectionState: null,
        hasConnectionsFile: false,
        connectionLoadError: null,
        loadedSignature: null,
        totalInputRows: 0,
        currentLists: {
            topContacts: [],
            silentConnections: [],
            fadingConversations: [],
        },
    };

    let initialized = false;
    let isApplyingRouteParams = false;
    let parseWorker = null;
    let parseWorkerRequestId = 0;
    let parseWorkerTimeoutId = null;

    /** Initialize messages page. */
    function init() {
        if (initialized) {
            return;
        }
        if (!elements.messagesLayout || !elements.messagesEmpty) {
            return;
        }
        initialized = true;
        initWorker();
        bindEvents();
    }

    /**
     * Handle route activation and query param changes.
     * @param {object} params - Route query params
     */
    function onRouteChange(params) {
        if (!initialized) {
            init();
        }
        if (!initialized) {
            return;
        }

        const nextRange = parseRangeParam(params && params.range);
        applyRangeFromRoute(nextRange);
        loadData();
    }

    /** Cleanup when leaving messages route. */
    function onRouteLeave() {
        showMessagesLoading(false);
    }

    /** Attach event listeners for filters. */
    function bindEvents() {
        elements.timeRangeButtons.forEach((btn) => {
            const button = /** @type {HTMLElement} */ (btn);
            button.addEventListener("click", () => handleTimeRangeChange(button));
            button.setAttribute(
                "aria-pressed",
                button.classList.contains("active") ? "true" : "false",
            );
        });
        elements.resetFiltersBtn.addEventListener("click", resetFilters);
        if (elements.topContactsExportBtn) {
            elements.topContactsExportBtn.addEventListener("click", exportTopContacts);
        }
        if (elements.silentConnectionsExportBtn) {
            elements.silentConnectionsExportBtn.addEventListener("click", exportSilentConnections);
        }
        if (elements.fadingConversationsExportBtn) {
            elements.fadingConversationsExportBtn.addEventListener(
                "click",
                exportFadingConversations,
            );
        }

        window.addEventListener("beforeunload", terminateWorker);
        window.addEventListener("pagehide", terminateWorker);

        updateExportButtonStates();
    }

    /** Initialize background worker for messages/connections parsing. */
    function initWorker() {
        if (parseWorker || typeof Worker === "undefined") {
            return;
        }

        try {
            parseWorker = new Worker(new URL("./messages-worker.js", import.meta.url), {
                type: "module",
            });
        } catch (error) {
            parseWorker = null;
            captureError(error, {
                module: "messages-insights",
                operation: "init-worker",
            });
        }
    }

    /** Terminate messages parsing worker. */
    function terminateWorker() {
        if (!parseWorker) {
            return;
        }
        parseWorker.terminate();
        parseWorker = null;
        clearWorkerTimeout();
    }

    /** Clear any in-flight worker watchdog timeout. */
    function clearWorkerTimeout() {
        if (!parseWorkerTimeoutId) {
            return;
        }
        window.clearTimeout(parseWorkerTimeoutId);
        parseWorkerTimeoutId = null;
    }

    /**
     * Parse messages/connections in a worker when available.
     * Falls back to main-thread parsing if worker is unavailable or fails.
     * @param {string} messagesCsv - Raw messages CSV text
     * @param {string} connectionsCsv - Raw connections CSV text
     * @returns {Promise<object>}
     */
    async function processFiles(messagesCsv, connectionsCsv) {
        if (!parseWorker) {
            initWorker();
        }
        const workerResult = await processFilesInWorker(messagesCsv, connectionsCsv);
        if (workerResult) {
            return workerResult;
        }
        return processFilesOnMainThread(messagesCsv, connectionsCsv);
    }

    /**
     * Parse files using a dedicated Web Worker.
     * @param {string} messagesCsv - Raw messages CSV text
     * @param {string} connectionsCsv - Raw connections CSV text
     * @returns {Promise<object|null>} Parsed payload or null on worker failure
     */
    function processFilesInWorker(messagesCsv, connectionsCsv) {
        if (!parseWorker) {
            return Promise.resolve(null);
        }

        const requestId = ++parseWorkerRequestId;

        return new Promise((resolve) => {
            clearWorkerTimeout();
            const handleMessage = (event) => {
                const parsed = parseMessagesWorkerMessage(event.data || {});
                if (!parsed.valid) {
                    captureError(new Error(parsed.error || "Invalid messages worker response."), {
                        module: "messages-insights",
                        operation: "worker-message-parse",
                        requestId,
                    });
                    return;
                }

                const message = parsed.value;
                if (message.type !== "processed" || message.requestId !== requestId) {
                    return;
                }
                finishRequest();
                resolve(message.payload || null);
            };

            const handleError = (event) => {
                captureError(
                    event && event.error ? event.error : new Error("Messages worker error event"),
                    {
                        module: "messages-insights",
                        operation: "worker-error-event",
                        requestId,
                    },
                );
                finishRequest();
                terminateWorker();
                resolve(null);
            };

            const removeWorkerListeners = () => {
                if (!parseWorker) {
                    return;
                }
                parseWorker.removeEventListener("message", handleMessage);
                parseWorker.removeEventListener("error", handleError);
            };

            const finishRequest = () => {
                removeWorkerListeners();
                clearWorkerTimeout();
            };

            parseWorkerTimeoutId = window.setTimeout(() => {
                captureError(new Error("Messages worker request timed out."), {
                    module: "messages-insights",
                    operation: "worker-timeout",
                    requestId,
                });
                finishRequest();
                terminateWorker();
                resolve(null);
            }, WORKER_TIMEOUT_MS);

            try {
                parseWorker.addEventListener("message", handleMessage);
                parseWorker.addEventListener("error", handleError);
                parseWorker.postMessage({
                    type: "process",
                    requestId,
                    payload: {
                        messagesCsv,
                        connectionsCsv,
                    },
                });
            } catch (error) {
                captureError(error, {
                    module: "messages-insights",
                    operation: "worker-post-message",
                    requestId,
                });
                finishRequest();
                terminateWorker();
                resolve(null);
            }
        });
    }

    /**
     * Parse files directly on main thread as fallback.
     * @param {string} messagesCsv - Raw messages CSV text
     * @param {string} connectionsCsv - Raw connections CSV text
     * @returns {object}
     */
    function processFilesOnMainThread(messagesCsv, connectionsCsv) {
        const messagesResult = LinkedInCleaner.process(messagesCsv, "messages");
        if (!messagesResult.success) {
            return {
                success: false,
                error: messagesResult.error || "Unable to parse messages.csv.",
            };
        }

        let connectionsData = [];
        let connectionError = null;

        if (connectionsCsv) {
            const connectionsResult = LinkedInCleaner.process(connectionsCsv, "connections");
            if (connectionsResult.success) {
                connectionsData = connectionsResult.cleanedData;
            } else {
                connectionError = connectionsResult.error || "Unable to parse Connections.csv.";
            }
        }

        const messagesData = messagesResult.cleanedData;
        return {
            success: true,
            messagesData,
            connectionsData,
            connectionError,
            totalInputRows: messagesData.length,
        };
    }

    /** Load messages and connections files from IndexedDB. */
    async function loadData() {
        showMessagesLoading(true);
        markPerformance("messages:idb-read:start");

        try {
            await Session.waitForCleanup();

            let files = null;
            let messagesFile = null;
            let connectionsFile = null;

            messagesFile = DataCache.get("storage:file:messages") || null;
            connectionsFile = DataCache.get("storage:file:connections") || null;
            files = DataCache.get("storage:files") || null;

            messagesFile = normalizeStoredFile(messagesFile, "messages");
            connectionsFile = normalizeStoredFile(connectionsFile, "connections");

            if (!messagesFile || !connectionsFile) {
                if (!files) {
                    files = await Storage.getAllFiles();
                    DataCache.set("storage:files", files);
                }
                if (!messagesFile) {
                    messagesFile = normalizeStoredFile(
                        files.find((file) => file.type === "messages") || null,
                        "messages",
                    );
                    if (messagesFile) {
                        DataCache.set("storage:file:messages", messagesFile);
                    }
                }
                if (!connectionsFile) {
                    connectionsFile = normalizeStoredFile(
                        files.find((file) => file.type === "connections") || null,
                        "connections",
                    );
                    if (connectionsFile) {
                        DataCache.set("storage:file:connections", connectionsFile);
                    }
                }
            }

            markPerformance("messages:idb-read:end");
            measurePerformance(
                "messages:idb-read",
                "messages:idb-read:start",
                "messages:idb-read:end",
            );
            state.hasConnectionsFile = Boolean(connectionsFile);

            const signature = buildDataSignature(messagesFile, connectionsFile);
            if (signature === state.loadedSignature && state.messageState) {
                markPerformance("messages:render:start");
                renderView();
                markPerformance("messages:render:end");
                measurePerformance(
                    "messages:render",
                    "messages:render:start",
                    "messages:render:end",
                );
                showMessagesLoading(false);
                return;
            }

            if (!messagesFile) {
                state.loadedSignature = signature;
                setEmptyState(
                    "No messages data available yet",
                    "Upload messages.csv on the Home page to unlock messaging insights.",
                );
                showMessagesLoading(false);
                return;
            }

            const cachedState = getCachedState(signature);
            if (cachedState) {
                state.messageState = cachedState.messageState;
                state.connectionState = cachedState.connectionState;
                state.connectionLoadError = cachedState.connectionLoadError;
                state.hasConnectionsFile = cachedState.hasConnectionsFile;
                state.loadedSignature = signature;
                markPerformance("messages:render:start");
                renderView();
                markPerformance("messages:render:end");
                measurePerformance(
                    "messages:render",
                    "messages:render:start",
                    "messages:render:end",
                );
                showMessagesLoading(false);
                return;
            }

            await nextFrame();

            markPerformance("messages:worker-parse:start");
            const processed = await processFiles(
                messagesFile.text,
                connectionsFile ? connectionsFile.text : "",
            );
            markPerformance("messages:worker-parse:end");
            measurePerformance(
                "messages:worker-parse",
                "messages:worker-parse:start",
                "messages:worker-parse:end",
            );

            if (!processed.success) {
                state.loadedSignature = signature;
                setEmptyState(
                    "Messages parsing error",
                    processed.error ||
                        "Unable to parse messages.csv. Re-upload the file and try again.",
                );
                showMessagesLoading(false);
                return;
            }

            const messagesData = processed.messagesData || [];
            state.totalInputRows = Number.isFinite(processed.totalInputRows)
                ? processed.totalInputRows
                : messagesData.length;
            if (processed.messageState) {
                state.messageState = hydrateMessageState(processed.messageState);
            } else {
                state.messageState = buildMessageState(messagesData);
            }
            if (!state.messageState.events.length) {
                state.loadedSignature = signature;
                setEmptyState(
                    "No usable message rows",
                    "The file loaded, but no valid message rows were found for analysis.",
                );
                showMessagesLoading(false);
                return;
            }

            if (processed.connectionState) {
                state.connectionState = hydrateConnectionState(processed.connectionState);
            } else {
                state.connectionState = buildConnectionState(processed.connectionsData || []);
            }
            state.connectionLoadError = processed.connectionError || null;

            state.loadedSignature = signature;
            cacheComputedState(signature);
            markPerformance("messages:render:start");
            renderView();
            markPerformance("messages:render:end");
            measurePerformance("messages:render", "messages:render:start", "messages:render:end");
            showMessagesLoading(false);
        } catch (error) {
            captureError(error, {
                module: "messages-insights",
                operation: "load-data",
            });
            setEmptyState(
                "Storage error",
                "Unable to load saved files. Try clearing browser data and re-uploading.",
            );
            showMessagesLoading(false);
        }
    }

    /**
     * Validate and normalize one stored upload file payload.
     * @param {object|null} file - Raw stored file record
     * @param {'messages'|'connections'} expectedType - Expected file type
     * @returns {object|null}
     */
    function normalizeStoredFile(file, expectedType) {
        if (!file) {
            return null;
        }

        const parsed = parseStoredUploadFile(file);
        if (!parsed.valid) {
            captureError(new Error(parsed.error || "Invalid stored file payload."), {
                module: "messages-insights",
                operation: "parse-stored-file",
                expectedType,
            });
            return null;
        }

        if (parsed.value.type !== expectedType) {
            return null;
        }

        return parsed.value;
    }

    /**
     * Build a cache signature from uploaded file metadata.
     * @param {object|null} messagesFile - Stored messages file
     * @param {object|null} connectionsFile - Stored connections file
     * @returns {string}
     */
    function buildDataSignature(messagesFile, connectionsFile) {
        const toPart = (file, type) => {
            if (!file) {
                return `${type}:none`;
            }
            const updatedAt = file.updatedAt || 0;
            const rowCount = file.rowCount || 0;
            const name = file.name || "unknown";
            return `${type}:${name}:${updatedAt}:${rowCount}`;
        };

        return [toPart(messagesFile, "messages"), toPart(connectionsFile, "connections")].join("|");
    }

    /**
     * Read computed analytics state from in-memory cache.
     * @param {string} signature - Dataset signature
     * @returns {object|null}
     */
    function getCachedState(signature) {
        return DataCache.get(`messages:state:${signature}`) || null;
    }

    /**
     * Persist computed analytics state in in-memory cache.
     * @param {string} signature - Dataset signature
     */
    function cacheComputedState(signature) {
        DataCache.set(`messages:state:${signature}`, {
            messageState: state.messageState,
            connectionState: state.connectionState,
            hasConnectionsFile: state.hasConnectionsFile,
            connectionLoadError: state.connectionLoadError,
        });
    }

    /**
     * Yield one frame so loading overlay can paint before heavy parsing.
     * @returns {Promise<void>}
     */
    function nextFrame() {
        return new Promise((resolve) => {
            requestAnimationFrame(() => resolve());
        });
    }

    /**
     * Mark a performance point if available.
     * @param {string} name - Mark name
     */
    function markPerformance(name) {
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
                        module: "messages-insights",
                    });
                }
            }
        } catch {
            // Ignore missing marks to keep instrumentation resilient.
        }
    }

    /**
     * Build message analytics state from cleaned rows.
     * @param {object[]} rows - Cleaned message rows
     * @returns {object}
     */
    function buildMessageState(rows) {
        markPerformance("messages:build-state:start");
        const result = MessagesAnalytics.buildMessageState(rows);
        markPerformance("messages:build-state:end");
        measurePerformance(
            "messages:build-state",
            "messages:build-state:start",
            "messages:build-state:end",
        );
        return result;
    }

    /**
     * Build connections lookup state from cleaned rows.
     * @param {object[]} rows - Cleaned connections rows
     * @returns {{list: object[], byUrl: Map<string, object>, byName: Map<string, object>}}
     */
    function buildConnectionState(rows) {
        markPerformance("messages:build-connections:start");
        const result = MessagesAnalytics.buildConnectionState(rows);
        markPerformance("messages:build-connections:end");
        measurePerformance(
            "messages:build-connections",
            "messages:build-connections:start",
            "messages:build-connections:end",
        );
        return result;
    }

    /**
     * Rehydrate message state from worker payload.
     * @param {object|null} payload - Worker payload
     * @returns {object}
     */
    function hydrateMessageState(payload) {
        const safePayload = payload || {};
        const contacts = new Map();
        const contactList = Array.isArray(safePayload.contacts) ? safePayload.contacts : [];
        contactList.forEach((contact) => {
            if (!contact || !contact.key) {
                return;
            }
            contacts.set(contact.key, contact);
        });

        return {
            contacts,
            events: Array.isArray(safePayload.events) ? safePayload.events : [],
            rowTimestamps: Array.isArray(safePayload.rowTimestamps)
                ? safePayload.rowTimestamps
                : [],
            skippedRows: Number.isFinite(safePayload.skippedRows) ? safePayload.skippedRows : 0,
            talkedNameKeys: new Set(
                Array.isArray(safePayload.talkedNameKeys) ? safePayload.talkedNameKeys : [],
            ),
            talkedUrlKeys: new Set(
                Array.isArray(safePayload.talkedUrlKeys) ? safePayload.talkedUrlKeys : [],
            ),
            latestTimestamp: Number.isFinite(safePayload.latestTimestamp)
                ? safePayload.latestTimestamp
                : 0,
        };
    }

    /**
     * Rehydrate connection state from worker payload.
     * @param {object|null} payload - Worker payload
     * @returns {{list: object[], byUrl: Map<string, object>, byName: Map<string, object>}}
     */
    function hydrateConnectionState(payload) {
        const safePayload = payload || {};
        const list = Array.isArray(safePayload.list) ? safePayload.list : [];
        const byUrl = new Map();
        const byName = new Map();

        list.forEach((connection) => {
            if (!connection) {
                return;
            }
            if (connection.url && !byUrl.has(connection.url)) {
                byUrl.set(connection.url, connection);
            }
            if (connection.nameKey && !byName.has(connection.nameKey)) {
                byName.set(connection.nameKey, connection);
            }
        });

        return { list, byUrl, byName };
    }

    /**
     * Handle click on a time range button.
     * @param {HTMLElement} button - Clicked time range button
     */
    function handleTimeRangeChange(button) {
        const range = button.getAttribute("data-range");
        if (!range) {
            return;
        }
        applyTimeRange(range);
    }

    /** Reset filters to defaults. */
    function resetFilters() {
        state.filters = { ...FILTER_DEFAULTS };
        setActiveTimeRange(FILTER_DEFAULTS.timeRange);
        syncRouteRange();
        renderView();
    }

    /**
     * Apply new time range and render.
     * @param {string} range - Time range key
     */
    function applyTimeRange(range) {
        state.filters = { ...FILTER_DEFAULTS, timeRange: range };
        setActiveTimeRange(range);
        syncRouteRange();
        renderView();
    }

    /**
     * Update active class on time range buttons.
     * @param {string} range - Active time range
     */
    function setActiveTimeRange(range) {
        elements.timeRangeButtons.forEach((button) => {
            const isActive = button.getAttribute("data-range") === range;
            button.classList.toggle("active", isActive);
            button.setAttribute("aria-pressed", isActive ? "true" : "false");
        });
    }

    /**
     * Parse route range query value.
     * @param {string} value - Raw route value
     * @returns {string}
     */
    function parseRangeParam(value) {
        const range = String(value || "").toLowerCase();
        return RANGE_MONTHS[range] || range === "all" ? range : FILTER_DEFAULTS.timeRange;
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
        if (isApplyingRouteParams) {
            return;
        }
        const currentRoute = AppRouter.getCurrentRoute();
        if (!currentRoute || currentRoute.name !== "messages") {
            return;
        }
        AppRouter.setParams({ range: state.filters.timeRange }, { replaceHistory: false });
    }

    /**
     * Aggregate top contacts for the selected range.
     * @param {object} messageState - Message analytics state
     * @param {number|null} rangeStart - Start timestamp for selected range
     * @returns {{items: object[], totalMessages: number, totalRows: number, totalPeople: number}}
     */
    function getTopContactsInRange(messageState, rangeStart) {
        const rangeCounts = new Map();

        messageState.events.forEach((event) => {
            if (rangeStart && event.timestamp < rangeStart) {
                return;
            }
            const existing = rangeCounts.get(event.contactKey);
            if (existing) {
                existing.count += 1;
                existing.lastTimestamp = Math.max(existing.lastTimestamp, event.timestamp);
                return;
            }
            rangeCounts.set(event.contactKey, {
                count: 1,
                lastTimestamp: event.timestamp,
            });
        });

        const items = Array.from(rangeCounts.entries()).map(([contactKey, metric]) => {
            const base = messageState.contacts.get(contactKey);
            return {
                key: contactKey,
                name: base ? base.name : "Unknown",
                url: base ? base.url : "",
                count: metric.count,
                lastTimestamp: metric.lastTimestamp,
            };
        });

        items.sort((left, right) => {
            if (right.count !== left.count) {
                return right.count - left.count;
            }
            if (right.lastTimestamp !== left.lastTimestamp) {
                return right.lastTimestamp - left.lastTimestamp;
            }
            return left.name.localeCompare(right.name);
        });

        const totalMessages = items.reduce((sum, item) => sum + item.count, 0);
        let totalRows = messageState.rowTimestamps.length;
        if (rangeStart) {
            totalRows = messageState.rowTimestamps.reduce(
                (sum, ts) => sum + (ts >= rangeStart ? 1 : 0),
                0,
            );
        }
        return {
            items,
            totalMessages,
            totalRows,
            totalPeople: items.length,
        };
    }

    /**
     * Get connections that have no messages at all.
     * @param {object} messageState - Message analytics state
     * @param {object} connectionState - Connection state
     * @returns {object[]}
     */
    function getSilentConnections(messageState, connectionState) {
        const silent = connectionState.list.filter((connection) => {
            const seenByUrl = connection.url && messageState.talkedUrlKeys.has(connection.url);
            const seenByName =
                connection.nameKey && messageState.talkedNameKeys.has(connection.nameKey);
            return !(seenByUrl || seenByName);
        });

        silent.sort((left, right) => {
            const leftTs =
                left.connectedOnTimestamp === null
                    ? Number.POSITIVE_INFINITY
                    : left.connectedOnTimestamp;
            const rightTs =
                right.connectedOnTimestamp === null
                    ? Number.POSITIVE_INFINITY
                    : right.connectedOnTimestamp;
            if (leftTs !== rightTs) {
                return leftTs - rightTs;
            }
            return left.name.localeCompare(right.name);
        });

        return silent;
    }

    /**
     * Get connected contacts with no message in past 30 days.
     * @param {object} messageState - Message analytics state
     * @param {object} connectionState - Connection state
     * @returns {object[]}
     */
    function getFadingConversations(messageState, connectionState) {
        const now = Date.now();
        const fading = [];

        messageState.contacts.forEach((contact) => {
            const connection = findMatchingConnection(contact, connectionState);
            if (!connection) {
                return;
            }

            const daysSince = Math.floor((now - contact.lastTimestamp) / MS_PER_DAY);
            if (daysSince < 30) {
                return;
            }

            fading.push({
                name: contact.name,
                url: contact.url || connection.url || "",
                daysSince,
                lastTimestamp: contact.lastTimestamp,
                company: connection.company,
            });
        });

        fading.sort((left, right) => {
            if (right.lastTimestamp !== left.lastTimestamp) {
                return right.lastTimestamp - left.lastTimestamp;
            }
            return left.name.localeCompare(right.name);
        });

        return fading;
    }

    /**
     * Find the connection record that matches a message contact.
     * @param {{name: string, url: string}} contact - Contact from messages
     * @param {object} connectionState - Connection state
     * @returns {object|null}
     */
    function findMatchingConnection(contact, connectionState) {
        if (contact.url && connectionState.byUrl.has(contact.url)) {
            return connectionState.byUrl.get(contact.url) || null;
        }
        const nameKey = normalizeName(contact.name);
        if (nameKey && connectionState.byName.has(nameKey)) {
            return connectionState.byName.get(nameKey) || null;
        }
        return null;
    }

    /** Render the whole messages view. */
    function renderView() {
        if (!state.messageState) {
            return;
        }

        hideEmptyState();

        const rangeStart = getRangeStart(
            state.filters.timeRange,
            state.messageState.latestTimestamp,
        );
        const topSummary = getTopContactsInRange(state.messageState, rangeStart);

        const hasConnections = state.connectionState && state.connectionState.list.length > 0;
        const silentConnections = hasConnections
            ? getSilentConnections(state.messageState, state.connectionState)
            : [];
        const fadingConversations = hasConnections
            ? getFadingConversations(state.messageState, state.connectionState)
            : [];

        state.currentLists.topContacts = topSummary.items;
        state.currentLists.silentConnections = silentConnections;
        state.currentLists.fadingConversations = fadingConversations;

        renderTopContacts(topSummary.items.slice(0, 10));
        renderSilentConnections(silentConnections.slice(0, 10));
        renderFadingConversations(fadingConversations.slice(0, 10));
        updateExportButtonStates();

        updateStats(
            topSummary,
            hasConnections ? state.connectionState.list.length : 0,
            fadingConversations.length,
        );
        updateTip(topSummary.items, silentConnections, fadingConversations);
    }

    /**
     * Render top contacts list.
     * @param {object[]} items - Top contacts
     */
    function renderTopContacts(items) {
        if (!items.length) {
            renderEmptyList(elements.topContactsList, "No conversations in this range yet.");
            return;
        }

        const fragment = document.createDocumentFragment();
        items.forEach((item) => {
            fragment.appendChild(
                createMessageItem({
                    name: item.name,
                    url: item.url,
                    meta: `Last message: ${formatShortDate(item.lastTimestamp)}`,
                    value: `${item.count} msgs`,
                }),
            );
        });
        elements.topContactsList.replaceChildren(fragment);
    }

    /**
     * Render silent connections list.
     * @param {object[]} items - Silent connection rows
     */
    function renderSilentConnections(items) {
        const unavailableReason = getConnectionsUnavailableMessage("silent");
        if (unavailableReason) {
            renderEmptyList(elements.silentConnectionsList, unavailableReason);
            return;
        }

        if (!items.length) {
            renderEmptyList(
                elements.silentConnectionsList,
                "Great job — every connection has at least one message.",
            );
            return;
        }

        const fragment = document.createDocumentFragment();
        items.forEach((item) => {
            const roleMeta = [item.position, item.company].filter(Boolean).join(" @ ");
            const connectedOn = item.connectedOnTimestamp
                ? formatShortDate(item.connectedOnTimestamp)
                : "No date";
            fragment.appendChild(
                createMessageItem({
                    name: item.name,
                    url: item.url,
                    meta: roleMeta || "No role info",
                    value: connectedOn,
                }),
            );
        });
        elements.silentConnectionsList.replaceChildren(fragment);
    }

    /**
     * Render fading conversations list.
     * @param {object[]} items - Fading conversation rows
     */
    function renderFadingConversations(items) {
        const unavailableReason = getConnectionsUnavailableMessage("fading");
        if (unavailableReason) {
            renderEmptyList(elements.fadingConversationsList, unavailableReason);
            return;
        }

        if (!items.length) {
            renderEmptyList(
                elements.fadingConversationsList,
                "No fading conversations in your connected network.",
            );
            return;
        }

        const fragment = document.createDocumentFragment();
        items.forEach((item) => {
            fragment.appendChild(
                createMessageItem({
                    name: item.name,
                    url: item.url,
                    meta: `Last message: ${formatShortDate(item.lastTimestamp)}`,
                    value: `${item.daysSince} days`,
                }),
            );
        });
        elements.fadingConversationsList.replaceChildren(fragment);
    }

    /**
     * Create one list item element for messages panels.
     * @param {{name: string, url: string, meta: string, value: string}} item - Render payload
     * @returns {HTMLElement}
     */
    function createMessageItem(item) {
        const listItem = document.createElement("li");
        listItem.className = "message-item";

        const main = document.createElement("div");
        main.className = "message-item-main";

        const title = document.createElement("p");
        title.className = "message-item-title";
        appendContactName(title, item.name, item.url);

        const meta = document.createElement("p");
        meta.className = "message-item-meta";
        meta.textContent = item.meta;

        const value = document.createElement("span");
        value.className = "message-item-value";
        value.textContent = item.value;

        main.appendChild(title);
        main.appendChild(meta);
        listItem.appendChild(main);
        listItem.appendChild(value);
        return listItem;
    }

    /**
     * Append contact name as link when URL is available.
     * @param {HTMLElement} container - Name container
     * @param {string} name - Contact name
     * @param {string} url - Contact profile URL
     */
    function appendContactName(container, name, url) {
        const label = cleanText(name) || "Unknown";
        const cleanUrl = cleanText(url);
        if (!cleanUrl) {
            container.textContent = label;
            return;
        }

        const link = document.createElement("a");
        link.href = cleanUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = label;
        container.appendChild(link);
    }

    /**
     * Update summary stats.
     * @param {{totalMessages: number, totalRows: number, totalPeople: number}} topSummary - Top summary
     * @param {number} totalConnections - Total number of connections
     * @param {number} fadingCount - Number of fading conversations
     */
    function updateStats(topSummary, totalConnections, fadingCount) {
        const card = elements.msgStatMessages.closest(".stat-card");
        if (card) {
            card.classList.remove("popup-active");
        }

        const skipped = state.messageState ? state.messageState.skippedRows : 0;
        elements.msgStatMessages.replaceChildren(
            document.createTextNode(String(topSummary.totalRows)),
        );

        if (skipped > 0) {
            const popupId = "msgSkippedPopup";
            const msg = `${skipped} of ${state.totalInputRows} cleaned rows were excluded from analysis (self-messages, anonymous contacts, or unparseable dates)`;

            const asterisk = document.createElement("span");
            asterisk.className = "stat-asterisk";
            asterisk.setAttribute("role", "button");
            asterisk.setAttribute("tabindex", "0");
            asterisk.setAttribute("aria-label", "Show excluded row details");
            asterisk.setAttribute("aria-describedby", popupId);
            asterisk.textContent = "*";

            const popup = document.createElement("span");
            popup.className = "stat-popup";
            popup.setAttribute("role", "tooltip");
            popup.id = popupId;
            popup.setAttribute("aria-hidden", "true");
            popup.textContent = msg;

            elements.msgStatMessages.appendChild(asterisk);
            elements.msgStatMessages.appendChild(popup);

            function showPopup() {
                popup.classList.add("visible");
                popup.setAttribute("aria-hidden", "false");
                if (card) {
                    card.classList.add("popup-active");
                }
            }
            function hidePopup() {
                popup.classList.remove("visible");
                popup.setAttribute("aria-hidden", "true");
                if (card) {
                    card.classList.remove("popup-active");
                }
            }
            function togglePopup() {
                if (popup.classList.contains("visible")) {
                    hidePopup();
                } else {
                    showPopup();
                }
            }

            asterisk.addEventListener("mouseenter", showPopup);
            asterisk.addEventListener("mouseleave", hidePopup);
            asterisk.addEventListener("click", togglePopup);
            asterisk.addEventListener("keydown", (e) => {
                switch (e.key) {
                    case "Escape":
                        hidePopup();
                        break;
                    case "Enter":
                    case " ":
                        e.preventDefault();
                        togglePopup();
                        break;
                    default:
                        break;
                }
            });
            asterisk.addEventListener("focusout", hidePopup);
        }
        elements.msgStatContacts.textContent = String(topSummary.totalPeople);
        elements.msgStatConnected.textContent = String(totalConnections);
        elements.msgStatFading.textContent = String(fadingCount);
    }

    /**
     * Update tip text.
     * @param {object[]} topContacts - Top contacts list
     * @param {object[]} silentConnections - Silent connections list
     * @param {object[]} fadingConversations - Fading conversations list
     */
    function updateTip(topContacts, silentConnections, fadingConversations) {
        const tipText = buildTipText(topContacts, silentConnections, fadingConversations);
        if (!tipText) {
            elements.messagesTip.hidden = true;
            return;
        }
        elements.messagesTipText.textContent = tipText;
        elements.messagesTip.hidden = false;
    }

    /**
     * Build a contextual tip string.
     * @param {object[]} topContacts - Top contacts list
     * @param {object[]} silentConnections - Silent connections list
     * @param {object[]} fadingConversations - Fading conversations list
     * @returns {string|null}
     */
    function buildTipText(topContacts, silentConnections, fadingConversations) {
        const unavailableReason = getConnectionsUnavailableMessage("tip");
        if (unavailableReason) {
            return unavailableReason;
        }

        const top = topContacts[0] || null;
        const fading = fadingConversations[0] || null;

        if (top && fading) {
            return `${top.name} is your most active conversation. Reconnect with ${fading.name} who has been quiet for ${fading.daysSince} days.`;
        }

        if (top) {
            return `${top.name} is your top contact in this range. Keep this momentum going.`;
        }

        if (silentConnections.length) {
            return `${silentConnections.length} connections are still silent. A short check-in can restart your network momentum.`;
        }

        return null;
    }

    /**
     * Get reason message when connections insights are unavailable.
     * @param {'silent'|'fading'|'tip'} section - UI section requesting status
     * @returns {string|null}
     */
    function getConnectionsUnavailableMessage(section) {
        const missingFileMessages = {
            silent: "Upload Connections.csv to view silent connections.",
            fading: "Upload Connections.csv to identify fading conversations.",
            tip: "Upload Connections.csv to unlock silent and fading relationship insights.",
        };

        if (!state.hasConnectionsFile) {
            return missingFileMessages[section] || missingFileMessages.tip;
        }
        if (state.connectionLoadError) {
            return state.connectionLoadError;
        }
        return null;
    }

    /**
     * Render list empty message.
     * @param {HTMLElement} listElement - Target list element
     * @param {string} message - Empty message text
     */
    function renderEmptyList(listElement, message) {
        const item = document.createElement("li");
        item.className = "message-empty";
        item.textContent = message;
        listElement.replaceChildren(item);
    }

    /** Export top contacts panel data. */
    async function exportTopContacts() {
        const rows = state.currentLists.topContacts.map((item) => ({
            Name: item.name,
            "LinkedIn URL": toLinkedInCell(item.url),
            Messages: item.count,
            "Last Message": formatShortDate(item.lastTimestamp),
        }));
        await downloadExport("top-contacts", "Top Contacts", rows);
    }

    /** Export silent connections panel data. */
    async function exportSilentConnections() {
        const rows = state.currentLists.silentConnections.map((item) => ({
            Name: item.name,
            "LinkedIn URL": toLinkedInCell(item.url),
            "Connected On": item.connectedOnTimestamp
                ? formatShortDate(item.connectedOnTimestamp)
                : "",
            Position: item.position || "",
            Company: item.company || "",
        }));
        await downloadExport("silent-connections", "Silent Connections", rows);
    }

    /** Export fading conversations panel data. */
    async function exportFadingConversations() {
        const rows = state.currentLists.fadingConversations.map((item) => ({
            Name: item.name,
            "LinkedIn URL": toLinkedInCell(item.url),
            "Days Since Last Message": item.daysSince,
            "Last Message": formatShortDate(item.lastTimestamp),
            Company: item.company || "",
        }));
        await downloadExport("fading-conversations", "Fading Conversations", rows);
    }

    /**
     * Convert a URL string to an export cell with hyperlink metadata.
     * @param {string} url - LinkedIn profile URL
     * @returns {string|{value: string, hyperlink: string}}
     */
    function toLinkedInCell(url) {
        const value = cleanText(url);
        /* v8 ignore next 3 */
        if (!value) {
            return "";
        }
        return {
            value,
            hyperlink: value,
        };
    }

    /**
     * Download rows as Excel file using export spec.
     * @param {string} filePrefix - File prefix
     * @param {string} sheetName - Worksheet name
     * @param {object[]} rows - Export rows
     */
    async function downloadExport(filePrefix, sheetName, rows) {
        /* v8 ignore next 3 */
        if (!rows.length) {
            return;
        }
        /* v8 ignore next 3 */
        if (!ExcelGenerator || typeof ExcelGenerator.downloadFromSpec !== "function") {
            return;
        }

        const headers = Object.keys(rows[0]);
        const orderedRows = rows.map((row) => headers.map((header) => row[header] ?? ""));
        const result = await ExcelGenerator.downloadFromSpec(
            {
                sheetName,
                headers,
                rows: orderedRows,
            },
            `messages-${filePrefix}.xlsx`,
        );
        if (!result.success) {
            captureError(new Error(result.error || "Messages export failed."), {
                module: "messages-insights",
                operation: "export",
                exportType: filePrefix,
            });
        }
    }

    /** Enable/disable export buttons based on availability and list content. */
    function updateExportButtonStates() {
        const exportReady = Boolean(
            ExcelGenerator && typeof ExcelGenerator.downloadFromSpec === "function",
        );

        if (elements.topContactsExportBtn) {
            elements.topContactsExportBtn.disabled = !(
                exportReady && state.currentLists.topContacts.length
            );
        }
        if (elements.silentConnectionsExportBtn) {
            elements.silentConnectionsExportBtn.disabled = !(
                exportReady && state.currentLists.silentConnections.length
            );
        }
        if (elements.fadingConversationsExportBtn) {
            elements.fadingConversationsExportBtn.disabled = !(
                exportReady && state.currentLists.fadingConversations.length
            );
        }
    }

    /**
     * Get range start timestamp from the selected range.
     * @param {string} range - Range key
     * @param {number} latestTimestamp - Latest message timestamp
     * @returns {number|null}
     */
    function getRangeStart(range, latestTimestamp) {
        if (range === "all") {
            return null;
        }
        const months = RANGE_MONTHS[range];
        if (!months || !latestTimestamp) {
            return null;
        }
        const latestDate = new Date(latestTimestamp);
        return new Date(
            latestDate.getFullYear(),
            latestDate.getMonth() - (months - 1),
            1,
            0,
            0,
            0,
            0,
        ).getTime();
    }

    /**
     * Trim any value into a string.
     * @param {unknown} value - Raw value
     * @returns {string}
     */
    function cleanText(value) {
        return MessagesAnalytics.cleanText(value);
    }

    /**
     * Normalize names for matching.
     * @param {string} value - Raw name
     * @returns {string}
     */
    function normalizeName(value) {
        return MessagesAnalytics.normalizeName(value);
    }

    /**
     * Format timestamp as human-readable date.
     * @param {number} timestamp - Timestamp in milliseconds
     * @returns {string}
     */
    function formatShortDate(timestamp) {
        return SHORT_DATE_FORMATTER.format(new Date(timestamp));
    }

    /**
     * Show empty state and hide layout.
     * @param {string} title - Empty state title
     * @param {string} message - Empty state message
     */
    function setEmptyState(title, message) {
        const heading = elements.messagesEmpty.querySelector("h2");
        const text = elements.messagesEmpty.querySelector("p");
        if (heading) {
            heading.textContent = title;
        }
        if (text) {
            text.textContent = message;
        }
        elements.messagesEmpty.hidden = false;
        elements.messagesLayout.hidden = true;
        elements.messagesTip.hidden = true;
        updateExportButtonStates();
    }

    /** Hide empty state and show layout. */
    function hideEmptyState() {
        elements.messagesEmpty.hidden = true;
        elements.messagesLayout.hidden = false;
    }

    /**
     * Toggle loading overlay for messages screen.
     * @param {boolean} isLoading - Whether loading is active
     */
    function showMessagesLoading(isLoading) {
        if (isLoading) {
            renderLoadingSkeleton();
            LoadingOverlay.show("messages");
            return;
        }
        LoadingOverlay.hide("messages");
    }

    /** Render temporary skeleton rows while loading data. */
    function renderLoadingSkeleton() {
        elements.messagesEmpty.hidden = true;
        elements.messagesLayout.hidden = false;
        elements.messagesTip.hidden = true;

        const skeletonItem = `
            <li class="message-item skeleton-row">
                <div class="message-item-main">
                    <div class="skeleton-block skeleton-title"></div>
                    <div class="skeleton-block skeleton-meta"></div>
                </div>
                <div class="skeleton-block skeleton-value"></div>
            </li>
        `;

        elements.topContactsList.innerHTML = skeletonItem.repeat(3);
        elements.silentConnectionsList.innerHTML = skeletonItem.repeat(3);
        elements.fadingConversationsList.innerHTML = skeletonItem.repeat(3);
    }

    return {
        init,
        onRouteChange,
        onRouteLeave,
    };
})();
