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
 * Message events stored as columns, one entry per participant per message.
 * contactIds[i] indexes contactKeys; timestamps[i] is the message time.
 * @typedef {object} MessageEvents
 * @property {string[]} contactKeys
 * @property {Int32Array} contactIds
 * @property {Float64Array} timestamps
 */

/**
 * @typedef {object} MessageState
 * @property {Map<string, MessageContact>} contacts
 * @property {MessageEvents} events
 * @property {Float64Array} rowTimestamps
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
        events: hydrateEvents(safePayload.events),
        rowTimestamps:
            safePayload.rowTimestamps instanceof Float64Array
                ? safePayload.rowTimestamps
                : new Float64Array(0),
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
 * Accept the worker's event columns, or empty columns when they are malformed.
 * @param {unknown} events - Worker events payload
 * @returns {MessageEvents}
 */
function hydrateEvents(events) {
    const candidate = /** @type {Partial<MessageEvents>|null} */ (events);
    if (
        candidate &&
        Array.isArray(candidate.contactKeys) &&
        candidate.contactIds instanceof Int32Array &&
        candidate.timestamps instanceof Float64Array &&
        candidate.contactIds.length === candidate.timestamps.length
    ) {
        return {
            contactKeys: candidate.contactKeys,
            contactIds: candidate.contactIds,
            timestamps: candidate.timestamps,
        };
    }
    return { contactKeys: [], contactIds: new Int32Array(0), timestamps: new Float64Array(0) };
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
