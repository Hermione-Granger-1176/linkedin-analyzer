/**
 * Select message threads for PDF export without DOM or storage access.
 *
 * Group rows by CONVERSATION ID and resolve correspondents across all rows.
 * Rows without an ID group by correspondents. Merge conversations only when
 * their complete correspondent sets match, keeping group threads separate.
 *
 * Resolve the account owner independently of MessagesAnalytics.detectSelfContext.
 * A coverage tie leaves direction unknown instead of selecting by insertion
 * order. In that case, every participant counts as a correspondent.
 */

import { MessagesAnalytics } from "../messages/analytics.js";

const DEFAULT_PEOPLE = 10;
const DEFAULT_MESSAGES_PER_PERSON = 5;

const UNKNOWN_NAME = "Unknown";
const UNKNOWN_NAME_KEY = "unknown";
const ANONYMOUS_NAME = "LinkedIn Member";
const ANONYMOUS_NAME_KEY = "linkedin member";

/**
 * A self context that matches nobody, used before self has been resolved.
 *
 * Shared, so its sets are read-only by convention: the freeze covers the record
 * and not the sets inside it.
 */
const NO_SELF = Object.freeze({ selfUrls: new Set(), selfNames: new Set() });

/**
 * @typedef {{urls: Set<string>, names: Set<string>, conversations: Set<string>, sent: number, received: number}} Identity
 * @typedef {{name: string, url: string}} Correspondent
 * @typedef {{direction: 'sent'|'received'|'unknown', timestamp: number, sequence: number, rowIndex: number}} MessageEntry
 * @typedef {import("./messages-parse.js").MessageRow} MessageRow
 * @typedef {{row: MessageRow, date: Date, rowIndex: number}} DatedRow
 * @typedef {{selfUrls: Set<string>, selfNames: Set<string>}} SelfContext
 */

/**
 * One message of a selected thread, as the document draws it.
 * @typedef {{direction: 'sent'|'received'|'unknown', timestamp: number, body: string}} ThreadMessage
 */

/**
 * One message of a selected thread before its body is filled in: the index of
 * the input row it came from stands in for the body.
 * @typedef {{direction: 'sent'|'received'|'unknown', timestamp: number, rowIndex: number}} ThreadMessageRef
 */

/**
 * A selected thread whose messages still point at their input rows.
 * @typedef {Omit<SelectedThread, "messages"> & {messages: ThreadMessageRef[]}} SelectedThreadRef
 */

/**
 * One selected thread: who it was with, and the tail of what was said.
 * @typedef {object} SelectedThread
 * @property {string} name - Correspondent names, comma separated
 * @property {string} url - Profile URL of a one-to-one thread, or ""
 * @property {number} messageCount - Messages in the whole thread
 * @property {number} lastTimestamp - Newest message timestamp (ms)
 * @property {ThreadMessage[]} messages - The thread's most recent messages
 */

/**
 * Extract non-self participants and retain anonymous contacts within a conversation.
 * Scope LinkedIn Member placeholders by CONVERSATION ID so unrelated anonymous
 * contacts remain separate. Drop placeholders when there is no ID to scope them.
 * @param {MessageRow} row - Parsed message row
 * @param {SelfContext} context - Self context
 * @param {boolean} keepAnonymous - Whether the row has a conversation to scope anonymity to
 * @returns {Array<{name: string, url: string, anonymous: boolean}>} Participants
 */
