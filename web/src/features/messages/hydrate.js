/**
 * Rehydration helpers for the messages insights page.
 *
 * The worker serializes its lookup data as plain arrays for transport. These
 * functions rebuild the lookup structures the page renders from. They are
 * pure: every result is derived from the payload argument alone.
 */

/** @typedef {import("./analytics.js").MessageContact} MessageContact */
/** @typedef {import("./analytics.js").MessageEvents} MessageEvents */
/** @typedef {import("./analytics.js").MessageState} MessageState */
/** @typedef {import("./analytics.js").Connection} Connection */
/** @typedef {import("./analytics.js").ConnectionState} ConnectionState */
/** @typedef {import("./messages-worker.js").SerializedMessageState} SerializedMessageState */
/** @typedef {import("./messages-worker.js").SerializedConnectionState} SerializedConnectionState */

/**
 * Rehydrate message state from worker payload.
 * @param {unknown} payload - Worker payload
 * @returns {MessageState}
 */
export function hydrateMessageState(payload) {
    // Worker payloads normally contain an object. Use an empty object for malformed data.
    /* v8 ignore next */
    const safePayload = /** @type {Partial<SerializedMessageState>} */ (payload || {});
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
        skippedRows: Number.isFinite(safePayload.skippedRows)
            ? /** @type {number} */ (safePayload.skippedRows)
            : 0,
        talkedNameKeys: new Set(
            Array.isArray(safePayload.talkedNameKeys) ? safePayload.talkedNameKeys : [],
        ),
        talkedUrlKeys: new Set(
            Array.isArray(safePayload.talkedUrlKeys) ? safePayload.talkedUrlKeys : [],
        ),
        latestTimestamp: Number.isFinite(safePayload.latestTimestamp)
            ? /** @type {number} */ (safePayload.latestTimestamp)
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
 * @param {unknown} payload - Worker payload
 * @returns {ConnectionState}
 */
export function hydrateConnectionState(payload) {
    // Worker payloads normally contain an object. Use an empty object for malformed data.
    /* v8 ignore next */
    const safePayload = /** @type {Partial<SerializedConnectionState>} */ (payload || {});
    const list = Array.isArray(safePayload.list) ? safePayload.list : [];
    /** @type {Map<string, Connection>} */
    const byUrl = new Map();
    /** @type {Map<string, Connection>} */
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
