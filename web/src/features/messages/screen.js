/* Messages insights page logic */

import { AppRouter } from "../../app/router.js";
import { parseStoredUploadFile, toStoredFileMetadata } from "../../app/worker-contracts.ts";
import { nextFrame, startPerformanceSpan } from "../../platform/observability/perf.js";
import { captureError } from "../../platform/observability/sentry.js";
import { DataCache } from "../../platform/persistence/data-cache.js";
import { Session } from "../../platform/persistence/session.js";
import { Storage } from "../../platform/persistence/storage.js";
import { setEmptyStateText } from "../../shared/ui/empty-state.js";
import { LoadingOverlay } from "../../shared/ui/loading-overlay.js";
import { createRangeFilter } from "../../shared/ui/time-range.js";
import { ExcelGenerator } from "../cleaning/excel.js";

import { MessagesAnalytics } from "./analytics.js";
import {
    buildDataSignature,
    DEFAULT_TIME_RANGE,
    formatShortDate,
    getRangeStart,
    RANGE_KEYS,
} from "./format.js";
import { hydrateConnectionState, hydrateMessageState } from "./hydrate.js";
import { createMessageItem, renderEmptyList, SKELETON_ITEM } from "./list-dom.js";
import { initWorker, processFiles, terminateWorker } from "./parse.js";
import {
    getFadingConversations,
    getSilentConnections,
    getTopContactsInRange,
} from "./relationships.js";

