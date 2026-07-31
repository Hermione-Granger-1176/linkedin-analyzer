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
 * @typedef {{direction: 'sent'|'received'|'unknown', timestamp: number, sequence: number, body: string}} MessageEntry
 * @typedef {{row: object, date: Date}} DatedRow
 * @typedef {{selfUrls: Set<string>, selfNames: Set<string>}} SelfContext
 */

/**
 * Extract a row's non-self participants for the export.
 *
 * `MessagesAnalytics.extractParticipantsFromRow` drops anyone named "LinkedIn
 * Member" outright, which is right for analytics - those placeholders belong to
 * different people and must not be counted as one contact - but wrong here. The
 * export promises the last people you messaged, and dropping the placeholder
 * leaves a conversation with no correspondent at all, so `foldIntoThreads`
 * discards it and a recent exchange disappears from the document entirely.
 *
 * So the placeholder is kept when the row carries a `CONVERSATION ID`, which
 * gives it a scope to be anonymous within: `canonicalContactKey` keys it to that
 * conversation, so two unrelated anonymous conversations never merge into one
 * person. Without an id there is no such scope and nothing to attribute the row
 * to, so it is dropped as before.
 * @param {object} row - Parsed message row
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
    const anonymous = [];
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
 * @returns {DatedRow[]} Dated rows, in file order
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
 * @param {object} row - Parsed message row
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
 * @param {object} row - Parsed message row
 * @returns {string} Conversation id, or "" when the column is blank
 */
function conversationId(row) {
    return MessagesAnalytics.cleanText(row["CONVERSATION ID"]);
}

/**
 * Build a stable conversation key for one row.
 * @param {object} row - Parsed message row
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
 * Report whether one row proves its conversation has more than two people.
 *
 * Counted off the raw fields rather than the parsed participants, because the
 * participant list is exactly what loses this information when a group export
 * carries at most one recipient URL. Splitting on commas can over-count a name
 * that contains one, and that is the safe direction: the only thing this
 * decides is whether a conversation may lend a profile URL to a bare name, and
 * declining to keeps two people apart rather than merging them.
 * @param {object} row - Parsed message row
 * @returns {boolean} True when the row names more than one recipient
 */
function namesSeveralRecipients(row) {
    return countCommaParts(row["RECIPIENT PROFILE URLS"]) > 1 || countCommaParts(row.TO) > 1;
}

/**
 * Link a one-to-one conversation's URL-less aliases to that conversation's URL.
 *
 * `buildNameToUrl` can only join a name to a URL when it has seen that exact
 * name carrying that URL. A contact who is renamed mid-thread and whose new name
 * never appears with a profile URL - "Ada Lovelace" with a URL, then "Ada L."
 * without one - therefore stays two identities: the conversation looks like a
 * group of two, and a later conversation under the URL becomes a separate
 * thread, burning two of the ten slots on one person.
 *
 * A conversation whose every row has exactly one correspondent settles it: every
 * alias in it is the same person, so any URL seen there is theirs. Only
 * conversations with a real `CONVERSATION ID` qualify, because a synthesized key
 * is built from the very identities this is trying to reconcile.
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
 * Pick the identity with the widest conversation coverage, or nothing on a tie.
 *
 * A tie is the case this module refuses to guess at: picking the first one
 * inserted is exactly how a single received message ends up attributed to the
 * wrong person.
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
 * Narrow tied candidates to the ones who are not in the user's connections.
 *
 * Coverage ties whenever the export holds a single conversation, however many
 * messages it has: both people appear in exactly one, and both send and
 * receive, so the message file alone genuinely cannot say which is the account
 * owner. The connections file can. Someone you are connected to is in it; you
 * are never in your own connections, so an identity that appears there is not
 * you.
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
 * Resolve the account owner from the identity index.
 *
 * The connections file is consulted first, because it is a fact about the
 * export rather than a heuristic over it: you are never in your own
 * connections, so anybody it names is not the account owner. Consulting it only
 * after the counting had tied meant it was never reached in the cases where the
 * counting confidently reached the wrong answer.
 *
 * What remains is conversation coverage. The account owner is in every
 * conversation and everyone else is in their own, so the widest coverage is the
 * owner, and it decides alone. Requiring the owner to have both sent and
 * received cannot be a filter (an inbox nobody has replied to has an owner who
 * sends nothing), and as a preference it can only ever agree with coverage or
 * overrule a tie the export has no business overruling.
 *
 * A winner that is not unique means self genuinely cannot be identified, and
 * the export says so rather than guessing.
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
        direction: entry.direction,
        timestamp: entry.timestamp,
        body: entry.body,
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

    dated.forEach(({ row, date }, index) => {
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
 * Take the most recent threads without exceeding the promised head count.
 *
 * The limit is a number of *people*, which is what the dialog promises and what
 * bounds how much personal data the file carries. Counting threads instead let
 * one eight-person group conversation plus nine one-to-one threads put
 * seventeen people into a document configured for ten.
 *
 * A thread is taken only when everyone new in it fits the remaining budget, and
 * later threads are still considered: skipping an oversized group does not stop
 * a smaller, older one-to-one thread from being included. A single group larger
 * than the whole budget therefore never appears, which is the honest reading of
 * the promise rather than an edge case to work around.
 * @param {Array<{correspondents: Map<string, object>}>} threads - Threads, most recent first
 * @param {number} people - Maximum distinct correspondents
 * @returns {Array<object>} Threads that fit
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
 * @param {object[]} rows - Parsed message rows, including CONTENT
 * @param {{people?: number, messagesPerPerson?: number, contactKeys?: string[]}} [options] - Selection limits and known connections
 * @returns {Array<{name: string, url: string, messageCount: number, lastTimestamp: number, messages: Array<{direction: 'sent'|'received'|'unknown', timestamp: number, body: string}>}>} Threads, most recent first
 */
export function selectRecentThreads(rows, options = {}) {
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
