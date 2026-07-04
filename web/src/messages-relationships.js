/* Pure relationship queries over messages and connections state */

import { MessagesAnalytics } from "./messages-analytics.js";
import { MS_PER_DAY } from "./messages-format.js";

/**
 * Aggregate top contacts for the selected range.
 * @param {object} messageState - Message analytics state
 * @param {number|null} rangeStart - Start timestamp for selected range
 * @returns {{items: object[], totalMessages: number, totalRows: number, totalPeople: number}}
 */
export function getTopContactsInRange(messageState, rangeStart) {
    const rangeCounts = new Map();

    messageState.events.forEach((event) => {
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
            lastTimestamp: event.timestamp,
        });
    });

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
 * @param {object} messageState - Message analytics state
 * @param {object} connectionState - Connection state
 * @returns {object[]}
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
 * @param {object} messageState - Message analytics state
 * @param {object} connectionState - Connection state
 * @returns {object[]}
 */
export function getFadingConversations(messageState, connectionState) {
    const now = Date.now();
    const fading = [];

    messageState.contacts.forEach((contact) => {
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
            url: contact.url || connection.url || "",
            daysSince,
            lastTimestamp: contact.lastTimestamp,
            company: connection.company,
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
    const nameKey = MessagesAnalytics.normalizeName(contact.name);
    if (nameKey && connectionState.byName.has(nameKey)) {
        return connectionState.byName.get(nameKey) || null;
    }
    return null;
}