function exportParticipants(row, context, keepAnonymous) {
    const named = MessagesAnalytics.extractParticipantsFromRow(row, context).map((participant) => ({
        ...participant,
        anonymous: false,
    }));
    if (!keepAnonymous) {
        return named;
    }

    const seen = new Set(
        named.map((participant) => MessagesAnalytics.buildContactKey(participant)),
    );
    /** @type {Array<{name: string, url: string, anonymous: boolean}>} */
    const anonymous = [];
    /**
     * Keep one anonymized participant, once per contact key.
     * @param {unknown} rawName - Raw participant name
     * @param {unknown} rawUrl - Raw profile URL
     */
    const add = (rawName, rawUrl) => {
        const name = MessagesAnalytics.cleanText(rawName);
        if (MessagesAnalytics.normalizeName(name) !== ANONYMOUS_NAME_KEY) {
            return;
        }
        const url = MessagesAnalytics.normalizeUrl(rawUrl);
        if (MessagesAnalytics.isSelfContact(name, url, context)) {
            return;
        }
        const participant = { name: ANONYMOUS_NAME, url, anonymous: true };
        const key = MessagesAnalytics.buildContactKey(participant);
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        anonymous.push(participant);
    };

    add(row.FROM, row["SENDER PROFILE URL"]);
    const recipientUrls = MessagesAnalytics.normalizeUrlList(row["RECIPIENT PROFILE URLS"]);
    const recipientNames = MessagesAnalytics.parseRecipientNames(row.TO, recipientUrls.length);
    if (recipientUrls.length) {
        // Paired by URL, exactly as extractParticipantsFromRow pairs them, so
        // the two passes agree on how many people a row names. Walking the names
        // instead stopped at the first: `parseRecipientNames` collapses the whole
        // TO field into one name whenever a row carries at most one URL, and a
        // group of anonymized recipients is one name against several URLs. Every
        // recipient past the first was then added by neither pass and vanished.
        recipientUrls.forEach((url, index) =>
            add(recipientNames[index] || recipientNames[0] || "", url),
        );
    } else {
        recipientNames.forEach((name) => add(name, ""));
    }

    return named.concat(anonymous);
}

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
 * Return a parsed message body without trimming its whitespace.
 * @param {unknown} value - Parsed CONTENT cell
 * @returns {string} Message body
 */
function messageBody(value) {
    return typeof value === "string" ? value : "";
}

/**
 * Keep dated rows paired with their parsed dates.
 * Use this same set for owner detection and PDF selection so undated rows
 * cannot change direction labels on the included messages.
 * @param {MessageRow[]} rows - Parsed message rows
 * @returns {DatedRow[]} Dated rows, in file order
 */
function withParsedDates(rows) {
    /** @type {DatedRow[]} */
    const dated = [];

    rows.forEach((row, rowIndex) => {
        const date = MessagesAnalytics.parseDateTime(row.DATE);
        if (date) {
            dated.push({ row, date, rowIndex });
        }
    });

    return dated;
}

/**
 * Map every contact name that is ever seen with a profile URL to that URL.
 *
 * LinkedIn exports include the profile URL on some rows and not others. Without
 * this pass the same person lands under both a `url:` and a `name:` key and
 * shows up as two threads.
 * @param {DatedRow[]} dated - Dated message rows
 * @returns {Map<string, string>} Normalized name to canonical profile URL
 */
