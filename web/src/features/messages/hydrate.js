/**
 * Rehydration helpers for the messages insights page.
 *
 * The worker serializes its lookup data as plain arrays for transport. These
 * functions rebuild the lookup structures the page renders from. They are
 * pure: every result is derived from the payload argument alone.
 */

/**
 * @typedef {object} MessageContact
 * @property {string} key
 * @property {string} name
 * @property {string} url
 * @property {number} count
 * @property {number} lastTimestamp
 */

/**
 * @typedef {object} MessageState
 * @property {Map<string, MessageContact>} contacts
 * @property {Array<{contactKey: string, timestamp: number}>} events
 * @property {number[]} rowTimestamps
 * @property {number} skippedRows
 * @property {Set<string>} talkedNameKeys
 * @property {Set<string>} talkedUrlKeys
 * @property {number} latestTimestamp
 * @property {object|null} outreach
 */

/**
 * Rehydrate message state from worker payload.
 * @param {object|null} payload - Worker payload
 * @returns {MessageState}
 */
export function hydrateMessageState(payload) {
    // Worker payloads normally contain an object. Use an empty object for malformed data.
    /* v8 ignore next */
    const safePayload = payload || {};
    /** @type {Map<string, MessageContact>} */
    const contacts = new Map();
    const contactList = Array.isArray(safePayload.contacts) ? safePayload.contacts : [];
    for (const contact of contactList) {
        if (!contact || !contact.key) {
            continue;
        }
        contacts.set(contact.key, contact);
    }

    return {
        contacts,
        events: Array.isArray(safePayload.events) ? safePayload.events : [],
        rowTimestamps: Array.isArray(safePayload.rowTimestamps) ? safePayload.rowTimestamps : [],
        skippedRows: Number.isFinite(safePayload.skippedRows) ? safePayload.skippedRows : 0,
        talkedNameKeys: new Set(
            Array.isArray(safePayload.talkedNameKeys) ? safePayload.talkedNameKeys : [],
        ),
        talkedUrlKeys: new Set(
            Array.isArray(safePayload.talkedUrlKeys) ? safePayload.talkedUrlKeys : [],
        ),
        latestTimestamp: Number.isFinite(safePayload.latestTimestamp)
            ? safePayload.latestTimestamp
            : 0,
        outreach: safePayload.outreach || null,
    };
}

/**
 * Rehydrate connection state from worker payload.
 * @param {object|null} payload - Worker payload
 * @returns {{list: object[], byUrl: Map<string, object>, byName: Map<string, object>}}
 */
export function hydrateConnectionState(payload) {
    // Worker payloads normally contain an object. Use an empty object for malformed data.
    /* v8 ignore next */
    const safePayload = payload || {};
    const list = Array.isArray(safePayload.list) ? safePayload.list : [];
    const byUrl = new Map();
    const byName = new Map();

    for (const connection of list) {
        // Worker output contains object rows. Ignore null entries in malformed data.
        /* v8 ignore next 3 */
        if (!connection) {
            continue;
        }
        if (connection.url && !byUrl.has(connection.url)) {
            byUrl.set(connection.url, connection);
        }
        if (connection.nameKey && !byName.has(connection.nameKey)) {
            byName.set(connection.nameKey, connection);
        }
    }

    return { list, byUrl, byName };
}