export const MessagesPage = (() => {
    "use strict";

    /** @type {{ timeRange: string }} */
    const FILTER_DEFAULTS = Object.freeze({
        timeRange: DEFAULT_TIME_RANGE,
    });

    /** @typedef {import("./analytics.js").MessageRow} MessageRow */
    /** @typedef {import("./analytics.js").ConnectionRow} ConnectionRow */
    /** @typedef {import("./analytics.js").MessageState} MessageState */
    /** @typedef {import("./analytics.js").Connection} Connection */
    /** @typedef {import("./analytics.js").ConnectionState} ConnectionState */
    /** @typedef {import("./analytics.js").OutreachSummary} OutreachSummary */
    /** @typedef {import("./relationships.js").RangeContact} RangeContact */
    /** @typedef {import("./relationships.js").FadingConversation} FadingConversation */
    /** @typedef {import("../../app/worker-contracts.ts").StoredUploadFile} StoredUploadFile */
    /** @typedef {import("../../app/worker-contracts.ts").CachedFileMetadata} CachedFileMetadata */

    /**
     * Computed page state cached per dataset signature.
     * @typedef {object} CachedMessagesState
     * @property {MessageState} messageState - Message analytics state
     * @property {ConnectionState|null} connectionState - Connection state, if loaded
     * @property {boolean} hasConnectionsFile - Whether a connections upload exists
     * @property {string|null} connectionLoadError - Connections load error, if any
     * @property {number} totalInputRows - Cleaned message rows
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

    /** @type {{filters: {timeRange: string}, messageState: MessageState | null, connectionState: ConnectionState | null, hasConnectionsFile: boolean, connectionLoadError: string | null, loadedSignature: string | null, totalInputRows: number, currentLists: {topContacts: RangeContact[], silentConnections: Connection[], fadingConversations: FadingConversation[]}}} */
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
    /** @type {import("../../shared/ui/time-range.js").RangeFilter|null} */
    let rangeFilter = null;

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
     * @param {import("../../app/router.js").RouteParams} params - Route query params
     */
    function onRouteChange(params) {
        if (!initialized) {
            init();
        }
        if (!initialized) {
            return;
        }

        const filter = /** @type {import("../../shared/ui/time-range.js").RangeFilter} */ (
            rangeFilter
        );
        const nextRange = filter.parse(params && params.range);
        state.filters = { ...FILTER_DEFAULTS, timeRange: nextRange };
        filter.show(nextRange);
        loadData();
    }

    /** Cleanup when leaving messages route. */
    function onRouteLeave() {
        showMessagesLoading(false);
    }

    /** Attach event listeners for filters. */
    function bindEvents() {
        rangeFilter = createRangeFilter({
            ranges: RANGE_KEYS,
            fallback: FILTER_DEFAULTS.timeRange,
            buttons: elements.timeRangeButtons,
            select: elements.timeRangeSelect,
            resetButton: elements.resetFiltersBtn,
            route: { router: AppRouter, name: "messages" },
            onChange: (range) => {
                state.filters = { ...FILTER_DEFAULTS, timeRange: range };
                renderView();
            },
        });
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

    /** Render the current state, then hide the loading overlay. */
    function renderAndFinish() {
        const endRender = startPerformanceSpan("messages:render");
        renderView();
        endRender();
        showMessagesLoading(false);
    }

    /**
     * Drop the computed state and show why the page has nothing to analyze.
     * @param {string} signature - Dataset signature to remember, so the same data is not reloaded
     * @param {string} title - Empty state title
     * @param {string} message - Empty state explanation
     */
    function showUnavailable(signature, title, message) {
        clearComputedState();
        state.loadedSignature = signature;
        setEmptyState(title, message);
        showMessagesLoading(false);
    }

    /**
     * Find the stored messages and connections file metadata, from the cache
     * when it has them and from storage otherwise.
     * @returns {Promise<{messagesFile: StoredUploadFile|null, connectionsFile: StoredUploadFile|null}>}
     */
    async function resolveStoredFiles() {
        let messagesFile = normalizeStoredFile(
            DataCache.get("storage:file:messages") || null,
            "messages",
        );
        let connectionsFile = normalizeStoredFile(
            DataCache.get("storage:file:connections") || null,
            "connections",
        );
        let files = /** @type {CachedFileMetadata[]|null} */ (
            DataCache.get("storage:files") || null
        );

        if (!messagesFile || !connectionsFile) {
            if (!files) {
                // Cache metadata only. Read an upload when the Messages
                // page needs to parse it.
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
                    DataCache.set("storage:file:connections", toStoredFileMetadata(connectionsFile));
                }
            }
        }
        return { messagesFile, connectionsFile };
    }

    /**
     * Show the state computed for this dataset earlier in the session.
     * @param {CachedMessagesState} cachedState - Cached page state
     * @param {string} signature - Dataset signature
     */
    function applyCachedState(cachedState, signature) {
        state.messageState = cachedState.messageState;
        state.connectionState = cachedState.connectionState;
        state.connectionLoadError = cachedState.connectionLoadError;
        state.hasConnectionsFile = cachedState.hasConnectionsFile;
        state.totalInputRows = Number.isFinite(cachedState.totalInputRows)
            ? cachedState.totalInputRows
            : 0;
        state.loadedSignature = signature;
    }

    /**
     * Read the uploads the worker will parse. Workers read the Blobs. The
     * small-file fallback reads text on the page when the worker cannot answer.
     * @param {boolean} hasConnectionsFile - Whether connections metadata exists
     * @returns {Promise<{messagesBlob: Blob, connectionsBlob: Blob|null, connectionsFileMissing: boolean}>}
     */
    async function readUploads(hasConnectionsFile) {
        const [messagesStored, connectionsStored] = await Promise.all([
            Storage.getFile("messages"),
            hasConnectionsFile ? Storage.getFile("connections") : Promise.resolve(null),
        ]);
        const messagesBlob = messagesStored ? messagesStored.blob : null;
        if (!messagesBlob) {
            // The metadata says messages.csv exists but its contents are
            // gone (cleared in another tab or degraded persistence). Treat
            // the missing payload as a load failure so the UI enters the
            // storage-error path instead of a misleading "parsing error".
            throw new Error("Stored messages file record is missing.");
        }
        const connectionsBlob = connectionsStored ? connectionsStored.blob : null;
        // Connections is optional, but if its metadata is present while the
        // file record is missing, flag it as a load error rather than
        // silently dropping the connections insights.
        const connectionsFileMissing = hasConnectionsFile && !connectionsBlob;
        return { messagesBlob, connectionsBlob, connectionsFileMissing };
    }

    /**
     * Parse the stored uploads, then show the result.
     * @param {string} signature - Dataset signature
     * @param {boolean} hasConnectionsFile - Whether connections metadata exists
     */
    async function parseAndRender(signature, hasConnectionsFile) {
        const { messagesBlob, connectionsBlob, connectionsFileMissing } =
            await readUploads(hasConnectionsFile);

        const endParse = startPerformanceSpan("messages:worker-parse");
        const processed = await processFiles(messagesBlob, connectionsBlob);
        endParse();

        if (!processed.success) {
            showUnavailable(
                signature,
                "Messages parsing error",
                processed.error || "Unable to parse messages.csv. Re-upload the file and try again.",
            );
            return;
        }

        const messagesData = processed.messagesData || [];
        state.totalInputRows = Number.isFinite(processed.totalInputRows)
            ? /** @type {number} */ (processed.totalInputRows)
            : messagesData.length;
        if (processed.messageState) {
            state.messageState = hydrateMessageState(processed.messageState);
        } else {
            state.messageState = buildMessageState(messagesData);
        }
        if (!state.messageState.events.timestamps.length) {
            showUnavailable(
                signature,
                "No usable message rows",
                "The file loaded, but no valid message rows were found for analysis.",
            );
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
            (connectionsFileMissing
                ? "Unable to load Connections.csv. Re-upload the file and try again."
                : null);

        state.loadedSignature = signature;
        cacheComputedState(signature);
        renderAndFinish();
    }

    /** Load messages and connections files from IndexedDB. */
    async function loadData() {
        showMessagesLoading(true);
        const endIdbRead = startPerformanceSpan("messages:idb-read");

        try {
            await Session.waitForCleanup();
            const { messagesFile, connectionsFile } = await resolveStoredFiles();
            endIdbRead();
            state.hasConnectionsFile = Boolean(connectionsFile);

            const signature = buildDataSignature(messagesFile, connectionsFile);
            if (signature === state.loadedSignature && state.messageState) {
                renderAndFinish();
                return;
            }

            if (!messagesFile) {
                showUnavailable(
                    signature,
                    "No messages data available yet",
                    "Upload messages.csv on the Home page to unlock messaging insights.",
                );
                return;
            }

            const cachedState = getCachedState(signature);
            if (cachedState) {
                applyCachedState(cachedState, signature);
                renderAndFinish();
                return;
            }

            await nextFrame();
            await parseAndRender(signature, Boolean(connectionsFile));
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
     * @param {unknown} file - Raw stored file record
     * @param {'messages'|'connections'} expectedType - Expected file type
     * @returns {StoredUploadFile|null}
     */
    function normalizeStoredFile(file, expectedType) {
        if (!file) {
            return null;
        }

        const parsed = parseStoredUploadFile(file);
        if (!parsed.valid) {
            // invalid() returns an error string. Keep the fallback for malformed stored data.
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
     * @returns {CachedMessagesState|null}
     */
    function getCachedState(signature) {
        return /** @type {CachedMessagesState|null} */ (
            DataCache.get(`messages:state:${signature}`) || null
        );
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
            totalInputRows: state.totalInputRows,
        });
    }

    /** Clear computed data after a missing or unusable messages dataset. */
    function clearComputedState() {
        state.messageState = null;
        state.connectionState = null;
        state.connectionLoadError = null;
        state.totalInputRows = 0;
        state.currentLists = {
            topContacts: [],
            silentConnections: [],
            fadingConversations: [],
        };
    }

    /**
     * Build message analytics state from cleaned rows.
     * @param {MessageRow[]} rows - Cleaned message rows
     * @returns {MessageState}
     */
    function buildMessageState(rows) {
        const endBuild = startPerformanceSpan("messages:build-state");
        const result = MessagesAnalytics.buildMessageState(rows);
        endBuild();
        return result;
    }

    /**
     * Build connections lookup state from cleaned rows.
     * @param {ConnectionRow[]} rows - Cleaned connections rows
     * @returns {ConnectionState}
     */
    function buildConnectionState(rows) {
        const endBuild = startPerformanceSpan("messages:build-connections");
        const result = MessagesAnalytics.buildConnectionState(rows);
        endBuild();
        return result;
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

        const { connectionState } = state;
        const hasConnections = connectionState && connectionState.list.length > 0;
        const silentConnections = hasConnections
            ? getSilentConnections(state.messageState, connectionState)
            : [];
        const fadingConversations = hasConnections
            ? getFadingConversations(state.messageState, connectionState)
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
            // hasConnections implies a connection list. Keep the optional access for malformed state.
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
     * @param {OutreachSummary|null} outreach - Outreach summary from the message state
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
     * Fill a list with message items, or with the reason it has none.
     * @template T
     * @param {HTMLElement} listElement - List to fill
     * @param {T[]} items - Items to show
     * @param {object} options - What to show for each state
     * @param {string|null} options.unavailableReason - Why the list cannot be built, shown instead of items
     * @param {string} options.emptyMessage - Shown when there are no items
     * @param {(item: T) => {name: string, url: string, meta: string, value: string}} options.toItem - Maps an item to its row
     */
    function renderItemList(listElement, items, { unavailableReason, emptyMessage, toItem }) {
        if (unavailableReason) {
            renderEmptyList(listElement, unavailableReason);
            return;
        }
        if (!items.length) {
            renderEmptyList(listElement, emptyMessage);
            return;
        }

        const fragment = document.createDocumentFragment();
        items.forEach((item) => {
            fragment.appendChild(createMessageItem(toItem(item)));
        });
        listElement.replaceChildren(fragment);
    }

    /**
     * Render top contacts list.
     * @param {RangeContact[]} items - Top contacts
     */
    function renderTopContacts(items) {
        const listElement = elements.topContactsList;
        // The static shell includes this list. Keep the guard for incomplete DOM setup.
        /* v8 ignore next 3 */
        if (!listElement) {
            return;
        }
        renderItemList(listElement, items, {
            unavailableReason: null,
            emptyMessage: "No conversations in this range yet.",
            toItem: (item) => ({
                name: item.name,
                url: item.url,
                meta: `Last message: ${formatShortDate(item.lastTimestamp)}`,
                value: `${item.count} msgs`,
            }),
        });
    }

    /**
     * Render silent connections list.
     * @param {Connection[]} items - Silent connection rows
     */
    function renderSilentConnections(items) {
        const listElement = elements.silentConnectionsList;
        // The static shell includes this list. Keep the guard for incomplete DOM setup.
        /* v8 ignore next 3 */
        if (!listElement) {
            return;
        }
        renderItemList(listElement, items, {
            unavailableReason: getConnectionsUnavailableMessage("silent"),
            emptyMessage: "Great job. Every connection has at least one message.",
            toItem: (item) => {
                const roleMeta = [item.position, item.company].filter(Boolean).join(" @ ");
                const connectedOn = item.connectedOnTimestamp
                    ? formatShortDate(item.connectedOnTimestamp)
                    : "No date";
                return {
                    name: item.name,
                    url: item.url,
                    meta: roleMeta || "No role info",
                    value: connectedOn,
                };
            },
        });
    }

    /**
     * Render fading conversations list.
     * @param {FadingConversation[]} items - Fading conversation rows
     */
    function renderFadingConversations(items) {
        const listElement = elements.fadingConversationsList;
        // The static shell includes this list. Keep the guard for incomplete DOM setup.
        /* v8 ignore next 3 */
        if (!listElement) {
            return;
        }
        renderItemList(listElement, items, {
            unavailableReason: getConnectionsUnavailableMessage("fading"),
            emptyMessage: "No fading conversations in your connected network.",
            toItem: (item) => ({
                name: item.name,
                url: item.url,
                meta: `Last message: ${formatShortDate(item.lastTimestamp)}`,
                value: `${item.daysSince} days`,
            }),
        });
    }

    /**
     * Add the asterisk and popup that explain how many rows the analysis left out.
     * @param {HTMLElement} container - Stat value to append the note to
     * @param {Element|null} card - Stat card to mark while the popup is open
     * @param {string} message - Popup text
     */
    function attachSkippedRowsNote(container, card, message) {
        const popupId = "msgSkippedPopup";

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
        popup.textContent = message;

        container.appendChild(asterisk);
        container.appendChild(popup);

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
        // The static shell includes these stat cells. Keep the guard for incomplete DOM setup.
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
            attachSkippedRowsNote(
                msgStatMessages,
                card,
                `${skipped} of ${state.totalInputRows} cleaned rows were excluded from analysis (self-messages, anonymous contacts, or unparseable dates)`,
            );
        }
        msgStatContacts.textContent = String(topSummary.totalPeople);
        msgStatConnected.textContent = String(totalConnections);
        msgStatFading.textContent = String(fadingCount);
    }

    /**
     * Update tip text.
     * @param {RangeContact[]} topContacts - Top contacts list
     * @param {Connection[]} silentConnections - Silent connections list
     * @param {FadingConversation[]} fadingConversations - Fading conversations list
     */
    function updateTip(topContacts, silentConnections, fadingConversations) {
        const { messagesTip, messagesTipText } = elements;
        // The static shell includes these tip elements. Keep the guard for incomplete DOM setup.
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
     * Build a contextual tip string. Pip speaks the tip on screen, so every
     * branch stays in his first-person voice.
     * @param {RangeContact[]} topContacts - Top contacts list
     * @param {Connection[]} silentConnections - Silent connections list
     * @param {FadingConversation[]} fadingConversations - Fading conversations list
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
            // A conversation is only fading after thirty quiet days, so the day
            // count here is never one.
            return `${top.name} is your liveliest thread. I would say hello to ${fading.name} too, quiet for ${fading.daysSince} days now.`;
        }

        if (top) {
            return `${top.name} is your top contact in this range. I would keep that rhythm going.`;
        }

        if (silentConnections.length) {
            const people = silentConnections.length === 1 ? "connection" : "connections";
            return `I count ${silentConnections.length} silent ${people}. One short hello can wake the list up.`;
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
            // Pip reads the tip out, so this one is in his voice.
            tip: "Upload Connections.csv and I can point out who has gone quiet on you.",
        };

        if (!state.hasConnectionsFile) {
            // section is a known key in normal calls. Use the tip message for malformed input.
            /* v8 ignore next */
            return missingFileMessages[section] || missingFileMessages.tip;
        }
        if (state.connectionLoadError) {
            return state.connectionLoadError;
        }
        return null;
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
     * @param {Record<string, unknown>[]} rows - Export rows
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
        // Export rows use the same keys. Keep an empty cell for malformed rows.
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

        /** @type {Array<[HTMLButtonElement|null, unknown[]]>} */
        const buttons = [
            [elements.topContactsExportBtn, state.currentLists.topContacts],
            [elements.silentConnectionsExportBtn, state.currentLists.silentConnections],
            [elements.fadingConversationsExportBtn, state.currentLists.fadingConversations],
        ];
        for (const [button, list] of buttons) {
            if (button) {
                button.disabled = !(exportReady && list.length);
            }
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
        // The static shell includes both containers. Keep the guard for incomplete DOM setup.
        /* v8 ignore next 3 */
        if (!messagesEmpty || !messagesLayout) {
            return;
        }
        setEmptyStateText(messagesEmpty, title, message);
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
        // The static shell includes both containers. Keep the guard for incomplete DOM setup.
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
        // The static shell includes both containers. Keep the guard for incomplete DOM setup.
        /* v8 ignore next 3 */
        if (!messagesEmpty || !messagesLayout) {
            return;
        }
        messagesEmpty.hidden = true;
        messagesLayout.hidden = false;
        if (elements.messagesTip) {
            elements.messagesTip.hidden = true;
        }

        if (elements.topContactsList) {
            elements.topContactsList.innerHTML = SKELETON_ITEM.repeat(3);
        }
        if (elements.silentConnectionsList) {
            elements.silentConnectionsList.innerHTML = SKELETON_ITEM.repeat(3);
        }
        if (elements.fadingConversationsList) {
            elements.fadingConversationsList.innerHTML = SKELETON_ITEM.repeat(3);
        }
    }

    return {
        init,
        onRouteChange,
        onRouteLeave,
    };
})();
