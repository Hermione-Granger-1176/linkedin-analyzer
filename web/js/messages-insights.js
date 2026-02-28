/* Messages insights page logic */

(function() {
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

    const SHORT_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: '2-digit',
        year: 'numeric'
    });

    const elements = {
        timeRangeButtons: document.querySelectorAll('#messagesTimeRangeButtons .filter-btn'),
        resetFiltersBtn: document.getElementById('messagesResetFiltersBtn'),
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
        connectionLoadError: null
    };

    /** Initialize messages page. */
    function init() {
        bindEvents();
        loadData();
    }

    /** Attach event listeners for filters. */
    function bindEvents() {
        elements.timeRangeButtons.forEach(button => {
            button.addEventListener('click', () => handleTimeRangeChange(button));
        });
        elements.resetFiltersBtn.addEventListener('click', resetFilters);
    }

    /** Load messages and connections files from IndexedDB. */
    async function loadData() {
        const files = await Storage.getAllFiles();
        const messagesFile = files.find(file => file.type === 'messages') || null;
        const connectionsFile = files.find(file => file.type === 'connections') || null;
        state.hasConnectionsFile = Boolean(connectionsFile);

        if (!messagesFile) {
            setEmptyState(
                'No messages data available yet',
                'Upload messages.csv on the Home page to unlock messaging insights.'
            );
            return;
        }

        const messagesResult = LinkedInCleaner.process(messagesFile.text, 'messages');
        if (!messagesResult.success) {
            setEmptyState(
                'Messages parsing error',
                messagesResult.error || 'Unable to parse messages.csv. Re-upload the file and try again.'
            );
            return;
        }

        state.messageState = buildMessageState(messagesResult.cleanedData);
        if (!state.messageState.events.length) {
            setEmptyState(
                'No usable message rows',
                'The file loaded, but no valid message rows were found for analysis.'
            );
            return;
        }

        if (connectionsFile) {
            const connectionsResult = LinkedInCleaner.process(connectionsFile.text, 'connections');
            if (connectionsResult.success) {
                state.connectionState = buildConnectionState(connectionsResult.cleanedData);
                state.connectionLoadError = null;
            } else {
                state.connectionState = buildConnectionState([]);
                state.connectionLoadError = connectionsResult.error || 'Unable to parse Connections.csv.';
            }
        } else {
            state.connectionState = buildConnectionState([]);
            state.connectionLoadError = null;
        }

        renderView();
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
        renderView();
    }

    /**
     * Apply new time range and render.
     * @param {string} range - Time range key
     */
    function applyTimeRange(range) {
        state.filters = { ...FILTER_DEFAULTS, timeRange: range };
        setActiveTimeRange(range);
        renderView();
    }

    /**
     * Update active class on time range buttons.
     * @param {string} range - Active time range
     */
    function setActiveTimeRange(range) {
        elements.timeRangeButtons.forEach(button => {
            button.classList.toggle('active', button.getAttribute('data-range') === range);
        });
    }

    /** Build message analytics state from cleaned rows. */
    function buildMessageState(rows) {
        const context = detectSelfContext(rows);
        const contacts = new Map();
        const events = [];
        const talkedNameKeys = new Set();
        const talkedUrlKeys = new Set();

        let latestTimestamp = 0;
        rows.forEach(row => {
            const date = parseDateTime(row.DATE);
            if (!date) {
                return;
            }
            const timestamp = date.getTime();
            const participants = extractParticipantsFromRow(row, context);
            if (!participants.length) {
                return;
            }

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
     * @returns {{items: object[], totalMessages: number, totalPeople: number}}
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
        return {
            items,
            totalMessages,
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
            const leftTs = left.connectedOnTimestamp || 0;
            const rightTs = right.connectedOnTimestamp || 0;
            if (rightTs !== leftTs) {
                return rightTs - leftTs;
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
                daysSince,
                lastTimestamp: contact.lastTimestamp,
                company: connection.company
            });
        });

        fading.sort((left, right) => {
            if (right.daysSince !== left.daysSince) {
                return right.daysSince - left.daysSince;
            }
            return right.lastTimestamp - left.lastTimestamp;
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

        renderTopContacts(topSummary.items.slice(0, 10));
        renderSilentConnections(silentConnections.slice(0, 10));
        renderFadingConversations(fadingConversations.slice(0, 10));

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
                    <p class="message-item-title">${escapeHtml(item.name)}</p>
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
                        <p class="message-item-title">${escapeHtml(item.name)}</p>
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
                    <p class="message-item-title">${escapeHtml(item.name)}</p>
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
        elements.msgStatMessages.textContent = String(topSummary.totalMessages);
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
    }

    /** Hide empty state and show layout. */
    function hideEmptyState() {
        elements.messagesEmpty.hidden = true;
        elements.messagesLayout.hidden = false;
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
