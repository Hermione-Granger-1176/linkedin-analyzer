/* Messages insights page logic */

import { getInitials, pickAvatarColor } from "./avatar.js";
import { LinkedInCleaner } from "./cleaner.js";
import { DataCache } from "./data-cache.js";
import { ExcelGenerator } from "./excel.js";
import { LoadingOverlay } from "./loading-overlay.js";
import { MessagesAnalytics } from "./messages-analytics.js";
import {
    buildDataSignature,
    computeWorkerTimeout,
    DEFAULT_TIME_RANGE,
    formatShortDate,
    getRangeStart,
    parseRangeParam,
} from "./messages-format.js";
import {
    getFadingConversations,
    getSilentConnections,
    getTopContactsInRange,
} from "./messages-relationships.js";
import { AppRouter } from "./router.js";
import { captureError } from "./sentry.js";
import { Session } from "./session.js";
import { Storage } from "./storage.js";
import { reportPerformanceMeasure } from "./telemetry.js";
import {
    parseMessagesWorkerMessage,
    parseStoredUploadFile,
    toStoredFileMetadata,
} from "./worker-contracts.js";

export const MessagesPage = (() => {
    "use strict";

    /** @type {{ timeRange: string }} */
    const FILTER_DEFAULTS = Object.freeze({
        timeRange: DEFAULT_TIME_RANGE,
    });
    // Above this combined CSV size, re-parsing on the UI thread would freeze the
    // page, so the main-thread fallback is skipped in favor of an empty state.
    const MAIN_THREAD_FALLBACK_MAX_CHARS = 5 * 1024 * 1024;

    /**
     * @typedef {object} MessageContact
     * @property {string} key
     * @property {string} name
     * @property {string} url
     * @property {number} count
     * @property {number} lastTimestamp
     */

    /**
     * @typedef {object} MessageState
     * @property {Map<string, MessageContact>} contacts
     * @property {Array<{contactKey: string, timestamp: number}>} events
     * @property {number[]} rowTimestamps
     * @property {number} skippedRows
     * @property {Set<string>} talkedNameKeys
     * @property {Set<string>} talkedUrlKeys
     * @property {number} latestTimestamp
     * @property {object|null} outreach
     */

    /**
     * @typedef {object} Connection
     * @property {string} name
     * @property {string} nameKey
     * @property {string} url
     * @property {string} company
     * @property {string} position
     * @property {number|null} connectedOnTimestamp
     */

    /**
     * @typedef {{list: Connection[], byUrl: Map<string, Connection>, byName: Map<string, Connection>}} ConnectionState
     */

    /** @type {{timeRangeButtons: NodeListOf<Element>, timeRangeSelect: HTMLSelectElement | null, resetFiltersBtn: HTMLElement | null, topContactsExportBtn: HTMLButtonElement | null, silentConnectionsExportBtn: HTMLButtonElement | null, fadingConversationsExportBtn: HTMLButtonElement | null, messagesEmpty: HTMLElement | null, messagesLayout: HTMLElement | null, topContactsList: HTMLElement | null, silentConnectionsList: HTMLElement | null, fadingConversationsList: HTMLElement | null, msgStatMessages: HTMLElement | null, msgStatContacts: HTMLElement | null, msgStatConnected: HTMLElement | null, msgStatFading: HTMLElement | null, messagesTip: HTMLElement | null, messagesTipText: HTMLElement | null}} */
    const elements = {
        timeRangeButtons: document.querySelectorAll("#messagesTimeRangeButtons .filter-btn"),
        timeRangeSelect: /** @type {HTMLSelectElement|null} */ (
            document.getElementById("messagesTimeRangeSelect")
        ),
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

    /** @type {{filters: {timeRange: string}, messageState: MessageState | null, connectionState: ConnectionState | null, hasConnectionsFile: boolean, connectionLoadError: string | null, loadedSignature: string | null, totalInputRows: number, currentLists: {topContacts: object[], silentConnections: object[], fadingConversations: object[]}}} */
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

        const nextRange = parseRangeParam(params && params.range, FILTER_DEFAULTS.timeRange);
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
        if (elements.timeRangeSelect) {
            elements.timeRangeSelect.addEventListener("change", handleTimeRangeSelect);
        }
        if (elements.resetFiltersBtn) {
            elements.resetFiltersBtn.addEventListener("click", resetFilters);
        }
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
        // The worker was unavailable, errored, or timed out. Re-parsing a large
        // export on the UI thread would freeze the page, so bail out with an
        // explanatory empty state above the size ceiling.
        if (messagesCsv.length + connectionsCsv.length > MAIN_THREAD_FALLBACK_MAX_CHARS) {
            return {
                success: false,
                error: "These files are too large to analyze without a background worker. Reload the page, or open it in a browser that supports Web Workers.",
            };
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
                    // invalid() always supplies an error string, so the fallback is defensive.
                    /* v8 ignore next */
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
                    event && event.error
                        ? event.error
                        : new Error(
                              `Messages worker ${event && event.type ? event.type : "error"} event`,
                          ),
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
                // the worker is only nulled after listeners are removed, so this guard is defensive.
                /* v8 ignore next 3 */
                if (!parseWorker) {
                    return;
                }
                parseWorker.removeEventListener("message", handleMessage);
                parseWorker.removeEventListener("error", handleError);
                parseWorker.removeEventListener("messageerror", handleError);
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
            }, computeWorkerTimeout(messagesCsv, connectionsCsv));

            try {
                parseWorker.addEventListener("message", handleMessage);
                parseWorker.addEventListener("error", handleError);
                parseWorker.addEventListener("messageerror", handleError);
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

            let messagesFile = DataCache.get("storage:file:messages") || null;
            let connectionsFile = DataCache.get("storage:file:connections") || null;
            let files = DataCache.get("storage:files") || null;

            messagesFile = normalizeStoredFile(messagesFile, "messages");
            connectionsFile = normalizeStoredFile(connectionsFile, "connections");

            if (!messagesFile || !connectionsFile) {
                if (!files) {
                    // Cache metadata only; messages/connections text is loaded on
                    // demand below so the large messages export isn't held in memory.
                    files = (await Storage.getAllFiles()).map(toStoredFileMetadata);
                    DataCache.set("storage:files", files);
                }
                if (!messagesFile) {
                    messagesFile = normalizeStoredFile(
                        files.find((file) => file.type === "messages") || null,
                        "messages",
                    );
                    if (messagesFile) {
                        DataCache.set("storage:file:messages", toStoredFileMetadata(messagesFile));
                    }
                }
                if (!connectionsFile) {
                    connectionsFile = normalizeStoredFile(
                        files.find((file) => file.type === "connections") || null,
                        "connections",
                    );
                    if (connectionsFile) {
                        DataCache.set(
                            "storage:file:connections",
                            toStoredFileMetadata(connectionsFile),
                        );
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

            // Load the CSV text on demand (caches hold metadata only) so the large
            // messages export isn't retained in memory between visits.
            const [messagesStored, connectionsStored] = await Promise.all([
                Storage.getFile("messages"),
                connectionsFile ? Storage.getFile("connections") : Promise.resolve(null),
            ]);
            const messagesText = messagesStored && messagesStored.text ? messagesStored.text : "";
            if (!messagesText) {
                // The metadata says messages.csv exists but its text record is
                // gone (cleared in another tab or degraded persistence). Treat
                // the missing payload as a load failure so the UI enters the
                // storage-error path instead of a misleading "parsing error".
                throw new Error("Stored messages text record is missing.");
            }
            const connectionsText =
                connectionsStored && connectionsStored.text ? connectionsStored.text : "";
            // Connections is optional, but if its metadata is present while the
            // text record is missing, flag it as a load error rather than
            // silently dropping the connections insights.
            const connectionsTextMissing = Boolean(connectionsFile) && !connectionsText;

            markPerformance("messages:worker-parse:start");
            const processed = await processFiles(messagesText, connectionsText);
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
            // Persist only once the dataset is confirmed usable, so an empty
            // parse can't overwrite a previously valid stored outreach summary.
            persistOutreach(state.messageState.outreach);

            if (processed.connectionState) {
                state.connectionState = hydrateConnectionState(processed.connectionState);
            } else {
                state.connectionState = buildConnectionState(processed.connectionsData || []);
            }
            state.connectionLoadError =
                processed.connectionError ||
                (connectionsTextMissing
                    ? "Unable to load Connections.csv. Re-upload the file and try again."
                    : null);

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
            // invalid() always supplies an error string, so the fallback is defensive.
            /* v8 ignore next */
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
        // performance.mark is always available in supported browsers, so this env guard is defensive.
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
        // performance.measure is always available in supported browsers, so this env guard is defensive.
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
                    reportPerformanceMeasure(name, lastEntry.duration);
                }
            }
        } catch {
            // Ignore missing marks to keep instrumentation resilient.
        }
    }

    /**
     * Build message analytics state from cleaned rows.
     * @param {object[]} rows - Cleaned message rows
     * @returns {MessageState}
     */
    function buildMessageState(rows) {
        markPerformance("messages:build-state:start");
        const result = /** @type {MessageState} */ (MessagesAnalytics.buildMessageState(rows));
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
     * @returns {ConnectionState}
     */
    function buildConnectionState(rows) {
        markPerformance("messages:build-connections:start");
        const result = /** @type {ConnectionState} */ (
            MessagesAnalytics.buildConnectionState(rows)
        );
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
     * @returns {MessageState}
     */
    function hydrateMessageState(payload) {
        // only called with a truthy processed.messageState, so the fallback is defensive.
        /* v8 ignore next */
        const safePayload = payload || {};
        /** @type {Map<string, MessageContact>} */
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
            outreach: safePayload.outreach || null,
        };
    }

    /**
     * Rehydrate connection state from worker payload.
     * @param {object|null} payload - Worker payload
     * @returns {{list: object[], byUrl: Map<string, object>, byName: Map<string, object>}}
     */
    function hydrateConnectionState(payload) {
        // only called with a truthy processed.connectionState, so the fallback is defensive.
        /* v8 ignore next */
        const safePayload = payload || {};
        const list = Array.isArray(safePayload.list) ? safePayload.list : [];
        const byUrl = new Map();
        const byName = new Map();

        list.forEach((connection) => {
            // the worker never emits null list rows, so this guard is defensive.
            /* v8 ignore next 3 */
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

    /** Apply the range chosen from the compact select, ignoring unknown values. */
    function handleTimeRangeSelect() {
        // Bound only inside the `if (elements.timeRangeSelect)` guard in init, so
        // the element is always present here; assert non-null for the type checker.
        const range = /** @type {HTMLSelectElement} */ (elements.timeRangeSelect).value;
        // parseRangeParam echoes a valid range normalized to lowercase and returns
        // the fallback otherwise; the empty sentinel is never a valid range, so it
        // flags unknown values. Apply the parsed value so odd casing still enters
        // state and the router as the normalized range.
        const parsed = parseRangeParam(range, "");
        if (parsed === "") {
            return;
        }
        applyTimeRange(parsed);
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
        if (elements.timeRangeSelect) {
            elements.timeRangeSelect.value = range;
        }
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
        // route application never re-enters sync, so this guard is defensive.
        /* v8 ignore next 3 */
        if (isApplyingRouteParams) {
            return;
        }
        const currentRoute = AppRouter.getCurrentRoute();
        if (!currentRoute || currentRoute.name !== "messages") {
            return;
        }
        AppRouter.setParams({ range: state.filters.timeRange }, { replaceHistory: false });
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
            // hasConnections implies a connectionState with a list, so the ?. and ?? are defensive.
            /* v8 ignore next */
            hasConnections ? (state.connectionState?.list.length ?? 0) : 0,
            fadingConversations.length,
        );
        updateTip(topSummary.items, silentConnections, fadingConversations);
    }

    /**
     * Best-effort persist of the lifetime outreach summary so the Insights page
     * can show it without loading the message export. Runs once per dataset load
     * (not per filter re-render) and never blocks the UI on a storage failure.
     * @param {object|null} outreach - Outreach summary from the message state
     */
    function persistOutreach(outreach) {
        if (!outreach) {
            return;
        }
        Promise.resolve(Storage.saveOutreach(outreach)).catch((error) => {
            captureError(error, {
                module: "messages-insights",
                operation: "persist-outreach",
            });
        });
    }

    /**
     * Render top contacts list.
     * @param {object[]} items - Top contacts
     */
    function renderTopContacts(items) {
        const listElement = elements.topContactsList;
        // list element is part of the static shell, so the guard is defensive.
        /* v8 ignore next 3 */
        if (!listElement) {
            return;
        }
        if (!items.length) {
            renderEmptyList(listElement, "No conversations in this range yet.");
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
        listElement.replaceChildren(fragment);
    }

    /**
     * Render silent connections list.
     * @param {object[]} items - Silent connection rows
     */
    function renderSilentConnections(items) {
        const listElement = elements.silentConnectionsList;
        // list element is part of the static shell, so the guard is defensive.
        /* v8 ignore next 3 */
        if (!listElement) {
            return;
        }
        const unavailableReason = getConnectionsUnavailableMessage("silent");
        if (unavailableReason) {
            renderEmptyList(listElement, unavailableReason);
            return;
        }

        if (!items.length) {
            renderEmptyList(
                listElement,
                "Great job. Every connection has at least one message.",
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
        listElement.replaceChildren(fragment);
    }

    /**
     * Render fading conversations list.
     * @param {object[]} items - Fading conversation rows
     */
    function renderFadingConversations(items) {
        const listElement = elements.fadingConversationsList;
        // list element is part of the static shell, so the guard is defensive.
        /* v8 ignore next 3 */
        if (!listElement) {
            return;
        }
        const unavailableReason = getConnectionsUnavailableMessage("fading");
        if (unavailableReason) {
            renderEmptyList(listElement, unavailableReason);
            return;
        }

        if (!items.length) {
            renderEmptyList(
                listElement,
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
        listElement.replaceChildren(fragment);
    }

    /**
     * Create one list item element for messages panels.
     * @param {{name: string, url: string, meta: string, value: string}} item - Render payload
     * @returns {HTMLElement}
     */
    function createMessageItem(item) {
        const listItem = document.createElement("li");
        listItem.className = "message-item";

        const label = cleanText(item.name) || "Unknown";
        const avatar = document.createElement("span");
        avatar.className = `message-item-avatar avatar-${pickAvatarColor(label)}`;
        avatar.textContent = getInitials(label);
        avatar.setAttribute("aria-hidden", "true");
        listItem.appendChild(avatar);

        const main = document.createElement("div");
        main.className = "message-item-main";

        const title = document.createElement("p");
        title.className = "message-item-title";
        appendContactName(title, label, item.url);

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
     * @param {string} label - Display name (already cleaned, never empty)
     * @param {string} url - Contact profile URL
     */
    function appendContactName(container, label, url) {
        const cleanUrl = cleanText(url);
        // Defense in depth: callers currently pass normalizeUrl-validated values, but guard the
        // scheme here so a future non-normalized caller can't introduce a javascript: URL.
        if (!cleanUrl || !/^https?:\/\//i.test(cleanUrl)) {
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
        const {
            msgStatMessages,
            msgStatContacts,
            msgStatConnected,
            msgStatFading,
        } = elements;
        // stat cells are part of the static shell, so the guard is defensive.
        /* v8 ignore next 3 */
        if (!msgStatMessages || !msgStatContacts || !msgStatConnected || !msgStatFading) {
            return;
        }
        const card = msgStatMessages.closest(".stat-card");
        if (card) {
            card.classList.remove("popup-active");
        }

        // renderView guards against a null messageState before calling updateStats.
        /* v8 ignore next */
        const skipped = state.messageState ? state.messageState.skippedRows : 0;
        msgStatMessages.replaceChildren(
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

            msgStatMessages.appendChild(asterisk);
            msgStatMessages.appendChild(popup);

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
        msgStatContacts.textContent = String(topSummary.totalPeople);
        msgStatConnected.textContent = String(totalConnections);
        msgStatFading.textContent = String(fadingCount);
    }

    /**
     * Update tip text.
     * @param {object[]} topContacts - Top contacts list
     * @param {object[]} silentConnections - Silent connections list
     * @param {object[]} fadingConversations - Fading conversations list
     */
    function updateTip(topContacts, silentConnections, fadingConversations) {
        const { messagesTip, messagesTipText } = elements;
        // tip elements are part of the static shell, so the guard is defensive.
        /* v8 ignore next 3 */
        if (!messagesTip || !messagesTipText) {
            return;
        }
        const tipText = buildTipText(topContacts, silentConnections, fadingConversations);
        if (!tipText) {
            messagesTip.hidden = true;
            return;
        }
        messagesTipText.textContent = tipText;
        messagesTip.hidden = false;
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
            // section is always a known key, so the .tip fallback is defensive.
            /* v8 ignore next */
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
        // every export row is built with the same fully-populated keys, so ?? "" is defensive.
        /* v8 ignore next */
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
     * Trim any value into a string.
     * @param {unknown} value - Raw value
     * @returns {string}
     */
    function cleanText(value) {
        return MessagesAnalytics.cleanText(value);
    }

    /**
     * Show empty state and hide layout.
     * @param {string} title - Empty state title
     * @param {string} message - Empty state message
     */
    function setEmptyState(title, message) {
        const { messagesEmpty, messagesLayout } = elements;
        // empty/layout containers are part of the static shell, so the guard is defensive.
        /* v8 ignore next 3 */
        if (!messagesEmpty || !messagesLayout) {
            return;
        }
        const heading = messagesEmpty.querySelector("h2");
        const text = messagesEmpty.querySelector("p");
        if (heading) {
            heading.textContent = title;
        }
        if (text) {
            text.textContent = message;
        }
        messagesEmpty.hidden = false;
        messagesLayout.hidden = true;
        if (elements.messagesTip) {
            elements.messagesTip.hidden = true;
        }
        updateExportButtonStates();
    }

    /** Hide empty state and show layout. */
    function hideEmptyState() {
        const { messagesEmpty, messagesLayout } = elements;
        // empty/layout containers are part of the static shell, so the guard is defensive.
        /* v8 ignore next 3 */
        if (!messagesEmpty || !messagesLayout) {
            return;
        }
        messagesEmpty.hidden = true;
        messagesLayout.hidden = false;
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
        const { messagesEmpty, messagesLayout } = elements;
        // empty/layout containers are part of the static shell, so the guard is defensive.
        /* v8 ignore next 3 */
        if (!messagesEmpty || !messagesLayout) {
            return;
        }
        messagesEmpty.hidden = true;
        messagesLayout.hidden = false;
        if (elements.messagesTip) {
            elements.messagesTip.hidden = true;
        }

        const skeletonItem = `
            <li class="message-item skeleton-row">
                <span class="skeleton-block skeleton-avatar"></span>
                <div class="message-item-main">
                    <div class="skeleton-block skeleton-title"></div>
                    <div class="skeleton-block skeleton-meta"></div>
                </div>
                <div class="skeleton-block skeleton-value"></div>
            </li>
        `;

        if (elements.topContactsList) {
            elements.topContactsList.innerHTML = skeletonItem.repeat(3);
        }
        if (elements.silentConnectionsList) {
            elements.silentConnectionsList.innerHTML = skeletonItem.repeat(3);
        }
        if (elements.fadingConversationsList) {
            elements.fadingConversationsList.innerHTML = skeletonItem.repeat(3);
        }
    }

    return {
        init,
        onRouteChange,
        onRouteLeave,
    };
})();
