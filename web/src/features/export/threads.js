/**
 * Message thread selection for the PDF export.
 *
 * Pure: no DOM, no storage, no worker globals. The hydrated messages state the
 * app keeps in memory deliberately discards message text, so the export re-reads
 * the parsed rows and picks out the tail of each recent conversation itself.
 *
 * Grouping is conversation-first, as the export contract requires. Rows are
 * accumulated by `CONVERSATION ID`; each conversation's correspondents are
 * resolved across all of its rows, so a contact who is renamed mid-thread, or
 * who carries a profile URL on one row and not the next, never splits the
 * conversation in two, and a row that names nobody joins its conversation
 * whether it comes first or last. Rows with a blank `CONVERSATION ID` group by
 * their correspondents directly. Conversations are then folded into threads by
 * their whole correspondent set, so a group conversation stays one thread of its
 * own rather than merging into the one-to-one thread of any member.
 *
 * Self-detection is the export's own. `MessagesAnalytics.detectSelfContext`
 * breaks coverage ties by insertion order, which names the sender of a single
 * received message as the account owner and then labels that message as sent.
 * Here a tie means self genuinely cannot be identified, and the export says so:
 * direction becomes "unknown" and every participant of a conversation counts as
 * a correspondent.
 */

import { MessagesAnalytics } from "../messages/analytics.js";

const DEFAULT_PEOPLE = 10;
const DEFAULT_MESSAGES_PER_PERSON = 5;

const UNKNOWN_NAME = "Unknown";
const UNKNOWN_NAME_KEY = "unknown";

/** A self context that matches nobody, used before self has been resolved. */
const NO_SELF = Object.freeze({ selfUrls: new Set(), selfNames: new Set() });

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
 * Deliberately not `cleanText`: trimming a body would eat the leading tab or the
 * trailing blank line the person actually typed, and the export promises the
 * full message.
 * @param {unknown} value - Parsed CONTENT cell
 * @returns {string} Message body
 */
function messageBody(value) {
    return typeof value === "string" ? value : "";
}

/**
 * Keep only the rows whose date parses, paired with the parsed date.
 *
 * Every pass has to agree on which rows exist. A row with an unreadable date
 * never reaches the PDF, so it must not vote on who the account owner is
 * either: a pile of undated rows could otherwise give a contact wider
 * conversation coverage than the owner and invert the direction chip on the
 * dated messages that do get drawn.
 * @param {object[]} rows - Parsed message rows
 * @returns {Array<{row: object, date: Date}>} Dated rows, in file order
 */
function withParsedDates(rows) {
    const dated = [];

    for (const row of rows) {
        const date = MessagesAnalytics.parseDateTime(row.DATE);
        if (date) {
            dated.push({ row, date });
        }
    }

    return dated;
}

/**
 * Map every contact name that is ever seen with a profile URL to that URL.
 *
 * LinkedIn exports include the profile URL on some rows and not others. Without
 * this pass the same person lands under both a `url:` and a `name:` key and
 * shows up as two threads.
 * @param {object[]} rows - Parsed message rows
 * @returns {Map<string, string>} Normalized name to canonical profile URL
 */
