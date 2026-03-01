/* Messages insights page logic */
/* exported MessagesPage */

const MessagesPage = (() => {
    'use strict';

    const FILTER_DEFAULTS = Object.freeze({
        timeRange: '12m'
    });
    const RANGE_MONTHS = Object.freeze({
        '1m': 1,
        '3m': 3,
        '6m': 6,
        '12m': 12
    });
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const MESSAGES_WORKER_URL = 'js/messages-worker.js?v=20260228-1';

    const SHORT_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: '2-digit',
        year: 'numeric'
    });

    const elements = {
        timeRangeButtons: document.querySelectorAll('#messagesTimeRangeButtons .filter-btn'),
        resetFiltersBtn: document.getElementById('messagesResetFiltersBtn'),
        topContactsExportBtn: document.getElementById('topContactsExportBtn'),
        silentConnectionsExportBtn: document.getElementById('silentConnectionsExportBtn'),
        fadingConversationsExportBtn: document.getElementById('fadingConversationsExportBtn'),
        messagesEmpty: document.getElementById('messagesEmpty'),
        messagesLayout: document.getElementById('messagesLayout'),
        topContactsList: document.getElementById('topContactsList'),
        silentConnectionsList: document.getElementById('silentConnectionsList'),
        fadingConversationsList: document.getElementById('fadingConversationsList'),
        msgStatMessages: document.getElementById('msgStatMessages'),
        msgStatContacts: document.getElementById('msgStatContacts'),
        msgStatConnected: document.getElementById('msgStatConnected'),
        msgStatFading: document.getElementById('msgStatFading'),
        messagesTip: document.getElementById('messagesTip'),
        messagesTipText: document.getElementById('messagesTipText')
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
            fadingConversations: []
        }
    };

    let initialized = false;
    let isApplyingRouteParams = false;
    let parseWorker = null;
    let parseWorkerRequestId = 0;

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
            if (!initialized) {
                return;
            }
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
        elements.timeRangeButtons.forEach(button => {
            button.addEventListener('click', () => handleTimeRangeChange(button));
            button.setAttribute('aria-pressed', button.classList.contains('active') ? 'true' : 'false');
        });
        elements.resetFiltersBtn.addEventListener('click', resetFilters);
        if (elements.topContactsExportBtn) {
            elements.topContactsExportBtn.addEventListener('click', exportTopContacts);
        }
        if (elements.silentConnectionsExportBtn) {
            elements.silentConnectionsExportBtn.addEventListener('click', exportSilentConnections);
        }
        if (elements.fadingConversationsExportBtn) {
            elements.fadingConversationsExportBtn.addEventListener('click', exportFadingConversations);
        }

        window.addEventListener('beforeunload', terminateWorker);
        window.addEventListener('pagehide', terminateWorker);

        updateExportButtonStates();
    }

    /** Initialize background worker for messages/connections parsing. */
    function initWorker() {
        if (parseWorker || typeof Worker === 'undefined') {
            return;
        }

        try {
            parseWorker = new Worker(MESSAGES_WORKER_URL);
        } catch {
            parseWorker = null;
        }
    }

    /** Terminate messages parsing worker. */
    function terminateWorker() {
        if (!parseWorker) {
            return;
        }
        parseWorker.terminate();
        parseWorker = null;
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

        return new Promise(resolve => {
            const handleMessage = (event) => {
                const message = event.data || {};
                if (message.type !== 'processed' || message.requestId !== requestId) {
                    return;
                }
                cleanup();
                resolve(message.payload || null);
            };

            const handleError = () => {
                cleanup();
                terminateWorker();
                resolve(null);
            };

            const cleanup = () => {
                if (!parseWorker) {
                    return;
                }
                parseWorker.removeEventListener('message', handleMessage);
                parseWorker.removeEventListener('error', handleError);
            };

            try {
                parseWorker.addEventListener('message', handleMessage);
                parseWorker.addEventListener('error', handleError);
                parseWorker.postMessage({
                    type: 'process',
                    requestId,
                    payload: {
                        messagesCsv,
                        connectionsCsv
                    }
                });
            } catch {
                cleanup();
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
        const messagesResult = LinkedInCleaner.process(messagesCsv, 'messages');
        if (!messagesResult.success) {
            return {
                success: false,
                error: messagesResult.error || 'Unable to parse messages.csv.'
            };
        }

        let connectionsData = [];
        let connectionError = null;

        if (connectionsCsv) {
            const connectionsResult = LinkedInCleaner.process(connectionsCsv, 'connections');
            if (connectionsResult.success) {
                connectionsData = connectionsResult.cleanedData;
            } else {
                connectionError = connectionsResult.error || 'Unable to parse Connections.csv.';
            }
        }

        return {
            success: true,
            messagesData: messagesResult.cleanedData,
            connectionsData,
            connectionError
        };
    }

    /** Load messages and connections files from IndexedDB. */
    async function loadData() {
        showMessagesLoading(true);

        let files = null;
        if (typeof DataCache !== 'undefined') {
            files = DataCache.get('storage:files') || null;
        }

        if (!files) {
            files = await Storage.getAllFiles();
            if (typeof DataCache !== 'undefined') {
                DataCache.set('storage:files', files);
            }
        }

        const messagesFile = files.find(file => file.type === 'messages') || null;
        const connectionsFile = files.find(file => file.type === 'connections') || null;
        state.hasConnectionsFile = Boolean(connectionsFile);

        const signature = buildDataSignature(messagesFile, connectionsFile);
        if (signature === state.loadedSignature && state.messageState) {
            renderView();
            showMessagesLoading(false);
            return;
        }

        if (!messagesFile) {
            state.loadedSignature = signature;
            setEmptyState(
                'No messages data available yet',
                'Upload messages.csv on the Home page to unlock messaging insights.'
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
            renderView();
            showMessagesLoading(false);
            return;
        }

        await nextFrame();

        const processed = await processFiles(
            messagesFile.text,
            connectionsFile ? connectionsFile.text : ''
        );

        if (!processed.success) {
            state.loadedSignature = signature;
            setEmptyState(
                'Messages parsing error',
                processed.error || 'Unable to parse messages.csv. Re-upload the file and try again.'
            );
            showMessagesLoading(false);
            return;
        }

        const messagesData = processed.messagesData || [];
        state.totalInputRows = messagesData.length;
        state.messageState = buildMessageState(messagesData);
        if (!state.messageState.events.length) {
            state.loadedSignature = signature;
            setEmptyState(
                'No usable message rows',
                'The file loaded, but no valid message rows were found for analysis.'
            );
            showMessagesLoading(false);
            return;
        }

        state.connectionState = buildConnectionState(processed.connectionsData || []);
        state.connectionLoadError = processed.connectionError || null;

        state.loadedSignature = signature;
        cacheComputedState(signature);
        renderView();
        showMessagesLoading(false);
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
            const name = file.name || 'unknown';
            return `${type}:${name}:${updatedAt}:${rowCount}`;
        };

        return [toPart(messagesFile, 'messages'), toPart(connectionsFile, 'connections')].join('|');
    }

    /**
     * Read computed analytics state from in-memory cache.
     * @param {string} signature - Dataset signature
     * @returns {object|null}
     */
    function getCachedState(signature) {
        if (typeof DataCache === 'undefined') {
            return null;
        }
        return DataCache.get(`messages:state:${signature}`) || null;
    }

    /**
     * Persist computed analytics state in in-memory cache.
     * @param {string} signature - Dataset signature
     */
    function cacheComputedState(signature) {
        if (typeof DataCache === 'undefined') {
            return;
        }
        DataCache.set(`messages:state:${signature}`, {
            messageState: state.messageState,
            connectionState: state.connectionState,
            hasConnectionsFile: state.hasConnectionsFile,
            connectionLoadError: state.connectionLoadError
        });
    }

    /**
     * Yield one frame so loading overlay can paint before heavy parsing.
     * @returns {Promise<void>}
     */
    function nextFrame() {
        return new Promise(resolve => {
            requestAnimationFrame(() => resolve());
        });
    }

    /**
     * Handle click on a time range button.
     * @param {HTMLElement} button - Clicked time range button
     */
    function handleTimeRangeChange(button) {
        const range = button.getAttribute('data-range');
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
        elements.timeRangeButtons.forEach(button => {
            const isActive = button.getAttribute('data-range') === range;
            button.classList.toggle('active', isActive);
            button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        });
    }

    /**
     * Parse route range query value.
     * @param {string} value - Raw route value
     * @returns {string}
     */
    function parseRangeParam(value) {
        const range = String(value || '').toLowerCase();
        return (RANGE_MONTHS[range] || range === 'all') ? range : FILTER_DEFAULTS.timeRange;
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
        if (isApplyingRouteParams || typeof AppRouter === 'undefined') {
            return;
        }
        const currentRoute = AppRouter.getCurrentRoute();
        if (!currentRoute || currentRoute.name !== 'messages') {
            return;
        }
        AppRouter.setParams({ range: state.filters.timeRange }, { replaceHistory: false });
    }

    /** Build message analytics state from cleaned rows. */
    function buildMessageState(rows) {
        const context = detectSelfContext(rows);
        const contacts = new Map();
        const events = [];
        const rowTimestamps = [];
        const talkedNameKeys = new Set();
        const talkedUrlKeys = new Set();

        let latestTimestamp = 0;
        let skippedRows = 0;
        rows.forEach(row => {
            const date = parseDateTime(row.DATE);
            if (!date) {
                skippedRows += 1;
                return;
            }
            const timestamp = date.getTime();
            const participants = extractParticipantsFromRow(row, context);
            if (!participants.length) {
                skippedRows += 1;
                return;
            }

            rowTimestamps.push(timestamp);

            participants.forEach(contact => {
                const contactKey = buildContactKey(contact);
                const existing = contacts.get(contactKey);
                if (existing) {
                    existing.count += 1;
                    existing.lastTimestamp = Math.max(existing.lastTimestamp, timestamp);
                    if (!existing.url && contact.url) {
                        existing.url = contact.url;
                    }
                    if (contact.name && !isAnonymousName(contact.name)) {
                        existing.name = contact.name;
                    }
                } else {
                    contacts.set(contactKey, {
                        key: contactKey,
                        name: contact.name || 'Unknown',
                        url: contact.url,
                        count: 1,
                        lastTimestamp: timestamp
                    });
                }

                const nameKey = normalizeName(contact.name);
                if (nameKey) {
                    talkedNameKeys.add(nameKey);
                }
                if (contact.url) {
                    talkedUrlKeys.add(contact.url);
                }

                events.push({ contactKey, timestamp });
            });

            latestTimestamp = Math.max(latestTimestamp, timestamp);
        });

        return {
            contacts,
            events,
            rowTimestamps,
            skippedRows,
            talkedNameKeys,
            talkedUrlKeys,
            latestTimestamp
        };
    }

    /** Build connections lookup state from cleaned rows. */
    function buildConnectionState(rows) {
        const list = [];
        const byUrl = new Map();
        const byName = new Map();

        rows.forEach(row => {
            const firstName = cleanText(row['First Name']);
            const lastName = cleanText(row['Last Name']);
            const fullName = `${firstName} ${lastName}`.trim();
            const nameKey = normalizeName(fullName);
            const url = normalizeUrl(row.URL);
            const connectedOnDate = parseDateOnly(row['Connected On']);
            const company = cleanText(row.Company);
            const position = cleanText(row.Position);

            if (!fullName && !url) {
                return;
            }

            const connection = {
                name: fullName || url,
                nameKey,
                url,
                company,
                position,
                connectedOnTimestamp: connectedOnDate ? connectedOnDate.getTime() : null
            };

            list.push(connection);
            if (url && !byUrl.has(url)) {
                byUrl.set(url, connection);
            }
            if (nameKey && !byName.has(nameKey)) {
                byName.set(nameKey, connection);
            }
        });

        return { list, byUrl, byName };
    }

    /** Detect likely self identity using cross-conversation participation. */
    function detectSelfContext(rows) {
        const urlStats = new Map();
        const nameStats = new Map();

        rows.forEach((row, index) => {
            const conversationKey = buildConversationKey(row, index);
            const senderUrl = normalizeUrl(row['SENDER PROFILE URL']);
            const recipientUrls = normalizeUrlList(row['RECIPIENT PROFILE URLS']);
            const senderName = normalizeName(row.FROM);

            recordParticipantStat(urlStats, senderUrl, conversationKey, 'sender');
            recipientUrls.forEach(url => {
                recordParticipantStat(urlStats, url, conversationKey, 'recipient');
            });
            recordParticipantStat(nameStats, senderName, conversationKey, 'sender');

            const recipientNames = parseRecipientNames(row.TO, recipientUrls.length);
            if (recipientUrls.length) {
                recipientUrls.forEach((_, recipientIndex) => {
                    const recipientName = normalizeName(
                        recipientNames[recipientIndex] || recipientNames[0] || ''
                    );
                    recordParticipantStat(nameStats, recipientName, conversationKey, 'recipient');
                });
                return;
            }

            recipientNames.forEach(name => {
                recordParticipantStat(nameStats, normalizeName(name), conversationKey, 'recipient');
            });
        });

        const selfUrl = pickSelfKey(urlStats);
        const selfUrls = new Set();
        if (selfUrl) {
            selfUrls.add(selfUrl);
        }

        const selfNames = new Set();
        if (selfUrl) {
            const nameCounts = collectNamesForUrl(rows, selfUrl);
            const primaryName = pickMostFrequentKey(nameCounts);
            if (primaryName) {
                selfNames.add(primaryName);
            }
            return { selfUrls, selfNames };
        }

        const selfName = pickSelfKey(nameStats);
        if (selfName) {
            selfNames.add(selfName);
        }

        return { selfUrls, selfNames };
    }

    /**
     * Build a stable conversation key for participation scoring.
     * @param {object} row - Message row
     * @param {number} rowIndex - Row index fallback
     * @returns {string}
     */
    function buildConversationKey(row, rowIndex) {
        const conversationId = cleanText(row['CONVERSATION ID']);
        return conversationId || `row-${rowIndex}`;
    }

    /**
     * Record sender/recipient participation metrics for a candidate key.
     * @param {Map<string, object>} statsMap - Aggregated stats map
     * @param {string} key - Candidate key (URL or normalized name)
     * @param {string} conversationKey - Conversation identifier
     * @param {'sender'|'recipient'} role - Message-side role
     */
    function recordParticipantStat(statsMap, key, conversationKey, role) {
        if (!key) {
            return;
        }

        const existing = statsMap.get(key);
        if (existing) {
            existing.totalCount += 1;
            existing.conversations.add(conversationKey);
            if (role === 'sender') {
                existing.senderCount += 1;
            } else {
                existing.recipientCount += 1;
            }
            return;
        }

        statsMap.set(key, {
            totalCount: 1,
            senderCount: role === 'sender' ? 1 : 0,
            recipientCount: role === 'recipient' ? 1 : 0,
            conversations: new Set([conversationKey])
        });
    }

    /**
     * Select likely self key from participation stats.
     * Candidate must appear on both sender and recipient sides.
     * @param {Map<string, object>} statsMap - URL or name stats
     * @returns {string|null}
     */
    function pickSelfKey(statsMap) {
        let bestBalancedKey = null;
        let bestBalancedConversationCount = -1;
        let bestBalancedTotalCount = -1;

        let bestCoverageKey = null;
        let bestCoverageConversationCount = -1;
        let bestCoverageTotalCount = -1;

        statsMap.forEach((stats, key) => {
            const conversationCount = stats.conversations.size;
            if (conversationCount > bestCoverageConversationCount
                || (conversationCount === bestCoverageConversationCount
                    && stats.totalCount > bestCoverageTotalCount)) {
                bestCoverageKey = key;
                bestCoverageConversationCount = conversationCount;
                bestCoverageTotalCount = stats.totalCount;
            }

            if (!stats.senderCount || !stats.recipientCount) {
                return;
            }

            if (conversationCount > bestBalancedConversationCount) {
                bestBalancedKey = key;
                bestBalancedConversationCount = conversationCount;
                bestBalancedTotalCount = stats.totalCount;
                return;
            }

            if (conversationCount === bestBalancedConversationCount
                && stats.totalCount > bestBalancedTotalCount) {
                bestBalancedKey = key;
                bestBalancedTotalCount = stats.totalCount;
            }
        });

        return bestBalancedKey || bestCoverageKey;
    }

    /**
     * Collect normalized names associated with a selected self URL.
     * @param {object[]} rows - Message rows
     * @param {string} selfUrl - Selected self URL
     * @returns {Map<string, number>}
     */
    function collectNamesForUrl(rows, selfUrl) {
        const nameCounts = new Map();

        rows.forEach(row => {
            const senderUrl = normalizeUrl(row['SENDER PROFILE URL']);
            if (senderUrl === selfUrl) {
                incrementCount(nameCounts, normalizeName(row.FROM));
            }

            const recipientUrls = normalizeUrlList(row['RECIPIENT PROFILE URLS']);
            if (!recipientUrls.length) {
                return;
            }

            const recipientNames = parseRecipientNames(row.TO, recipientUrls.length);
            recipientUrls.forEach((url, recipientIndex) => {
                if (url !== selfUrl) {
                    return;
                }
                const name = normalizeName(recipientNames[recipientIndex] || recipientNames[0] || '');
                incrementCount(nameCounts, name);
            });
        });

        return nameCounts;
    }

    /**
     * Increment a simple string->count map.
     * @param {Map<string, number>} counts - Count map
     * @param {string} key - Key to increment
     */
    function incrementCount(counts, key) {
        if (!key) {
            return;
        }
        counts.set(key, (counts.get(key) || 0) + 1);
    }

    /**
     * Extract non-self participants from a message row.
     * Combines FROM and TO sides and counts each person once per row.
     *
     * @param {object} row - Message row
     * @param {{selfUrls: Set<string>, selfNames: Set<string>}} context - Self context
     * @returns {Array<{name: string, url: string}>}
     */
    function extractParticipantsFromRow(row, context) {
        const participants = [];
        const seenKeys = new Set();

        const sender = {
            name: cleanText(row.FROM),
            url: normalizeUrl(row['SENDER PROFILE URL'])
        };
        addParticipant(sender, participants, seenKeys, context);

        const recipientUrls = normalizeUrlList(row['RECIPIENT PROFILE URLS']);
        const recipientNames = parseRecipientNames(row.TO, recipientUrls.length);
        if (recipientUrls.length) {
            recipientUrls.forEach((url, index) => {
                const name = recipientNames[index] || recipientNames[0] || '';
                addParticipant({ name, url }, participants, seenKeys, context);
            });
        } else {
            recipientNames.forEach(name => {
                addParticipant({ name, url: '' }, participants, seenKeys, context);
            });
        }

        return participants;
    }

    /**
     * Append a participant when valid for analytics.
     * @param {{name: string, url: string}} contact - Contact candidate
     * @param {Array<{name: string, url: string}>} participants - Output array
     * @param {Set<string>} seenKeys - De-dupe keys for this row
     * @param {{selfUrls: Set<string>, selfNames: Set<string>}} context - Self context
     */
    function addParticipant(contact, participants, seenKeys, context) {
        const sanitized = sanitizeParticipant(contact, context);
        if (!sanitized) {
            return;
        }

        const key = buildContactKey(sanitized);
        if (seenKeys.has(key)) {
            return;
        }
        seenKeys.add(key);
        participants.push(sanitized);
    }

    /**
     * Sanitize participant and drop self/anonymous/blank contacts.
     * @param {{name: string, url: string}} contact - Contact candidate
     * @param {{selfUrls: Set<string>, selfNames: Set<string>}} context - Self context
     * @returns {{name: string, url: string}|null}
     */
    function sanitizeParticipant(contact, context) {
        const name = cleanText(contact.name);
        const url = normalizeUrl(contact.url);
        const nameKey = normalizeName(name);

        const isSelf = (url && context.selfUrls.has(url))
            || (nameKey && context.selfNames.has(nameKey));
        if (isSelf) {
            return null;
        }

        if (!name && !url) {
            return null;
        }

        if (isAnonymousName(name)) {
            return null;
        }

        return {
            name: name || 'Unknown',
            url
        };
    }

    /**
     * Check if a name is anonymous placeholder text.
     * @param {string} name - Candidate name
     * @returns {boolean}
     */
    function isAnonymousName(name) {
        return normalizeName(name) === 'linkedin member';
    }

    /**
     * Create a stable key for contact aggregation.
     * @param {{name: string, url: string}} contact - Contact candidate
     * @returns {string}
     */
    function buildContactKey(contact) {
        if (contact.url) {
            return `url:${contact.url}`;
        }
        const nameKey = normalizeName(contact.name);
        return `name:${nameKey || 'unknown'}`;
    }

    /**
     * Aggregate top contacts for the selected range.
     * @param {object} messageState - Message analytics state
     * @param {number|null} rangeStart - Start timestamp for selected range
     * @returns {{items: object[], totalMessages: number, totalRows: number, totalPeople: number}}
     */
    function getTopContactsInRange(messageState, rangeStart) {
        const rangeCounts = new Map();

        messageState.events.forEach(event => {
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
                lastTimestamp: event.timestamp
            });
        });

        const items = Array.from(rangeCounts.entries()).map(([contactKey, metric]) => {
            const base = messageState.contacts.get(contactKey);
            return {
                key: contactKey,
                name: base ? base.name : 'Unknown',
                url: base ? base.url : '',
                count: metric.count,
                lastTimestamp: metric.lastTimestamp
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
                (sum, ts) => sum + (ts >= rangeStart ? 1 : 0), 0
            );
        }
        return {
            items,
            totalMessages,
            totalRows,
            totalPeople: items.length
        };
    }

    /**
     * Get connections that have no messages at all.
     * @param {object} messageState - Message analytics state
     * @param {object} connectionState - Connection state
     * @returns {object[]}
     */
    function getSilentConnections(messageState, connectionState) {
        const silent = connectionState.list.filter(connection => {
            const seenByUrl = connection.url && messageState.talkedUrlKeys.has(connection.url);
            const seenByName = connection.nameKey && messageState.talkedNameKeys.has(connection.nameKey);
            return !(seenByUrl || seenByName);
        });

        silent.sort((left, right) => {
            const leftTs = left.connectedOnTimestamp === null ? Number.POSITIVE_INFINITY : left.connectedOnTimestamp;
            const rightTs = right.connectedOnTimestamp === null ? Number.POSITIVE_INFINITY : right.connectedOnTimestamp;
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

        messageState.contacts.forEach(contact => {
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
                url: contact.url || connection.url || '',
                daysSince,
                lastTimestamp: contact.lastTimestamp,
                company: connection.company
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

        const rangeStart = getRangeStart(state.filters.timeRange, state.messageState.latestTimestamp);
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

        updateStats(topSummary, hasConnections ? state.connectionState.list.length : 0, fadingConversations.length);
        updateTip(topSummary.items, silentConnections, fadingConversations);
    }

    /**
     * Render top contacts list.
     * @param {object[]} items - Top contacts
     */
    function renderTopContacts(items) {
        if (!items.length) {
            renderEmptyList(elements.topContactsList, 'No conversations in this range yet.');
            return;
        }

        elements.topContactsList.innerHTML = items.map(item => `
            <li class="message-item">
                <div class="message-item-main">
                    <p class="message-item-title">${renderContactName(item.name, item.url)}</p>
                    <p class="message-item-meta">Last message: ${escapeHtml(formatShortDate(item.lastTimestamp))}</p>
                </div>
                <span class="message-item-value">${item.count} msgs</span>
            </li>
        `).join('');
    }

    /**
     * Render silent connections list.
     * @param {object[]} items - Silent connection rows
     */
    function renderSilentConnections(items) {
        const unavailableReason = getConnectionsUnavailableMessage('silent');
        if (unavailableReason) {
            renderEmptyList(elements.silentConnectionsList, unavailableReason);
            return;
        }

        if (!items.length) {
            renderEmptyList(elements.silentConnectionsList, 'Great job — every connection has at least one message.');
            return;
        }

        elements.silentConnectionsList.innerHTML = items.map(item => {
            const roleMeta = [item.position, item.company].filter(Boolean).join(' @ ');
            const connectedOn = item.connectedOnTimestamp
                ? formatShortDate(item.connectedOnTimestamp)
                : 'No date';
            return `
                <li class="message-item">
                    <div class="message-item-main">
                        <p class="message-item-title">${renderContactName(item.name, item.url)}</p>
                        <p class="message-item-meta">${escapeHtml(roleMeta || 'No role info')}</p>
                    </div>
                    <span class="message-item-value">${escapeHtml(connectedOn)}</span>
                </li>
            `;
        }).join('');
    }

    /**
     * Render fading conversations list.
     * @param {object[]} items - Fading conversation rows
     */
    function renderFadingConversations(items) {
        const unavailableReason = getConnectionsUnavailableMessage('fading');
        if (unavailableReason) {
            renderEmptyList(elements.fadingConversationsList, unavailableReason);
            return;
        }

        if (!items.length) {
            renderEmptyList(elements.fadingConversationsList, 'No fading conversations in your connected network.');
            return;
        }

        elements.fadingConversationsList.innerHTML = items.map(item => `
            <li class="message-item">
                <div class="message-item-main">
                    <p class="message-item-title">${renderContactName(item.name, item.url)}</p>
                    <p class="message-item-meta">Last message: ${escapeHtml(formatShortDate(item.lastTimestamp))}</p>
                </div>
                <span class="message-item-value">${item.daysSince} days</span>
            </li>
        `).join('');
    }

    /**
     * Update summary stats.
     * @param {{totalMessages: number, totalPeople: number}} topSummary - Top summary
     * @param {number} totalConnections - Total number of connections
     * @param {number} fadingCount - Number of fading conversations
     */
    function updateStats(topSummary, totalConnections, fadingCount) {
        const card = elements.msgStatMessages.closest('.stat-card');
        if (card) card.classList.remove('popup-active');

        const skipped = state.messageState ? state.messageState.skippedRows : 0;
        if (skipped > 0) {
            const popupId = 'msgSkippedPopup';
            const msg = `${skipped} of ${state.totalInputRows} cleaned rows were excluded from analysis (self-messages, anonymous contacts, or unparseable dates)`;
            elements.msgStatMessages.innerHTML =
                `${topSummary.totalRows}<span class="stat-asterisk" role="button" tabindex="0" aria-label="Show excluded row details" aria-describedby="${popupId}">*</span>` +
                `<span class="stat-popup" role="tooltip" id="${popupId}" aria-hidden="true">${msg}</span>`;
            const asterisk = elements.msgStatMessages.querySelector('.stat-asterisk');
            const popup = elements.msgStatMessages.querySelector('.stat-popup');

            function showPopup() { popup.classList.add('visible'); popup.setAttribute('aria-hidden', 'false'); if (card) card.classList.add('popup-active'); }
            function hidePopup() { popup.classList.remove('visible'); popup.setAttribute('aria-hidden', 'true'); if (card) card.classList.remove('popup-active'); }
            function togglePopup() { if (popup.classList.contains('visible')) { hidePopup(); } else { showPopup(); } }

            asterisk.addEventListener('mouseenter', showPopup);
            asterisk.addEventListener('mouseleave', hidePopup);
            asterisk.addEventListener('click', togglePopup);
            asterisk.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') { hidePopup(); }
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePopup(); }
            });
            asterisk.addEventListener('focusout', hidePopup);
        } else {
            elements.msgStatMessages.textContent = String(topSummary.totalRows);
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
        const unavailableReason = getConnectionsUnavailableMessage('tip');
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
            silent: 'Upload Connections.csv to view silent connections.',
            fading: 'Upload Connections.csv to identify fading conversations.',
            tip: 'Upload Connections.csv to unlock silent and fading relationship insights.'
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
        listElement.innerHTML = `<li class="message-empty">${escapeHtml(message)}</li>`;
    }

    /**
     * Render a contact name as link if URL exists.
     * @param {string} name - Contact name
     * @param {string} url - LinkedIn URL
     * @returns {string}
     */
    function renderContactName(name, url) {
        const safeName = escapeHtml(name || 'Unknown');
        const safeUrl = cleanText(url);
        if (!safeUrl) {
            return safeName;
        }
        return `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${safeName}</a>`;
    }

    /** Export top contacts panel data. */
    function exportTopContacts() {
        const rows = state.currentLists.topContacts.map(item => ({
            Name: item.name,
            'LinkedIn URL': toLinkedInCell(item.url),
            Messages: item.count,
            'Last Message': formatShortDate(item.lastTimestamp)
        }));
        downloadExport('top-contacts', 'Top Contacts', rows);
    }

    /** Export silent connections panel data. */
    function exportSilentConnections() {
        const rows = state.currentLists.silentConnections.map(item => ({
            Name: item.name,
            'LinkedIn URL': toLinkedInCell(item.url),
            'Connected On': item.connectedOnTimestamp ? formatShortDate(item.connectedOnTimestamp) : '',
            Position: item.position || '',
            Company: item.company || ''
        }));
        downloadExport('silent-connections', 'Silent Connections', rows);
    }

    /** Export fading conversations panel data. */
    function exportFadingConversations() {
        const rows = state.currentLists.fadingConversations.map(item => ({
            Name: item.name,
            'LinkedIn URL': toLinkedInCell(item.url),
            'Days Since Last Message': item.daysSince,
            'Last Message': formatShortDate(item.lastTimestamp),
            Company: item.company || ''
        }));
        downloadExport('fading-conversations', 'Fading Conversations', rows);
    }

    /**
     * Convert a URL string to an export cell with hyperlink metadata.
     * @param {string} url - LinkedIn profile URL
     * @returns {string|{value: string, hyperlink: string}}
     */
    function toLinkedInCell(url) {
        const value = cleanText(url);
        if (!value) {
            return '';
        }
        return {
            value,
            hyperlink: value
        };
    }

    /**
     * Download rows as Excel file using export spec.
     * @param {string} filePrefix - File prefix
     * @param {string} sheetName - Worksheet name
     * @param {object[]} rows - Export rows
     */
    function downloadExport(filePrefix, sheetName, rows) {
        if (!rows.length) {
            return;
        }
        if (typeof ExcelGenerator === 'undefined' || typeof ExcelGenerator.downloadFromSpec !== 'function') {
            return;
        }

        const headers = Object.keys(rows[0]);
        const orderedRows = rows.map(row => headers.map(header => row[header] ?? ''));
        ExcelGenerator.downloadFromSpec(
            {
                sheetName,
                headers,
                rows: orderedRows
            },
            `messages-${filePrefix}.xlsx`
        );
    }

    /** Enable/disable export buttons based on availability and list content. */
    function updateExportButtonStates() {
        const exportReady = typeof ExcelGenerator !== 'undefined' && typeof ExcelGenerator.downloadFromSpec === 'function';

        if (elements.topContactsExportBtn) {
            elements.topContactsExportBtn.disabled = !(exportReady && state.currentLists.topContacts.length);
        }
        if (elements.silentConnectionsExportBtn) {
            elements.silentConnectionsExportBtn.disabled = !(exportReady && state.currentLists.silentConnections.length);
        }
        if (elements.fadingConversationsExportBtn) {
            elements.fadingConversationsExportBtn.disabled = !(exportReady && state.currentLists.fadingConversations.length);
        }
    }

    /**
     * Get range start timestamp from the selected range.
     * @param {string} range - Range key
     * @param {number} latestTimestamp - Latest message timestamp
     * @returns {number|null}
     */
    function getRangeStart(range, latestTimestamp) {
        if (range === 'all') {
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
            0
        ).getTime();
    }

    /**
     * Parse local datetime string in YYYY-MM-DD HH:MM:SS format.
     * @param {string} value - Date string
     * @returns {Date|null}
     */
    function parseDateTime(value) {
        const text = cleanText(value);
        if (!text) {
            return null;
        }
        const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
        if (!match) {
            return null;
        }

        const year = Number(match[1]);
        const month = Number(match[2]);
        const day = Number(match[3]);
        const hour = Number(match[4] || 0);
        const minute = Number(match[5] || 0);
        const second = Number(match[6] || 0);

        const parsed = new Date(year, month - 1, day, hour, minute, second);
        if (Number.isNaN(parsed.getTime())) {
            return null;
        }
        return parsed;
    }

    /**
     * Parse date-only string in YYYY-MM-DD format.
     * @param {string} value - Date string
     * @returns {Date|null}
     */
    function parseDateOnly(value) {
        const text = cleanText(value);
        const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!match) {
            return null;
        }
        const parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
        if (Number.isNaN(parsed.getTime())) {
            return null;
        }
        return parsed;
    }

    /**
     * Parse recipient names from TO field.
     * Uses URL count to avoid splitting single names that contain commas.
     *
     * @param {string} value - Raw TO field
     * @param {number} recipientUrlCount - Parsed recipient URL count
     * @returns {string[]}
     */
    function parseRecipientNames(value, recipientUrlCount) {
        const text = cleanText(value);
        if (!text) {
            return [];
        }

        if (recipientUrlCount <= 1) {
            return [text];
        }

        return text.split(',').map(part => part.trim()).filter(Boolean);
    }

    /**
     * Normalize URL values and extract first LinkedIn URL.
     * @param {string} value - Raw URL field
     * @returns {string}
     */
    function normalizeUrl(value) {
        const text = cleanText(value);
        if (!text) {
            return '';
        }
        const matches = text.match(/https?:\/\/[^\s,;]+/i);
        if (!matches || !matches[0]) {
            return '';
        }
        return matches[0].trim().replace(/\/+$/, '').toLowerCase();
    }

    /**
     * Normalize a URL field containing one or more URLs.
     * @param {string} value - Raw URL field
     * @returns {string[]}
     */
    function normalizeUrlList(value) {
        const text = cleanText(value);
        if (!text) {
            return [];
        }

        const matches = text.match(/https?:\/\/[^\s,;]+/gi) || [];
        const normalized = [];
        const seen = new Set();
        matches.forEach(match => {
            const candidate = normalizeUrl(match);
            if (!candidate || seen.has(candidate)) {
                return;
            }
            seen.add(candidate);
            normalized.push(candidate);
        });
        return normalized;
    }

    /**
     * Normalize names for matching.
     * @param {string} value - Raw name
     * @returns {string}
     */
    function normalizeName(value) {
        return cleanText(value).toLowerCase().replace(/\s+/g, ' ');
    }

    /**
     * Select most frequent key from a count map.
     * @param {Map<string, number>} counts - Frequency map
     * @returns {string|null}
     */
    function pickMostFrequentKey(counts) {
        let bestKey = null;
        let bestCount = -1;

        counts.forEach((count, key) => {
            if (count > bestCount) {
                bestKey = key;
                bestCount = count;
            }
        });

        return bestKey;
    }

    /**
     * Trim any value into a string.
     * @param {unknown} value - Raw value
     * @returns {string}
     */
    function cleanText(value) {
        return value === null || value === undefined ? '' : String(value).trim();
    }

    /**
     * Escape string for safe HTML insertion.
     * @param {string} value - Raw value
     * @returns {string}
     */
    function escapeHtml(value) {
        const div = document.createElement('div');
        div.textContent = value;
        return div.innerHTML;
    }

    /**
     * Format timestamp as human-readable date.
     * @param {number} timestamp - Unix timestamp in ms
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
        const heading = elements.messagesEmpty.querySelector('h2');
        const text = elements.messagesEmpty.querySelector('p');
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
        }

        if (typeof LoadingOverlay === 'undefined') {
            return;
        }
        if (isLoading) {
            LoadingOverlay.show('messages');
            return;
        }
        LoadingOverlay.hide('messages');
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
        onRouteLeave
    };
})();
