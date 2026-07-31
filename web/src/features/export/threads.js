/**
 * Message thread selection for the PDF export.
 *
 * Pure: no DOM, no storage, no worker globals. The hydrated messages state the
 * app keeps in memory deliberately discards message text, so the export re-reads
 * the cleaned rows and picks out the tail of each recent conversation itself.
 *
 * Self-detection, participant filtering and contact keying are borrowed from
 * MessagesAnalytics so a person does not split across keys and message
 * direction agrees with the rest of the app.
 */

import { MessagesAnalytics } from "../messages/analytics.js";

const DEFAULT_PEOPLE = 10;
const DEFAULT_MESSAGES_PER_PERSON = 5;

/**
 * Coerce an option to a positive integer, falling back when unusable.
 * @param {unknown} value - Raw option value
 * @param {number} fallback - Default to use
 * @returns {number} Positive integer limit
 */
function normalizeLimit(value, fallback) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
        return fallback;
    }
    return Math.floor(value);
}

/**
 * Take a message body exactly as it was parsed.
 *
 * Deliberately not `cleanText`: trimming a body would eat the leading tab or
 * the trailing blank line the person actually typed, and the export promises the
 * full message.
 * @param {unknown} value - Parsed CONTENT cell
 * @returns {string} Message body
 */
function messageBody(value) {
    return typeof value === "string" ? value : "";
}

/**
 * Map every contact name that is ever seen with a profile URL to that URL.
 *
 * LinkedIn exports include the profile URL on some rows and not others. Without
 * this pass the same person lands under both a `url:` and a `name:` key and
 * shows up as two threads.
 * @param {object[]} rows - Cleaned message rows
 * @param {{selfUrls: Set<string>, selfNames: Set<string>}} context - Self context
 * @returns {Map<string, string>} Normalized name to canonical profile URL
 */
function buildNameToUrl(rows, context) {
    const nameToUrl = new Map();

    for (const row of rows) {
        for (const participant of MessagesAnalytics.extractParticipantsFromRow(row, context)) {
            if (!participant.url) {
                continue;
            }
            const nameKey = MessagesAnalytics.normalizeName(participant.name);
            if (nameKey && !nameToUrl.has(nameKey)) {
                nameToUrl.set(nameKey, participant.url);
            }
        }
    }

    return nameToUrl;
}

/**
 * Resolve the canonical contact key for a participant.
 * @param {{name: string, url: string}} participant - Sanitized participant
 * @param {Map<string, string>} nameToUrl - Name to canonical URL lookup
 * @returns {string} Contact key
 */
function canonicalContactKey(participant, nameToUrl) {
    if (participant.url) {
        return MessagesAnalytics.buildContactKey(participant);
    }
    const nameKey = MessagesAnalytics.normalizeName(participant.name);
    const knownUrl = nameToUrl.get(nameKey);
    if (knownUrl) {
        return `url:${knownUrl}`;
    }
    return MessagesAnalytics.buildContactKey(participant);
}

/**
 * Create the accumulator for one person's thread.
 * @param {string} key - Canonical contact key
 * @returns {{key: string, name: string, url: string, messageCount: number, lastTimestamp: number, entries: object[]}}
 */
function createThread(key) {
    return {
        key,
        name: "",
        url: "",
        messageCount: 0,
        lastTimestamp: 0,
        entries: [],
    };
}

/**
 * Fill in a thread's display identity from a participant on one of its rows.
 * @param {object} thread - Thread accumulator
 * @param {{name: string, url: string}} participant - Sanitized participant
 */
function applyIdentity(thread, participant) {
    if (!thread.url && participant.url) {
        thread.url = participant.url;
    }
    // "Unknown" is sanitizeParticipant's placeholder for a blank name, so a real
    // name seen on a later row replaces it.
    if (participant.name && (!thread.name || thread.name === "Unknown")) {
        thread.name = participant.name;
    }
}