function buildNameToUrl(rows) {
    const nameToUrl = new Map();

    for (const row of rows) {
        for (const participant of MessagesAnalytics.extractParticipantsFromRow(row, NO_SELF)) {
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
 * Resolve the canonical contact key of a row's sender.
 * @param {object} row - Parsed message row
 * @param {Map<string, string>} nameToUrl - Name to canonical URL lookup
 * @returns {string} Contact key, or "" when the sender cannot be identified
 */
function senderContactKey(row, nameToUrl) {
    const name = MessagesAnalytics.cleanText(row.FROM);
    const url = MessagesAnalytics.normalizeUrl(row["SENDER PROFILE URL"]);
    if (!name && !url) {
        return "";
    }
    return canonicalContactKey({ name: name || UNKNOWN_NAME, url }, nameToUrl);
}

/**
 * Build a stable conversation key for one row.
 * @param {object} row - Parsed message row
 * @param {number} index - Row index, used when the id column is blank
 * @returns {string} Conversation key
 */
function conversationKeyForRow(row, index) {
    return MessagesAnalytics.cleanText(row["CONVERSATION ID"]) || `row-${index}`;
}

/**
 * Index every identity in the export.
 *
 * For each canonical contact key this records the URLs and names it is seen
 * under, how many conversations it takes part in, and whether it ever sends and
 * ever receives. That is all the evidence there is for deciding which identity
 * is the account owner.
 * @param {object[]} rows - Parsed message rows
 * @param {Map<string, string>} nameToUrl - Name to canonical URL lookup
 * @returns {Map<string, {urls: Set<string>, names: Set<string>, conversations: Set<string>, sent: number, received: number}>} Identity index
 */
function buildIdentityIndex(rows, nameToUrl) {
    const identities = new Map();

    rows.forEach((row, index) => {
        const conversationKey = conversationKeyForRow(row, index);
        const senderKey = senderContactKey(row, nameToUrl);

        for (const participant of MessagesAnalytics.extractParticipantsFromRow(row, NO_SELF)) {
            const key = canonicalContactKey(participant, nameToUrl);
            let entry = identities.get(key);
            if (!entry) {
                entry = {
                    urls: new Set(),
                    names: new Set(),
                    conversations: new Set(),
                    sent: 0,
                    received: 0,
                };
                identities.set(key, entry);
            }

            if (participant.url) {
                entry.urls.add(participant.url);
            }
            const nameKey = MessagesAnalytics.normalizeName(participant.name);
            if (nameKey && nameKey !== UNKNOWN_NAME_KEY) {
                entry.names.add(nameKey);
            }
            entry.conversations.add(conversationKey);
            if (key === senderKey) {
                entry.sent += 1;
            } else {
                entry.received += 1;
            }
        }
    });

    return identities;
}

/**
 * Pick the identity with the widest conversation coverage, or nothing on a tie.
 *
 * A tie is the case this module refuses to guess at: picking the first one
 * inserted is exactly how a single received message ends up attributed to the
 * wrong person.
 * @param {Array<{conversations: Set<string>}>} entries - Candidate identities
 * @returns {object|null} Winning identity, or null when the top two tie
 */
function pickWidestCoverage(entries) {
    let best = null;
    let tied = false;

    for (const entry of entries) {
        if (!best || entry.conversations.size > best.conversations.size) {
            best = entry;
            tied = false;
            continue;
        }
        if (entry.conversations.size === best.conversations.size) {
            tied = true;
        }
    }

    return tied ? null : best;
}

/**
 * Resolve the account owner from the identity index.
 *
 * Someone who both sends and receives is the strongest evidence there is, so
 * those candidates are considered first; a one-directional export falls back to
 * whoever appears in the most conversations. Either way the winner has to be
 * unique.
 * @param {Map<string, object>} identities - Identity index
 * @returns {{selfUrls: Set<string>, selfNames: Set<string>}|null} Self context, or null when unidentifiable
 */
function resolveSelfContext(identities) {
    const candidates = Array.from(identities.values());
    const balanced = candidates.filter((entry) => entry.sent > 0 && entry.received > 0);
    const self = pickWidestCoverage(balanced.length ? balanced : candidates);
    if (!self) {
        return null;
    }
    return { selfUrls: new Set(self.urls), selfNames: new Set(self.names) };
}

/**
 * Merge a participant into a correspondent record.
 * @param {{name: string, url: string}} correspondent - Accumulated identity
 * @param {{name: string, url: string}} participant - Sanitized participant
 */
function applyIdentity(correspondent, participant) {
    if (!correspondent.url && participant.url) {
        correspondent.url = participant.url;
    }
    // "Unknown" is sanitizeParticipant's placeholder for a blank name, so a real
    // name seen on a later row replaces it.
    if (participant.name && (!correspondent.name || correspondent.name === UNKNOWN_NAME)) {
        correspondent.name = participant.name;
    }
}

/**
 * Record one conversation's correspondents onto a thread.
 * @param {Map<string, {name: string, url: string}>} target - Thread correspondents
 * @param {Map<string, {name: string, url: string}>} source - Conversation correspondents
 */
function mergeCorrespondents(target, source) {
    for (const [key, correspondent] of source) {
        const existing = target.get(key);
        if (existing) {
            applyIdentity(existing, correspondent);
            continue;
        }
        target.set(key, { name: correspondent.name, url: correspondent.url });
    }
}

/**
 * Name one correspondent, falling back to their profile URL.
 * @param {{name: string, url: string}} correspondent - Correspondent record
 * @returns {string} Display name
 */
function correspondentLabel(correspondent) {
    if (correspondent.name && correspondent.name !== UNKNOWN_NAME) {
        return correspondent.name;
    }
    return correspondent.url || UNKNOWN_NAME;
}

/**
 * Order the tail of a thread chronologically and keep the last N messages.
 * @param {object[]} entries - Recorded messages with a sequence number
 * @param {number} messagesPerPerson - How many messages to keep
 * @returns {Array<{direction: 'sent'|'received'|'unknown', timestamp: number, body: string}>} Trimmed messages
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
        direction: /** @type {'sent'|'received'|'unknown'} */ (entry.direction),
        timestamp: entry.timestamp,
        body: entry.body,
    }));
}

/**
 * Group rows into conversations, resolving each one's correspondents.
 * @param {Array<{row: object, date: Date}>} dated - Dated message rows
 * @param {{selfUrls: Set<string>, selfNames: Set<string>}} context - Self context
 * @param {boolean} selfKnown - Whether the account owner was identified
 * @param {Map<string, string>} nameToUrl - Name to canonical URL lookup
 * @returns {Map<string, {correspondents: Map<string, {name: string, url: string}>, entries: object[]}>} Conversations
 */
