/* Pure relationship queries over messages and connections state */

import { MessagesAnalytics } from "./analytics.js";
import { MS_PER_DAY } from "./format.js";

/** @typedef {import("./analytics.js").MessageState} MessageState */
/** @typedef {import("./analytics.js").ConnectionState} ConnectionState */
/** @typedef {import("./analytics.js").Connection} Connection */

/**
 * One contact's message totals inside the selected range.
 * @typedef {object} RangeContact
 * @property {string} key - Contact key
 * @property {string} name - Display name ("Unknown" when the contact is missing)
 * @property {string} url - Normalized profile URL, or ""
 * @property {number} count - Messages in range
 * @property {number} lastTimestamp - Latest in-range message timestamp (ms)
 */

/**
 * Top contacts for a range, with range totals.
 * @typedef {object} TopContactsResult
 * @property {RangeContact[]} items - Contacts, most messages first
 * @property {number} totalMessages - Participant events in range
 * @property {number} totalRows - Message rows in range
 * @property {number} totalPeople - Distinct contacts in range
 */

/**
 * A connection that has gone quiet: no message in the past 30 days.
 * @typedef {object} FadingConversation
 * @property {string} name - Contact name
 * @property {string} url - Profile URL, or ""
 * @property {number} daysSince - Whole days since the last message
 * @property {number} lastTimestamp - Latest message timestamp (ms)
 * @property {string} company - Company from the connection record
 */

/**
 * Aggregate top contacts for the selected range.
 * @param {MessageState} messageState - Message analytics state
 * @param {number|null} rangeStart - Start timestamp for selected range
 * @returns {TopContactsResult}
 */
export function getTopContactsInRange(messageState, rangeStart) {
    /** @type {Map<string, {count: number, lastTimestamp: number}>} */
    const rangeCounts = new Map();
    const { contactKeys, contactIds, timestamps } = messageState.events;

    for (let index = 0; index < timestamps.length; index += 1) {
        const timestamp = timestamps[index];
        if (rangeStart && timestamp < rangeStart) {
            continue;
        }
        const contactKey = contactKeys[contactIds[index]];
        const existing = rangeCounts.get(contactKey);
        if (existing) {
            existing.count += 1;
            existing.lastTimestamp = Math.max(existing.lastTimestamp, timestamp);
            continue;
        }
        rangeCounts.set(contactKey, {
            count: 1,
            lastTimestamp: timestamp,
        });
    }

    const items = Array.from(rangeCounts.entries()).map(([contactKey, metric]) => {
        const base = messageState.contacts.get(contactKey);
        return {
            key: contactKey,
            name: base ? base.name : "Unknown",
            url: base ? base.url : "",
            count: metric.count,
            lastTimestamp: metric.lastTimestamp,
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
            (sum, ts) => sum + (ts >= rangeStart ? 1 : 0),
            0,
        );
    }
    return {
        items,
        totalMessages,
        totalRows,
        totalPeople: items.length,
    };
}

/**
 * Get connections that have no messages at all.
 * @param {MessageState} messageState - Message analytics state
 * @param {ConnectionState} connectionState - Connection state
 * @returns {Connection[]}
 */
export function getSilentConnections(messageState, connectionState) {
    const silent = connectionState.list.filter((connection) => {
        const seenByUrl = connection.url && messageState.talkedUrlKeys.has(connection.url);
        const seenByName =
            connection.nameKey && messageState.talkedNameKeys.has(connection.nameKey);
        return !(seenByUrl || seenByName);
    });

    silent.sort((left, right) => {
        const leftTs =
            left.connectedOnTimestamp === null
                ? Number.POSITIVE_INFINITY
                : left.connectedOnTimestamp;
        const rightTs =
            right.connectedOnTimestamp === null
                ? Number.POSITIVE_INFINITY
                : right.connectedOnTimestamp;
        if (leftTs !== rightTs) {
            return leftTs - rightTs;
        }
        return left.name.localeCompare(right.name);
    });

    return silent;
}

/**
 * Get connected contacts with no message in past 30 days.
 * @param {MessageState} messageState - Message analytics state
 * @param {ConnectionState} connectionState - Connection state
 * @returns {FadingConversation[]}
 */
export function getFadingConversations(messageState, connectionState) {
    const now = Date.now();
    /** @type {FadingConversation[]} */
    const fading = [];

    for (const contact of messageState.contacts.values()) {
        const connection = findMatchingConnection(contact, connectionState);
        if (!connection) {
            continue;
        }

        const daysSince = Math.floor((now - contact.lastTimestamp) / MS_PER_DAY);
        if (daysSince < 30) {
            continue;
        }

        fading.push({
            name: contact.name,
            url: contact.url || connection.url || "",
            daysSince,
            lastTimestamp: contact.lastTimestamp,
            company: connection.company,
        });
    }

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
 * @param {ConnectionState} connectionState - Connection state
 * @returns {Connection|null}
 */
function findMatchingConnection(contact, connectionState) {
    if (contact.url && connectionState.byUrl.has(contact.url)) {
        return connectionState.byUrl.get(contact.url) || null;
    }
    const nameKey = MessagesAnalytics.normalizeName(contact.name);
    if (nameKey && connectionState.byName.has(nameKey)) {
        return connectionState.byName.get(nameKey) || null;
    }
    return null;
}