/**
 * Order the tail of a thread chronologically and keep the last N messages.
 * @param {object[]} entries - Recorded messages with a sequence number
 * @param {number} messagesPerPerson - How many messages to keep
 * @returns {Array<{direction: 'sent'|'received', timestamp: number, body: string}>} Trimmed messages
 */
function tailMessages(entries, messagesPerPerson) {
    const ordered = entries
        .slice()
        .sort((left, right) =>
            left.timestamp === right.timestamp
                ? left.sequence - right.sequence
                : left.timestamp - right.timestamp,
        );

    return ordered.slice(-messagesPerPerson).map((entry) => ({
        direction: /** @type {'sent'|'received'} */ (entry.direction),
        timestamp: entry.timestamp,
        body: entry.body,
    }));
}

/**
 * Pick the most recently messaged people and the tail of each conversation.
 *
 * Rows are grouped by `CONVERSATION ID`, falling back to the normalized contact
 * key when that column is blank, and conversations with the same person are then
 * folded together. Rows whose date cannot be parsed are skipped, exactly as
 * `MessagesAnalytics.buildMessageState` does.
 * @param {object[]} rows - Cleaned message rows, including CONTENT
 * @param {{people?: number, messagesPerPerson?: number}} [options] - Selection limits
 * @returns {Array<{name: string, url: string, messageCount: number, lastTimestamp: number, messages: Array<{direction: 'sent'|'received', timestamp: number, body: string}>}>} Threads, most recent first
 */
export function selectRecentThreads(rows, options = {}) {
    const safeRows = Array.isArray(rows) ? rows : [];
    const people = normalizeLimit(options.people, DEFAULT_PEOPLE);
    const messagesPerPerson = normalizeLimit(
        options.messagesPerPerson,
        DEFAULT_MESSAGES_PER_PERSON,
    );

    const context = MessagesAnalytics.detectSelfContext(safeRows);
    const nameToUrl = buildNameToUrl(safeRows, context);

    // Conversation id -> canonical contact key, so every row of a conversation
    // lands on the same person even when a later row drops the profile URL.
    const conversationOwner = new Map();
    const threads = new Map();

    safeRows.forEach((row, index) => {
        const date = MessagesAnalytics.parseDateTime(row.DATE);
        if (!date) {
            return;
        }

        const participants = MessagesAnalytics.extractParticipantsFromRow(row, context);
        const conversationId = MessagesAnalytics.cleanText(row["CONVERSATION ID"]);
        const participantKey = participants.length
            ? canonicalContactKey(participants[0], nameToUrl)
            : "";
        const contactKey = participantKey || (conversationId && conversationOwner.get(conversationId));

        // A row with no identifiable correspondent (self-only, or an anonymous
        // "LinkedIn Member") cannot be attributed to anyone.
        if (!contactKey) {
            return;
        }
        if (conversationId && !conversationOwner.has(conversationId)) {
            conversationOwner.set(conversationId, contactKey);
        }

        let thread = threads.get(contactKey);
        if (!thread) {
            thread = createThread(contactKey);
            threads.set(contactKey, thread);
        }
        if (participants.length) {
            applyIdentity(thread, participants[0]);
        }

        const timestamp = date.getTime();
        thread.messageCount += 1;
        thread.lastTimestamp = Math.max(thread.lastTimestamp, timestamp);
        thread.entries.push({
            direction: MessagesAnalytics.isSelfContact(
                row.FROM,
                row["SENDER PROFILE URL"],
                context,
            )
                ? "sent"
                : "received",
            timestamp,
            sequence: index,
            body: messageBody(row.CONTENT),
        });
    });

    return Array.from(threads.values())
        .sort((left, right) => right.lastTimestamp - left.lastTimestamp)
        .slice(0, people)
        .map((thread) => ({
            name: thread.name || thread.url || "Unknown",
            url: thread.url,
            messageCount: thread.messageCount,
            lastTimestamp: thread.lastTimestamp,
            messages: tailMessages(thread.entries, messagesPerPerson),
        }));
}
