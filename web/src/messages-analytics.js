/* Messages analytics helpers shared by UI and worker */

export const MessagesAnalytics = (() => {
    "use strict";

    // normalizeName/normalizeUrl are pure and called millions of times over a
    // large messages export, but on a small set of recurring contact strings
    // (you message the same people repeatedly). Memoize string inputs so each
    // unique value is normalized once; the cap bounds memory if a pathological
    // export has an unusually large unique set.
    const NORMALIZE_CACHE_LIMIT = 100000;
    const nameNormalizeCache = new Map();
    const urlNormalizeCache = new Map();

    /**
     * Build message analytics state from cleaned rows.
     * @param {object[]} rows - Cleaned message rows
     * @returns {object}
     */
    function buildMessageState(rows) {
        const safeRows = Array.isArray(rows) ? rows : [];
        if (typeof performance !== "undefined" && typeof performance.mark === "function") {
            performance.mark("messages:detect-self:start");
        }
        const context = detectSelfContext(safeRows);
        if (typeof performance !== "undefined" && typeof performance.mark === "function") {
            performance.mark("messages:detect-self:end");
        }
        if (typeof performance !== "undefined" && typeof performance.measure === "function") {
            try {
                performance.measure("messages:detect-self", "messages:detect-self:start", "messages:detect-self:end");
            } catch {
                // Ignore missing marks to keep instrumentation resilient.
            }
        }

        const contacts = new Map();
        // Maps a normalized contact name to the key its entry is currently stored
        // under, so the same person seen once with a profile URL and once without
        // folds into one contact instead of splitting across a url: and a name: key.
        const nameToKey = new Map();
        // Records name: -> url: re-keys (see promotion below) so events pushed
        // under the old name key can be rewritten to the canonical key afterward;
        // range views join events back to contacts by key and would otherwise split.
        const keyRemap = new Map();
        const events = [];
        const rowTimestamps = [];
        const talkedNameKeys = new Set();
        const talkedUrlKeys = new Set();
        // Outreach-funnel accumulators, filled in the same pass as the contact
        // aggregates so large exports are not iterated (and re-parsed) twice.
        const conversations = new Map();
        const contactStats = new Map();
        let sentMessages = 0;
        let receivedMessages = 0;

        let latestTimestamp = 0;
        let skippedRows = 0;
        safeRows.forEach((row, index) => {
            const date = parseDateTime(row.DATE);
            if (!date) {
                skippedRows += 1;
                return;
            }
            const timestamp = date.getTime();

            // Outreach tracking runs before the participant filter so that
            // self-sent messages whose only recipients are self/anonymous still
            // count toward sent totals and conversation initiation.
            // Pass the raw sender fields straight to the helpers; each normalizes
            // once internally, so pre-normalizing here would just repeat the work.
            const senderIsSelf = isSelfContact(row.FROM, row["SENDER PROFILE URL"], context);
            // A non-self sender only counts as a real correspondent when it
            // survives the same filtering as participants (non-blank,
            // non-anonymous), so "LinkedIn Member" placeholders do not inflate
            // received totals or count as a reply.
            const senderContact = senderIsSelf
                ? null
                : sanitizeParticipant({ name: row.FROM, url: row["SENDER PROFILE URL"] }, context);
            const hasRealSender = Boolean(senderContact);
            if (senderIsSelf) {
                sentMessages += 1;
            } else if (hasRealSender) {
                receivedMessages += 1;
            }
            trackConversation(conversations, buildConversationKey(row, index), {
                timestamp,
                senderIsSelf,
                hasSender: hasRealSender
            });
            if (senderContact) {
                markOutreachContact(contactStats, senderContact, "received");
            }

            const participants = extractParticipantsFromRow(row, context);
            if (!participants.length) {
                skippedRows += 1;
                return;
            }

            rowTimestamps.push(timestamp);

            participants.forEach(contact => {
                // Only non-anonymous names are safe to merge on: "LinkedIn Member"
                // placeholders belong to different people and must not collapse.
                // sanitizeParticipant already guarantees a real, non-anonymous
                // name (blank names become "Unknown"), so the empty arm here and
                // the anonymity re-checks below are defensive.
                /* v8 ignore next 4 */
                const mergeNameKey =
                    contact.name && !isAnonymousName(contact.name)
                        ? normalizeName(contact.name)
                        : "";
                let contactKey = buildContactKey(contact);
                let existing = contacts.get(contactKey);

                // No direct hit: the same person may already be stored under their
                // name (no URL yet) or under a URL (seen with one before). Reconcile
                // via the name index so their message counts merge into one entry.
                if (!existing && mergeNameKey) {
                    const mappedKey = nameToKey.get(mergeNameKey);
                    if (mappedKey && mappedKey !== contactKey && contacts.has(mappedKey)) {
                        existing = contacts.get(mappedKey);
                        if (contact.url) {
                            // Promote a name-only entry to the stronger URL key so
                            // later URL-bearing rows find it directly.
                            contacts.delete(mappedKey);
                            existing.key = contactKey;
                            contacts.set(contactKey, existing);
                            keyRemap.set(mappedKey, contactKey);
                        } else {
                            contactKey = mappedKey;
                        }
                    }
                }

                if (existing) {
                    existing.count += 1;
                    existing.lastTimestamp = Math.max(existing.lastTimestamp, timestamp);
                    if (!existing.url && contact.url) {
                        existing.url = contact.url;
                    }
                    /* v8 ignore next */
                    if (contact.name && !isAnonymousName(contact.name)) {
                        existing.name = contact.name;
                    }
                } else {
                    existing = {
                        key: contactKey,
                        // contact.name is always truthy here; the fallback is defensive.
                        /* v8 ignore next */
                        name: contact.name || "Unknown",
                        url: contact.url,
                        count: 1,
                        lastTimestamp: timestamp
                    };
                    contacts.set(contactKey, existing);
                }

                // mergeNameKey and nameKey are always truthy for a sanitized
                // participant, so the skip arms are defensive.
                /* v8 ignore next */
                if (mergeNameKey) {
                    nameToKey.set(mergeNameKey, existing.key);
                }

                const nameKey = normalizeName(contact.name);
                /* v8 ignore next */
                if (nameKey) {
                    talkedNameKeys.add(nameKey);
                }
                if (contact.url) {
                    talkedUrlKeys.add(contact.url);
                }

                events.push({ contactKey, timestamp });

                // For a self-sent row the sender is self, so the non-self
                // participants are exactly its recipients, so mark each as outreach.
                if (senderIsSelf) {
                    markOutreachContact(contactStats, contact, "sent");
                }
            });

            latestTimestamp = Math.max(latestTimestamp, timestamp);
        });

        // Repoint events pushed under a name: key that was later promoted to a
        // url: key, so range-based aggregation joins them to the merged contact.
        if (keyRemap.size) {
            const resolveKey = (key) => {
                let resolved = key;
                while (keyRemap.has(resolved)) {
                    resolved = keyRemap.get(resolved);
                }
                return resolved;
            };
            events.forEach((event) => {
                event.contactKey = resolveKey(event.contactKey);
            });
        }

        return {
            contacts,
            events,
            rowTimestamps,
            skippedRows,
            talkedNameKeys,
            talkedUrlKeys,
            latestTimestamp,
            outreach: summarizeOutreach(conversations, contactStats, sentMessages, receivedMessages)
        };
    }

    /**
     * Summarize the outreach-funnel accumulators built during the main pass:
     * who starts conversations, how often self-initiated outreach gets a reply,
     * how many contacts never replied, and the sent-to-received message ratio.
     * @param {Map<string, object>} conversations - Per-conversation aggregates
     * @param {Map<string, {sent: number, received: number}>} contactStats - Per-contact tallies
     * @param {number} sent - Total messages sent by self
     * @param {number} received - Total messages received from others
     * @returns {object}
     */
    function summarizeOutreach(conversations, contactStats, sent, received) {
        let selfInitiated = 0;
        let selfInitiatedReplied = 0;
        conversations.forEach(conversation => {
            if (!conversation.startedBySelf) {
                return;
            }
            selfInitiated += 1;
            if (conversation.gotReply) {
                selfInitiatedReplied += 1;
            }
        });

        let unansweredContacts = 0;
        contactStats.forEach(entry => {
            if (entry.sent > 0 && entry.received === 0) {
                unansweredContacts += 1;
            }
        });

        const totalConversations = conversations.size;
        return {
            totalConversations,
            selfInitiated,
            othersInitiated: totalConversations - selfInitiated,
            selfInitiatedReplied,
            replyRate: selfInitiated > 0 ? selfInitiatedReplied / selfInitiated : null,
            unansweredContacts,
            sent,
            received,
            sentReceivedRatio: received > 0 ? sent / received : null
        };
    }

    /**
     * Update a conversation aggregate with one message's sender/timestamp.
     * @param {Map<string, object>} conversations - Conversation aggregates
     * @param {string} conversationKey - Conversation identifier
     * @param {{timestamp: number, senderIsSelf: boolean, hasSender: boolean}} message - Message facts
     */
    function trackConversation(conversations, conversationKey, message) {
        const existing = conversations.get(conversationKey);
        if (!existing) {
            conversations.set(conversationKey, {
                firstTimestamp: message.timestamp,
                startedBySelf: message.senderIsSelf,
                gotReply: !message.senderIsSelf && message.hasSender
            });
            return;
        }
        if (message.timestamp < existing.firstTimestamp) {
            existing.firstTimestamp = message.timestamp;
            existing.startedBySelf = message.senderIsSelf;
        }
        if (!message.senderIsSelf && message.hasSender) {
            existing.gotReply = true;
        }
    }

    /**
     * Determine whether a name/url pair refers to the detected self.
     * @param {string} name - Raw sender/recipient name
     * @param {string} url - Raw sender/recipient URL
     * @param {{selfUrls: Set<string>, selfNames: Set<string>}} context - Self context
     * @returns {boolean}
     */
    function isSelfContact(name, url, context) {
        const nameKey = normalizeName(name);
        const normalizedUrl = normalizeUrl(url);
        return Boolean(
            (normalizedUrl && context.selfUrls.has(normalizedUrl))
            || (nameKey && context.selfNames.has(nameKey))
        );
    }

    /**
     * Increment a contact's sent/received tally.
     * @param {Map<string, {sent: number, received: number}>} stats - Per-contact tallies
     * @param {{name: string, url: string}} contact - Contact
     * @param {'sent'|'received'} direction - Message direction
     */
    function markOutreachContact(stats, contact, direction) {
        const key = buildContactKey(contact);
        const entry = stats.get(key);
        if (entry) {
            entry[direction] += 1;
            return;
        }
        stats.set(key, { sent: 0, received: 0, [direction]: 1 });
    }

    /**
     * Build connections lookup state from cleaned rows.
     * @param {object[]} rows - Cleaned connections rows
     * @returns {{list: object[], byUrl: Map<string, object>, byName: Map<string, object>}}
     */
    function buildConnectionState(rows) {
        const safeRows = Array.isArray(rows) ? rows : [];
        const list = [];
        const byUrl = new Map();
        const byName = new Map();

        safeRows.forEach(row => {
            const firstName = cleanText(row["First Name"]);
            const lastName = cleanText(row["Last Name"]);
            const fullName = `${firstName} ${lastName}`.trim();
            const nameKey = normalizeName(fullName);
            const url = normalizeUrl(row.URL);
            const connectedOnDate = parseDateOnly(row["Connected On"]);
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

    /**
     * Detect likely self identity using cross-conversation participation.
     * @param {object[]} rows - Cleaned message rows
     * @returns {{selfUrls: Set<string>, selfNames: Set<string>}}
     */
    function detectSelfContext(rows) {
        // buildMessageState always passes an array, so the fallback is defensive.
        /* v8 ignore next */
        const safeRows = Array.isArray(rows) ? rows : [];
        const urlStats = new Map();
        const nameStats = new Map();
        const urlNameCounts = new Map();

        safeRows.forEach((row, index) => {
            const conversationKey = buildConversationKey(row, index);
            const senderUrl = normalizeUrl(row["SENDER PROFILE URL"]);
            const recipientUrls = normalizeUrlList(row["RECIPIENT PROFILE URLS"]);
            const senderName = normalizeName(row.FROM);

            recordParticipantStat(urlStats, senderUrl, conversationKey, "sender");
            recordParticipantStat(nameStats, senderName, conversationKey, "sender");
            if (senderUrl && senderName) {
                incrementNestedCount(urlNameCounts, senderUrl, senderName);
            }

            const recipientNames = parseRecipientNames(row.TO, recipientUrls.length);
            if (recipientUrls.length) {
                recipientUrls.forEach((url, recipientIndex) => {
                    recordParticipantStat(urlStats, url, conversationKey, "recipient");
                    const recipientName = normalizeName(
                        recipientNames[recipientIndex] || recipientNames[0] || ""
                    );
                    recordParticipantStat(nameStats, recipientName, conversationKey, "recipient");
                    if (url && recipientName) {
                        incrementNestedCount(urlNameCounts, url, recipientName);
                    }
                });
                return;
            }

            recipientNames.forEach(name => {
                recordParticipantStat(nameStats, normalizeName(name), conversationKey, "recipient");
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
        const conversationId = cleanText(row["CONVERSATION ID"]);
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

        // Callers only pass "sender" or "recipient", so the null fallback and the
        // roleField guards below are defensive.
        /* v8 ignore next 4 */
        const roleField = {
            sender: "senderCount",
            recipient: "recipientCount"
        }[role] || null;

        const existing = statsMap.get(key);
        if (existing) {
            existing.totalCount += 1;
            existing.conversations.add(conversationKey);
            /* v8 ignore next */
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
        /* v8 ignore next */
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

            /* v8 ignore next 4 */
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
        /* v8 ignore next 3 */
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
        /* v8 ignore next 3 */
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
            url: normalizeUrl(row["SENDER PROFILE URL"])
        };
        addParticipant(sender, participants, seenKeys, context);

        const recipientUrls = normalizeUrlList(row["RECIPIENT PROFILE URLS"]);
        const recipientNames = parseRecipientNames(row.TO, recipientUrls.length);
        if (recipientUrls.length) {
            recipientUrls.forEach((url, index) => {
                const name = recipientNames[index] || recipientNames[0] || "";
                addParticipant({ name, url }, participants, seenKeys, context);
            });
        } else {
            recipientNames.forEach(name => {
                addParticipant({ name, url: "" }, participants, seenKeys, context);
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
        /* v8 ignore next 3 */
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
            name: name || "Unknown",
            url
        };
    }

    /**
     * Check if a name is anonymous placeholder text.
     * @param {string} name - Candidate name
     * @returns {boolean}
     */
    function isAnonymousName(name) {
        return normalizeName(name) === "linkedin member";
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
        // A sanitized contact name always normalizes to a non-empty key; the
        // "unknown" fallback is defensive.
        /* v8 ignore next 2 */
        const nameKey = normalizeName(contact.name);
        return `name:${nameKey || "unknown"}`;
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
        /* v8 ignore next */
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
        /* v8 ignore next */
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

        return text.split(",").map(part => part.trim()).filter(Boolean);
    }

    /**
     * Normalize URL values and extract first LinkedIn URL.
     * @param {string} value - Raw URL field
     * @returns {string}
     */
    function normalizeUrl(value) {
        if (typeof value === "string") {
            const cached = urlNormalizeCache.get(value);
            if (cached !== undefined) {
                return cached;
            }
            const computed = computeNormalizedUrl(value);
            // The cache never reaches its six-figure cap in practice; the guard is defensive.
            /* v8 ignore next */
            if (urlNormalizeCache.size < NORMALIZE_CACHE_LIMIT) {
                urlNormalizeCache.set(value, computed);
            }
            return computed;
        }
        return computeNormalizedUrl(value);
    }

    /**
     * Compute the normalized URL without the memo layer.
     * @param {unknown} value - Raw URL field
     * @returns {string}
     */
    function computeNormalizedUrl(value) {
        const text = cleanText(value);
        if (!text) {
            return "";
        }
        const matches = text.match(/https?:\/\/[^\s,;]+/i);
        if (!matches || !matches[0]) {
            return "";
        }
        return matches[0].trim().replace(/\/+$/, "").toLowerCase();
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
        if (typeof value === "string") {
            const cached = nameNormalizeCache.get(value);
            if (cached !== undefined) {
                return cached;
            }
            const computed = computeNormalizedName(value);
            // The cache never reaches its six-figure cap in practice; the guard is defensive.
            /* v8 ignore next */
            if (nameNormalizeCache.size < NORMALIZE_CACHE_LIMIT) {
                nameNormalizeCache.set(value, computed);
            }
            return computed;
        }
        return computeNormalizedName(value);
    }

    /**
     * Compute the normalized name without the memo layer.
     * @param {unknown} value - Raw name
     * @returns {string}
     */
    function computeNormalizedName(value) {
        return cleanText(value).toLowerCase().replace(/\s+/g, " ");
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
        return value === null || value === undefined ? "" : String(value).trim();
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