function groupConversations(dated, context, selfKnown, nameToUrl) {
    const conversations = new Map();

    dated.forEach(({ row, date }, index) => {
        const participants = MessagesAnalytics.extractParticipantsFromRow(row, context);
        const participantKeys = participants.map((participant) =>
            canonicalContactKey(participant, nameToUrl),
        );
        const conversationId = MessagesAnalytics.cleanText(row["CONVERSATION ID"]);
        const key = conversationId
            ? `id:${conversationId}`
            : participantKeys.length
              ? `people:${participantKeys.slice().sort().join("|")}`
              : "";

        // A blank conversation id on a row with no identifiable correspondent
        // (self-only, or an anonymous "LinkedIn Member") cannot be attributed to
        // anyone at all.
        if (!key) {
            return;
        }

        let conversation = conversations.get(key);
        if (!conversation) {
            conversation = { correspondents: new Map(), entries: [] };
            conversations.set(key, conversation);
        }

        participants.forEach((participant, participantIndex) => {
            const participantKey = participantKeys[participantIndex];
            const existing = conversation.correspondents.get(participantKey);
            if (existing) {
                applyIdentity(existing, participant);
                return;
            }
            conversation.correspondents.set(participantKey, {
                name: participant.name,
                url: participant.url,
            });
        });

        conversation.entries.push({
            direction: resolveDirection(row, context, selfKnown),
            timestamp: date.getTime(),
            sequence: index,
            body: messageBody(row.CONTENT),
        });
    });

    return conversations;
}

/**
 * Label one row's direction, or admit it is unknown.
 * @param {object} row - Parsed message row
 * @param {{selfUrls: Set<string>, selfNames: Set<string>}} context - Self context
 * @param {boolean} selfKnown - Whether the account owner was identified
 * @returns {'sent'|'received'|'unknown'} Direction
 */
function resolveDirection(row, context, selfKnown) {
    if (!selfKnown) {
        return "unknown";
    }
    return MessagesAnalytics.isSelfContact(row.FROM, row["SENDER PROFILE URL"], context)
        ? "sent"
        : "received";
}

/**
 * Fold conversations into one thread per set of correspondents.
 * @param {Map<string, {correspondents: Map<string, object>, entries: object[]}>} conversations - Conversations
 * @returns {Map<string, {correspondents: Map<string, object>, messageCount: number, lastTimestamp: number, entries: object[]}>} Threads
 */
function foldIntoThreads(conversations) {
    const threads = new Map();

    for (const conversation of conversations.values()) {
        // Every row of this conversation was self-only, so there is nobody to
        // attribute it to.
        if (!conversation.correspondents.size) {
            continue;
        }

        const key = Array.from(conversation.correspondents.keys()).sort().join("|");
        let thread = threads.get(key);
        if (!thread) {
            thread = {
                correspondents: new Map(),
                messageCount: 0,
                lastTimestamp: 0,
                entries: [],
            };
            threads.set(key, thread);
        }

        mergeCorrespondents(thread.correspondents, conversation.correspondents);
        thread.messageCount += conversation.entries.length;
        for (const entry of conversation.entries) {
            thread.entries.push(entry);
            thread.lastTimestamp = Math.max(thread.lastTimestamp, entry.timestamp);
        }
    }

    return threads;
}

/**
 * Pick the most recently messaged people and the tail of each conversation.
 *
 * Rows whose date cannot be parsed are skipped before anything else, exactly as
 * `MessagesAnalytics.buildMessageState` does, so they cannot influence which
 * identity is taken to be the account owner.
 * @param {object[]} rows - Parsed message rows, including CONTENT
 * @param {{people?: number, messagesPerPerson?: number}} [options] - Selection limits
 * @returns {Array<{name: string, url: string, messageCount: number, lastTimestamp: number, messages: Array<{direction: 'sent'|'received'|'unknown', timestamp: number, body: string}>}>} Threads, most recent first
 */
export function selectRecentThreads(rows, options = {}) {
    const safeRows = Array.isArray(rows) ? rows : [];
    const people = normalizeLimit(options.people, DEFAULT_PEOPLE);
    const messagesPerPerson = normalizeLimit(
        options.messagesPerPerson,
        DEFAULT_MESSAGES_PER_PERSON,
    );

    const dated = withParsedDates(safeRows);
    const datedRows = dated.map((entry) => entry.row);
    const nameToUrl = buildNameToUrl(datedRows);
    const self = resolveSelfContext(buildIdentityIndex(datedRows, nameToUrl));
    const context = self || NO_SELF;
    const conversations = groupConversations(dated, context, Boolean(self), nameToUrl);

    return Array.from(foldIntoThreads(conversations).values())
        .sort((left, right) => right.lastTimestamp - left.lastTimestamp)
        .slice(0, people)
        .map((thread) => {
            const correspondents = Array.from(thread.correspondents.values());
            return {
                name: correspondents.map(correspondentLabel).join(", "),
                // Only a one-to-one thread has a single profile to point at.
                url: correspondents.length === 1 ? correspondents[0].url : "",
                messageCount: thread.messageCount,
                lastTimestamp: thread.lastTimestamp,
                messages: tailMessages(thread.entries, messagesPerPerson),
            };
        });
}
