/**
 * Build and read the column form of message events in tests.
 */

/**
 * Turn readable event objects into the event columns the messages state uses.
 * @param {Array<{contactKey: string, timestamp: number}>} entries - Events in order
 * @returns {{contactKeys: string[], contactIds: Int32Array, timestamps: Float64Array}}
 */
export function compactEvents(entries) {
    const contactKeys = [];
    const ids = new Map();
    const contactIds = Int32Array.from(entries, (entry) => {
        if (!ids.has(entry.contactKey)) {
            ids.set(entry.contactKey, contactKeys.length);
            contactKeys.push(entry.contactKey);
        }
        return ids.get(entry.contactKey);
    });
    const timestamps = Float64Array.from(entries, (entry) => entry.timestamp);
    return { contactKeys, contactIds, timestamps };
}

/**
 * Turn event columns back into readable event objects.
 * @param {{contactKeys: string[], contactIds: Int32Array, timestamps: Float64Array}} events - Event columns
 * @returns {Array<{contactKey: string, timestamp: number}>}
 */
export function expandEvents(events) {
    return Array.from(events.timestamps, (timestamp, index) => ({
        contactKey: events.contactKeys[events.contactIds[index]],
        timestamp,
    }));
}
