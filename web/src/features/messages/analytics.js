/* Messages analytics helpers shared by UI and worker */

import { parseLocalDate, parseLocalDateTime } from "../analytics/dates.js";

/** @typedef {import("./model.ts").MessageRow} MessageRow */
/** @typedef {import("./model.ts").ConnectionRow} ConnectionRow */
/** @typedef {import("./model.ts").SelfContext} SelfContext */
/** @typedef {import("./model.ts").Participant} Participant */
/** @typedef {import("./model.ts").MessageContact} MessageContact */
/** @typedef {import("./model.ts").MessageEvents} MessageEvents */
/** @typedef {import("./model.ts").OutreachSummary} OutreachSummary */
/** @typedef {import("./model.ts").MessageState} MessageState */
/** @typedef {import("./model.ts").Connection} Connection */
/** @typedef {import("./model.ts").ConnectionState} ConnectionState */
/** @typedef {import("./model.ts").ConversationAggregate} ConversationAggregate */
/** @typedef {import("./model.ts").ParticipantStats} ParticipantStats */
/** @typedef {import("./model.ts").RoleCountField} RoleCountField */

export const MessagesAnalytics = (() => {
    "use strict";

    // The normalizers are pure and called millions of times over a large
    // messages export, but on a small set of recurring contact strings (you
    // message the same people repeatedly, and the cleaner shares each repeated
    // value). Memoize string inputs so each unique value is normalized once; the
    // cap bounds memory if a pathological export has an unusually large unique set.
    const NORMALIZE_CACHE_LIMIT = 100000;

    /**
     * Wrap a pure normalizer so each distinct string input is computed once.
     * The cache empties when it reaches its cap, so a run of unique values
     * cannot grow it without bound or leave it full of stale entries.
     * @template T
     * @param {(value: unknown) => T} compute - Pure normalizer
     * @returns {(value: unknown) => T}
     */
    function memoizeStrings(compute) {
        /** @type {Map<string, T>} */
        const cache = new Map();
        return (value) => {
            if (typeof value !== "string") {
                return compute(value);
            }
            let result = cache.get(value);
            if (result === undefined) {
                result = compute(value);
                // Keep the cache bounded when normalization receives many unique values.
                /* v8 ignore next 3 */
                if (cache.size >= NORMALIZE_CACHE_LIMIT) {
                    cache.clear();
                }
                cache.set(value, result);
            }
            return result;
        };
    }

    const normalizeName = memoizeStrings(computeNormalizedName);
    const normalizeUrl = memoizeStrings(computeNormalizedUrl);
    const normalizeUrlList = memoizeStrings(computeNormalizedUrlList);
    const singleRecipientName = memoizeStrings((value) => {
        const text = cleanText(value);
        return Object.freeze(text ? [text] : []);
    });
    const splitRecipientNames = memoizeStrings((value) =>
        Object.freeze(cleanText(value).split(",").map(part => part.trim()).filter(Boolean))
    );

    /**
     * Build message analytics state from cleaned rows.
     * @param {MessageRow[]} rows - Cleaned message rows
     * @returns {MessageState}
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

        /** @type {Map<string, MessageContact>} */
        const contacts = new Map();
        // Maps a normalized contact name to the key its entry is currently stored
        // under, so the same person seen once with a profile URL and once without
        // folds into one contact instead of splitting across a url: and a name: key.
        /** @type {Map<string, string>} */
        const nameToKey = new Map();
        // Events are stored as columns, one entry per participant per row: a
        // contact ID and a timestamp. A contact keeps its ID when it is promoted
        // from a name: key to a url: key, so earlier events follow the merge.
        /** @type {Map<MessageContact, number>} */
        const contactIds = new Map();
        /** @type {string[]} */
        const contactKeys = [];
        const eventContactIds = createGrowableColumn(Int32Array);
        const eventTimestamps = createGrowableColumn(Float64Array);
        const rowTimestamps = createGrowableColumn(Float64Array);
        /** @type {Set<string>} */
        const talkedNameKeys = new Set();
        /** @type {Set<string>} */
        const talkedUrlKeys = new Set();
        // Outreach-funnel accumulators, filled in the same pass as the contact
        // aggregates so large exports are not iterated (and re-parsed) twice.
        /** @type {Map<string, ConversationAggregate>} */
        const conversations = new Map();
        /** @type {Map<string, {sent: number, received: number}>} */
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
            // once internally, so pre-normalizing here would repeat the work.
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
                // sanitizeParticipant supplies a real name or "Unknown". Keep the
                // empty branch and anonymity checks for malformed participant data.
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
                // A stored contact with a different URL is a different person who
                // shares the name, so it is never merged.
                if (!existing && mergeNameKey) {
                    const mappedKey = nameToKey.get(mergeNameKey);
                    const mapped = mappedKey ? contacts.get(mappedKey) : undefined;
                    if (mapped && !contact.url) {
                        existing = mapped;
                        contactKey = mapped.key;
                    } else if (mapped && !mapped.url) {
                        // Promote a name-only entry to the stronger URL key so
                        // later URL-bearing rows find it directly.
                        existing = mapped;
                        contacts.delete(mapped.key);
                        existing.key = contactKey;
                        contacts.set(contactKey, existing);
                        contactKeys[/** @type {number} */ (contactIds.get(existing))] = contactKey;
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
                        // sanitizeParticipant supplies a name. Keep "Unknown" for malformed data.
                        /* v8 ignore next */
                        name: contact.name || "Unknown",
                        url: contact.url,
                        count: 1,
                        lastTimestamp: timestamp
                    };
                    contacts.set(contactKey, existing);
                    contactIds.set(existing, contactKeys.length);
                    contactKeys.push(contactKey);
                }

                // Sanitized participants normally produce both keys. Keep these
                // branches for malformed participant data.
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

                eventContactIds.push(/** @type {number} */ (contactIds.get(existing)));
                eventTimestamps.push(timestamp);

                // For a self-sent row the sender is self, so the non-self
                // participants are exactly its recipients, so mark each as outreach.
                if (senderIsSelf) {
                    markOutreachContact(contactStats, contact, "sent");
                }
            });

            latestTimestamp = Math.max(latestTimestamp, timestamp);
        });

        return {
            contacts,
            events: {
                contactKeys,
                contactIds: eventContactIds.toArray(),
                timestamps: eventTimestamps.toArray(),
            },
            rowTimestamps: rowTimestamps.toArray(),
            skippedRows,
            talkedNameKeys,
            talkedUrlKeys,
            latestTimestamp,
            outreach: summarizeOutreach(conversations, contactStats, sentMessages, receivedMessages)
        };
    }

    /**
     * Create a typed-array column that doubles its capacity as values arrive.
     * @template {Int32Array<ArrayBuffer>|Float64Array<ArrayBuffer>} T
     * @param {new (length: number) => T} ArrayType - Typed array to store values in
     * @returns {{push: (value: number) => void, toArray: () => T}} toArray copies
     * the values into an exact-length array, so its buffer can be transferred whole.
     */
    function createGrowableColumn(ArrayType) {
        let values = new ArrayType(1024);
        let length = 0;
        return {
            push(value) {
                if (length === values.length) {
                    const grown = new ArrayType(length * 2);
                    grown.set(values);
                    values = grown;
                }
                values[length] = value;
                length += 1;
            },
            toArray() {
                return /** @type {T} */ (values.slice(0, length));
            },
        };
    }

    /**
     * Summarize the outreach-funnel accumulators built during the main pass:
     * who starts conversations, how often self-initiated outreach gets a reply,
     * how many contacts never replied, and the sent-to-received message ratio.
     * @param {Map<string, ConversationAggregate>} conversations - Per-conversation aggregates
     * @param {Map<string, {sent: number, received: number}>} contactStats - Per-contact tallies
     * @param {number} sent - Total messages sent by self
     * @param {number} received - Total messages received from others
     * @returns {OutreachSummary}
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
     * @param {Map<string, ConversationAggregate>} conversations - Conversation aggregates
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
     * @param {unknown} name - Raw sender/recipient name
     * @param {unknown} url - Raw sender/recipient URL
     * @param {SelfContext} context - Self context
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
     * @param {ConnectionRow[]} rows - Cleaned connections rows
     * @returns {ConnectionState}
     */
    function buildConnectionState(rows) {
        const safeRows = Array.isArray(rows) ? rows : [];
        /** @type {Connection[]} */
        const list = [];
        /** @type {Map<string, Connection>} */
        const byUrl = new Map();
        /** @type {Map<string, Connection>} */
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
     * @param {MessageRow[]} rows - Cleaned message rows
     * @returns {SelfContext}
     */
    function detectSelfContext(rows) {
        // buildMessageState passes an array. Keep an empty list for malformed input.
        /* v8 ignore next */
        const safeRows = Array.isArray(rows) ? rows : [];
        /** @type {Map<string, ParticipantStats>} */
        const urlStats = new Map();
        /** @type {Map<string, ParticipantStats>} */
        const nameStats = new Map();
        /** @type {Map<string, Map<string, number>>} */
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
        /** @type {Set<string>} */
        const selfUrls = new Set();
        /** @type {Set<string>} */
        const selfNames = new Set();
        if (selfUrl) {
            selfUrls.add(selfUrl);
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
     * @param {MessageRow} row - Message row
     * @param {number} rowIndex - Row index fallback
     * @returns {string}
     */
    function buildConversationKey(row, rowIndex) {
        const conversationId = cleanText(row["CONVERSATION ID"]);
        return conversationId || `row-${rowIndex}`;
    }

    /**
     * Record sender/recipient participation metrics for a candidate key.
     * @param {Map<string, ParticipantStats>} statsMap - Aggregated stats map
     * @param {string} key - Candidate key (URL or normalized name)
     * @param {string} conversationKey - Conversation identifier
     * @param {'sender'|'recipient'} role - Message-side role
     */
    function recordParticipantStat(statsMap, key, conversationKey, role) {
        if (!key) {
            return;
        }

        // Callers pass "sender" or "recipient". Keep the null fallback for malformed input.
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
                existing[/** @type {RoleCountField} */ (roleField)] += 1;
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
            next[/** @type {RoleCountField} */ (roleField)] = 1;
        }
        statsMap.set(key, next);
    }

    /**
     * Select likely self key from participation stats.
     * Candidate must appear on both sender and recipient sides.
     * @param {Map<string, ParticipantStats>} statsMap - URL or name stats
     * @returns {string|null}
     */
    function pickSelfKey(statsMap) {
        /** @type {string|null} */
        let bestBalancedKey = null;
        let bestBalancedConversationCount = -1;
        let bestBalancedTotalCount = -1;

        /** @type {string|null} */
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
        /** @type {Map<string, number>} */
        const next = new Map();
        incrementCount(next, innerKey);
        map.set(outerKey, next);
    }

    /**
     * Extract non-self participants from a message row.
     * Combines FROM and TO sides and counts each person once per row.
     *
     * @param {MessageRow} row - Message row
     * @param {SelfContext} context - Self context
     * @returns {Participant[]}
     */
    function extractParticipantsFromRow(row, context) {
        /** @type {Participant[]} */
        const participants = [];
        /** @type {Set<string>} */
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
     * @param {Participant} contact - Contact candidate
     * @param {Participant[]} participants - Output array
     * @param {Set<string>} seenKeys - De-dupe keys for this row
     * @param {SelfContext} context - Self context
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
     * @param {Participant} contact - Contact candidate
     * @param {SelfContext} context - Self context
     * @returns {Participant|null}
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
        // A sanitized contact name normally produces a key. Use "unknown" for malformed data.
        /* v8 ignore next 2 */
        const nameKey = normalizeName(contact.name);
        return `name:${nameKey || "unknown"}`;
    }

    /**
     * Parse a local date-only or date-time string ("YYYY-MM-DD" or "YYYY-MM-DD HH:MM[:SS]").
     * @param {unknown} value - Date string
     * @returns {Date|null}
     */
    function parseDateTime(value) {
        const text = cleanText(value);
        return parseLocalDateTime(text) || parseLocalDate(text);
    }

    /**
     * Parse date-only string in YYYY-MM-DD format.
     * @param {unknown} value - Date string
     * @returns {Date|null}
     */
    function parseDateOnly(value) {
        return parseLocalDate(cleanText(value));
    }

    /**
     * Parse recipient names from TO field.
     * Uses URL count to avoid splitting single names that contain commas.
     *
     * @param {unknown} value - Raw TO field
     * @param {number} recipientUrlCount - Parsed recipient URL count
     * @returns {readonly string[]}
     */
    function parseRecipientNames(value, recipientUrlCount) {
        return recipientUrlCount <= 1 ? singleRecipientName(value) : splitRecipientNames(value);
    }

    /**
     * Normalize URL values and extract the first LinkedIn URL.
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
     * @param {unknown} value - Raw URL field
     * @returns {readonly string[]}
     */
    function computeNormalizedUrlList(value) {
        const text = cleanText(value);
        if (!text) {
            return [];
        }

        const matches = text.match(/https?:\/\/[^\s,;]+/gi) || [];
        /** @type {string[]} */
        const normalized = [];
        /** @type {Set<string>} */
        const seen = new Set();
        matches.forEach(match => {
            const candidate = normalizeUrl(match);
            if (!candidate || seen.has(candidate)) {
                return;
            }
            seen.add(candidate);
            normalized.push(candidate);
        });
        return Object.freeze(normalized);
    }

    /**
     * Normalize names for matching.
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
        /** @type {string|null} */
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
        parseRecipientNames,
        // Exposed for the PDF export's thread selection, which reuses this
        // module's participant filtering and key building so a person does not
        // split across keys. Self-detection there is the export's own: this one
        // breaks coverage ties by insertion order, which the export must not.
        isSelfContact,
        extractParticipantsFromRow,
        buildContactKey
    };
})();
