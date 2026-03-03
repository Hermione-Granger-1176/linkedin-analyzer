/* Messages analytics helpers shared by UI and worker */
/* exported MessagesAnalytics */

const MessagesAnalytics = (() => {
    'use strict';

    /** Build message analytics state from cleaned rows. */
    function buildMessageState(rows) {
        const safeRows = Array.isArray(rows) ? rows : [];
        if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
            performance.mark('messages:detect-self:start');
        }
        const context = detectSelfContext(safeRows);
        if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
            performance.mark('messages:detect-self:end');
        }
        if (typeof performance !== 'undefined' && typeof performance.measure === 'function') {
            try {
                performance.measure('messages:detect-self', 'messages:detect-self:start', 'messages:detect-self:end');
            } catch {
                // Ignore missing marks to keep instrumentation resilient.
            }
        }

        const contacts = new Map();
        const events = [];
        const rowTimestamps = [];
        const talkedNameKeys = new Set();
        const talkedUrlKeys = new Set();

        let latestTimestamp = 0;
        let skippedRows = 0;
        safeRows.forEach(row => {
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
        const safeRows = Array.isArray(rows) ? rows : [];
        const list = [];
        const byUrl = new Map();
        const byName = new Map();

        safeRows.forEach(row => {
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
        const safeRows = Array.isArray(rows) ? rows : [];
        const urlStats = new Map();
        const nameStats = new Map();
        const urlNameCounts = new Map();

        safeRows.forEach((row, index) => {
            const conversationKey = buildConversationKey(row, index);
            const senderUrl = normalizeUrl(row['SENDER PROFILE URL']);
            const recipientUrls = normalizeUrlList(row['RECIPIENT PROFILE URLS']);
            const senderName = normalizeName(row.FROM);

            recordParticipantStat(urlStats, senderUrl, conversationKey, 'sender');
            recordParticipantStat(nameStats, senderName, conversationKey, 'sender');
            if (senderUrl && senderName) {
                incrementNestedCount(urlNameCounts, senderUrl, senderName);
            }

            const recipientNames = parseRecipientNames(row.TO, recipientUrls.length);
            if (recipientUrls.length) {
                recipientUrls.forEach((url, recipientIndex) => {
                    recordParticipantStat(urlStats, url, conversationKey, 'recipient');
                    const recipientName = normalizeName(
                        recipientNames[recipientIndex] || recipientNames[0] || ''
                    );
                    recordParticipantStat(nameStats, recipientName, conversationKey, 'recipient');
                    if (url && recipientName) {
                        incrementNestedCount(urlNameCounts, url, recipientName);
                    }
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
            const nameCounts = urlNameCounts.get(selfUrl) || new Map();
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

        const roleField = {
            sender: 'senderCount',
            recipient: 'recipientCount'
        }[role] || null;

        const existing = statsMap.get(key);
        if (existing) {
            existing.totalCount += 1;
            existing.conversations.add(conversationKey);
            if (roleField) {
                existing[roleField] += 1;
            }
            return;
        }

        const next = {
            totalCount: 1,
            senderCount: 0,
            recipientCount: 0,
            conversations: new Set([conversationKey])
        };
        if (roleField) {
            next[roleField] = 1;
        }
        statsMap.set(key, next);
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
     * Increment a nested (outer key -> Map) count.
     * @param {Map<string, Map<string, number>>} map - Outer map
     * @param {string} outerKey - Outer key
     * @param {string} innerKey - Inner key
     */
    function incrementNestedCount(map, outerKey, innerKey) {
        if (!outerKey || !innerKey) {
            return;
        }
        const counts = map.get(outerKey);
        if (counts) {
            incrementCount(counts, innerKey);
            return;
        }
        const next = new Map();
        incrementCount(next, innerKey);
        map.set(outerKey, next);
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

    return {
        buildMessageState,
        buildConnectionState,
        normalizeName,
        normalizeUrl,
        normalizeUrlList,
        cleanText,
        parseDateTime,
        parseDateOnly,
        parseRecipientNames
    };
})();