function buildNameToUrl(dated) {
    const nameToUrl = new Map();

    for (const { row } of dated) {
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
 * @param {{name: string, url: string, anonymous?: boolean}} participant - Sanitized participant
 * @param {Map<string, string>} nameToUrl - Name to canonical URL lookup
 * @param {string} scope - Conversation scope, for participants with no identity of their own
 * @returns {string} Contact key
 */
function canonicalContactKey(participant, nameToUrl, scope) {
    if (participant.url) {
        return MessagesAnalytics.buildContactKey(participant);
    }
    // "LinkedIn Member" is not a name, so it can only ever mean "the other
    // person in this conversation".
    if (participant.anonymous) {
        return `anon:${scope}`;
    }
    const nameKey = MessagesAnalytics.normalizeName(participant.name);
    const knownUrl = nameToUrl.get(nameKey);
    if (knownUrl) {
        // Built through buildContactKey rather than spelled out, so this module's
        // keys cannot drift from the ones analytics mints.
        return MessagesAnalytics.buildContactKey({ name: participant.name, url: knownUrl });
    }
    return MessagesAnalytics.buildContactKey(participant);
}

/**
 * Resolve the canonical contact key of a row's sender.
 * @param {MessageRow} row - Parsed message row
 * @param {Map<string, string>} nameToUrl - Name to canonical URL lookup
 * @param {string} scope - Conversation scope
 * @returns {string} Contact key, or "" when the sender cannot be identified
 */
function senderContactKey(row, nameToUrl, scope) {
    const name = MessagesAnalytics.cleanText(row.FROM);
    const url = MessagesAnalytics.normalizeUrl(row["SENDER PROFILE URL"]);
    if (!name && !url) {
        return "";
    }
    const anonymous = MessagesAnalytics.normalizeName(name) === ANONYMOUS_NAME_KEY;
    return canonicalContactKey({ name: name || UNKNOWN_NAME, url, anonymous }, nameToUrl, scope);
}

/**
 * Read a row's conversation id.
 * @param {MessageRow} row - Parsed message row
 * @returns {string} Conversation id, or "" when the column is blank
 */
function conversationId(row) {
    return MessagesAnalytics.cleanText(row["CONVERSATION ID"]);
}

/**
 * Build a stable conversation key for one row.
 * @param {MessageRow} row - Parsed message row
 * @param {number} index - Row index, used when the id column is blank
 * @returns {string} Conversation key
 */
function conversationKeyForRow(row, index) {
    return conversationId(row) || `row-${index}`;
}

/**
 * Count the non-blank comma-separated parts of a raw field.
 * @param {unknown} value - Raw cell
 * @returns {number} Part count
 */
function countCommaParts(value) {
    return MessagesAnalytics.cleanText(value)
        .split(",")
        .filter((part) => part.trim()).length;
}

/**
 * The normalized name of a participant, or "" when it is only a placeholder.
 * @param {{name: string}} participant - Sanitized participant
 * @returns {string} Normalized name key, or "" when there is no real name
 */
function realNameKey(participant) {
    const nameKey = MessagesAnalytics.normalizeName(participant.name);
    return nameKey === UNKNOWN_NAME_KEY ? "" : nameKey;
}

/**
 * Check raw recipient fields for evidence of a group conversation.
 * Parsed names can hide multiple recipients when URLs are missing. A comma
 * inside a name may overcount, which prevents an unsafe alias merge.
 * @param {MessageRow} row - Parsed message row
 * @returns {boolean} True when the row names more than one recipient
 */
function namesSeveralRecipients(row) {
    return countCommaParts(row["RECIPIENT PROFILE URLS"]) > 1 || countCommaParts(row.TO) > 1;
}

/**
 * Associate URL-less aliases with a one-to-one conversation's profile URL.
 * Use only conversations with a real CONVERSATION ID, one correspondent per
 * row, and one profile URL. Synthesized keys depend on the identities being
 * resolved and cannot establish that aliases refer to one person.
 * @param {DatedRow[]} dated - Dated message rows
 * @param {SelfContext} context - Resolved self context
 * @returns {Map<string, string>} Normalized name to profile URL
 */
function buildConversationAliases(dated, context) {
    const conversations = new Map();

    for (const { row } of dated) {
        const id = conversationId(row);
        if (!id) {
            continue;
        }

        let conversation = conversations.get(id);
        if (!conversation) {
            conversation = { urls: new Set(), names: new Set(), oneToOne: true };
            conversations.set(id, conversation);
        }

        // Checked before the participant list, which cannot see the difference.
        // `parseRecipientNames` collapses the whole TO field into a single name
        // whenever a row carries at most one recipient URL - which is exactly
        // what a group conversation looks like when the export holds only your
        // own profile URL. That one "name" is then dropped as self, leaving one
        // participant per row: the shape of a one-to-one. The raw fields still
        // say otherwise, so they are counted directly.
        if (namesSeveralRecipients(row)) {
            conversation.oneToOne = false;
            continue;
        }

        const participants = MessagesAnalytics.extractParticipantsFromRow(row, context);
        // A row naming several people proves the conversation is a group.
        if (participants.length > 1) {
            conversation.oneToOne = false;
            continue;
        }
        // A row naming nobody is silent about the shape of the conversation.
        if (!participants.length) {
            continue;
        }

        const [participant] = participants;
        if (participant.url) {
            conversation.urls.add(participant.url);
            continue;
        }
        const nameKey = realNameKey(participant);
        if (nameKey) {
            conversation.names.add(nameKey);
        }
    }

    const aliases = new Map();
    for (const conversation of conversations.values()) {
        // A one-to-one conversation lends its URL only when it has exactly one:
        // none is nothing to lend, and two mean the correspondent is already
        // resolvable both ways.
        if (!conversation.oneToOne || conversation.urls.size !== 1) {
            continue;
        }
        const [url] = conversation.urls;
        for (const nameKey of conversation.names) {
            if (!aliases.has(nameKey)) {
                aliases.set(nameKey, url);
            }
        }
    }

    return aliases;
}

/**
 * Index every identity in the export.
 *
 * For each canonical contact key this records the URLs and names it is seen
 * under, how many conversations it takes part in, and whether it ever sends and
 * ever receives. That is all the evidence there is for deciding which identity
 * is the account owner.
 * @param {DatedRow[]} dated - Dated message rows
 * @param {Map<string, string>} nameToUrl - Name to canonical URL lookup
 * @returns {Map<string, Identity>} Identity index
 */
function buildIdentityIndex(dated, nameToUrl) {
    const identities = new Map();

    dated.forEach(({ row }, index) => {
        const conversationKey = conversationKeyForRow(row, index);
        const senderKey = senderContactKey(row, nameToUrl, conversationKey);

        // Anonymous participants are deliberately absent: "LinkedIn Member" is
        // never the account owner, and each one is scoped to its own
        // conversation, so they would only add noise to the coverage count.
        for (const participant of MessagesAnalytics.extractParticipantsFromRow(row, NO_SELF)) {
            const key = canonicalContactKey(participant, nameToUrl, conversationKey);
            let identity = identities.get(key);
            if (!identity) {
                identity = {
                    urls: new Set(),
                    names: new Set(),
                    conversations: new Set(),
                    sent: 0,
                    received: 0,
                };
                identities.set(key, identity);
            }

            if (participant.url) {
                identity.urls.add(participant.url);
            }
            const nameKey = realNameKey(participant);
            if (nameKey) {
                identity.names.add(nameKey);
            }
            identity.conversations.add(conversationKey);
            if (key === senderKey) {
                identity.sent += 1;
            } else {
                identity.received += 1;
            }
        }
    });

    return identities;
}

/**
 * Select the identity with the widest conversation coverage. Return null on a tie.
 * @param {Identity[]} candidates - Candidate identities
 * @returns {Identity|null} Winning identity, or null when the top two tie
 */
function pickWidestCoverage(candidates) {
    let best = null;
    let tied = false;

    for (const identity of candidates) {
        if (!best || identity.conversations.size > best.conversations.size) {
            best = identity;
            tied = false;
            continue;
        }
        if (identity.conversations.size === best.conversations.size) {
            tied = true;
        }
    }

    return tied ? null : best;
}

/**
 * Remove candidates identified as contacts in the account's connections file.
 * The account owner does not appear in their own connections.
 * @param {Identity[]} candidates - Tied candidates
 * @param {Set<string>} contactKeys - Normalized names and URLs of known connections
 * @returns {Identity[]} Candidates that no connection matches
 */
function withoutKnownContacts(candidates, contactKeys) {
    if (!contactKeys.size) {
        return candidates;
    }
    return candidates.filter((identity) => {
        // A display name is only evidence when there is no URL to check
        // instead. "You are never in your own connections" is true of
        // identities, not of names, and sharing a name with one of your own
        // connections is common enough that trusting a name hit over a profile
        // URL hands the account owner's side of the conversation to the other
        // person, inverting every direction chip in the export.
        const evidence = identity.urls.size ? identity.urls : identity.names;
        return !matchesAny(evidence, contactKeys);
    });
}

/**
 * Report whether any of a set's values is a known key.
 * @param {Set<string>} values - Candidate values
 * @param {Set<string>} keys - Known keys
 * @returns {boolean} True on the first match
 */
function matchesAny(values, keys) {
    for (const value of values) {
        if (keys.has(value)) {
            return true;
        }
    }
    return false;
}

/**
 * Prefer the candidates the connections file does not name, when it separates
 * them.
 * @param {Identity[]} candidates - Candidates
 * @param {Set<string>} contactKeys - Normalized names and URLs of known connections
 * @returns {Identity[]} Strangers, or every candidate when that says nothing
 */
function preferStrangers(candidates, contactKeys) {
    const strangers = withoutKnownContacts(candidates, contactKeys);
    // Only useful when it actually narrowed the field: if every candidate is a
    // connection, or none is, there is nothing new to go on.
    return strangers.length && strangers.length < candidates.length ? strangers : candidates;
}

/**
 * Resolve the account owner from known connections and conversation coverage.
 * First exclude known contacts when that narrows the candidates. Then select
 * a unique candidate with the widest coverage. Return null on a tie.
 * Sent and received counts cannot reliably distinguish the owner.
 * @param {Map<string, Identity>} identities - Identity index
 * @param {Set<string>} contactKeys - Normalized names and URLs of known connections
 * @returns {SelfContext|null} Self context, or null when unidentifiable
 */
function resolveSelfContext(identities, contactKeys) {
    const pool = preferStrangers(Array.from(identities.values()), contactKeys);
    const self = pickWidestCoverage(pool);
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
function fillMissingIdentity(correspondent, participant) {
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
 * Merge a participant into a keyed correspondent map, creating it if new.
 * @param {Map<string, Correspondent>} target - Correspondent map
 * @param {string} key - Canonical contact key
 * @param {{name: string, url: string}} participant - Sanitized participant
 */
function upsertCorrespondent(target, key, participant) {
    const existing = target.get(key);
    if (existing) {
        fillMissingIdentity(existing, participant);
        return;
    }
    target.set(key, { name: participant.name, url: participant.url });
}

/**
 * Record one conversation's correspondents onto a thread.
 * @param {Map<string, Correspondent>} target - Thread correspondents
 * @param {Map<string, Correspondent>} source - Conversation correspondents
 */
function mergeCorrespondents(target, source) {
    for (const [key, correspondent] of source) {
        upsertCorrespondent(target, key, correspondent);
    }
}

/**
 * Build the key that identifies a set of people.
 * @param {Iterable<string>} keys - Canonical contact keys
 * @returns {string} Stable key for the whole set
 */
function correspondentSetKey(keys) {
    return Array.from(keys).sort().join("|");
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
 * @param {MessageEntry[]} entries - Recorded messages with a sequence number
 * @param {number} messagesPerPerson - How many messages to keep
 * @returns {ThreadMessageRef[]} Trimmed messages
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
        direction: entry.direction,
        timestamp: entry.timestamp,
        rowIndex: entry.rowIndex,
    }));
}

/**
 * Group rows into conversations, resolving each one's correspondents.
 * @param {DatedRow[]} dated - Dated message rows
 * @param {SelfContext} context - Self context
 * @param {boolean} selfKnown - Whether the account owner was identified
 * @param {Map<string, string>} nameToUrl - Name to canonical URL lookup
 * @returns {Map<string, {correspondents: Map<string, Correspondent>, entries: MessageEntry[]}>} Conversations
 */
function groupConversations(dated, context, selfKnown, nameToUrl) {
    const conversations = new Map();

    dated.forEach(({ row, date, rowIndex }, index) => {
        const id = conversationId(row);
        const scope = conversationKeyForRow(row, index);
        const participants = exportParticipants(row, context, Boolean(id));
        const participantKeys = participants.map((participant) =>
            canonicalContactKey(participant, nameToUrl, scope),
        );

        // A blank conversation id on a row with no identifiable correspondent
        // (self-only, or an anonymous "LinkedIn Member" with no conversation to
        // be anonymous within) cannot be attributed to anyone at all.
        if (!id && !participantKeys.length) {
            return;
        }
        // correspondentSetKey copies before sorting, so participantKeys stays
        // index-aligned with participants below.
        const key = id ? `id:${id}` : `people:${correspondentSetKey(participantKeys)}`;

        let conversation = conversations.get(key);
        if (!conversation) {
            conversation = { correspondents: new Map(), entries: [] };
            conversations.set(key, conversation);
        }

        participants.forEach((participant, participantIndex) => {
            upsertCorrespondent(
                conversation.correspondents,
                participantKeys[participantIndex],
                participant,
            );
        });

        conversation.entries.push({
            direction: resolveDirection(row, context, selfKnown),
            timestamp: date.getTime(),
            sequence: index,
            rowIndex,
        });
    });

    return conversations;
}

/**
 * Label one row's direction, or admit it is unknown.
 * @param {MessageRow} row - Parsed message row
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
 * @param {Map<string, {correspondents: Map<string, Correspondent>, entries: MessageEntry[]}>} conversations - Conversations
 * @returns {Map<string, {correspondents: Map<string, Correspondent>, lastTimestamp: number, entries: MessageEntry[]}>} Threads
 */
function foldIntoThreads(conversations) {
    const threads = new Map();

    for (const conversation of conversations.values()) {
        // Every row of this conversation was self-only, so there is nobody to
        // attribute it to.
        if (!conversation.correspondents.size) {
            continue;
        }

        const key = correspondentSetKey(conversation.correspondents.keys());
        let thread = threads.get(key);
        if (!thread) {
            thread = {
                correspondents: new Map(),
                lastTimestamp: 0,
                entries: [],
            };
            threads.set(key, thread);
        }

        mergeCorrespondents(thread.correspondents, conversation.correspondents);
        for (const entry of conversation.entries) {
            thread.entries.push(entry);
            thread.lastTimestamp = Math.max(thread.lastTimestamp, entry.timestamp);
        }
    }

    return threads;
}

/**
 * Select recent threads within the distinct-person limit.
 * Include a thread only if every new correspondent fits the remaining limit.
 * Continue after skipping a group so smaller, older threads remain eligible.
 * @template {{correspondents: Map<string, unknown>}} T
 * @param {T[]} threads - Threads, most recent first
 * @param {number} people - Maximum distinct correspondents
 * @returns {T[]} Threads that fit
 */
function takeWithinPeopleBudget(threads, people) {
    const taken = [];
    const included = new Set();

    for (const thread of threads) {
        const added = Array.from(thread.correspondents.keys()).filter((key) => !included.has(key));
        if (included.size + added.length > people) {
            continue;
        }
        for (const key of added) {
            included.add(key);
        }
        taken.push(thread);
        if (included.size === people) {
            break;
        }
    }

    return taken;
}

/**
 * Pick the most recently messaged people and the tail of each conversation.
 *
 * Rows whose date cannot be parsed are skipped before anything else, exactly as
 * `MessagesAnalytics.buildMessageState` does, so they cannot influence which
 * identity is taken to be the account owner.
 *
 * Nothing here reads `CONTENT`, so the rows may leave it out: each message
 * names the input row it came from, and the caller fetches only those bodies.
 * @param {MessageRow[]} rows - Parsed message rows, with or without CONTENT
 * @param {{people?: number, messagesPerPerson?: number, contactKeys?: string[]}} [options] - Selection limits and known connections
 * @returns {SelectedThreadRef[]} Threads, most recent first
 */
export function selectRecentThreadRows(rows, options = {}) {
    const safeRows = Array.isArray(rows) ? rows : [];
    const people = normalizeLimit(options.people, DEFAULT_PEOPLE);
    const messagesPerPerson = normalizeLimit(
        options.messagesPerPerson,
        DEFAULT_MESSAGES_PER_PERSON,
    );
    const contactKeys = new Set(Array.isArray(options.contactKeys) ? options.contactKeys : []);

    const dated = withParsedDates(safeRows);
    const nameToUrl = buildNameToUrl(dated);
    // Indexed over the same dated rows as groupConversations, so a row with a
    // blank CONVERSATION ID gets the same synthesized key in both passes.
    const self = resolveSelfContext(buildIdentityIndex(dated, nameToUrl), contactKeys);
    const context = self || NO_SELF;
    // Aliasing needs to know who self is, so it runs once self is settled and
    // only fills gaps: a name already seen carrying its own URL keeps that URL.
    for (const [nameKey, url] of buildConversationAliases(dated, context)) {
        if (!nameToUrl.has(nameKey)) {
            nameToUrl.set(nameKey, url);
        }
    }
    const conversations = groupConversations(dated, context, Boolean(self), nameToUrl);

    const byRecency = Array.from(foldIntoThreads(conversations).values()).sort(
        (left, right) => right.lastTimestamp - left.lastTimestamp,
    );

    return takeWithinPeopleBudget(byRecency, people).map((thread) => {
        const correspondents = Array.from(thread.correspondents.values());
        return {
            name: correspondents.map(correspondentLabel).join(", "),
            // Only a one-to-one thread has a single profile to point at.
            url: correspondents.length === 1 ? correspondents[0].url : "",
            messageCount: thread.entries.length,
            lastTimestamp: thread.lastTimestamp,
            messages: tailMessages(thread.entries, messagesPerPerson),
        };
    });
}

/**
 * Pick the recent threads from rows that carry their message bodies.
 * @param {MessageRow[]} rows - Parsed message rows, including CONTENT
 * @param {{people?: number, messagesPerPerson?: number, contactKeys?: string[]}} [options] - Selection limits and known connections
 * @returns {SelectedThread[]} Threads, most recent first
 */
export function selectRecentThreads(rows, options = {}) {
    const safeRows = Array.isArray(rows) ? rows : [];
    return selectRecentThreadRows(safeRows, options).map((thread) => ({
        ...thread,
        messages: thread.messages.map(({ direction, timestamp, rowIndex }) => ({
            direction,
            timestamp,
            body: messageBody(safeRows[rowIndex].CONTENT),
        })),
    }));
}
