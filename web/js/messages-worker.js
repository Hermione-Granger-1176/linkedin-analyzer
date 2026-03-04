/* LinkedIn Analyzer - Messages parsing worker */
/* global MessagesAnalytics */

if (typeof importScripts === 'function') {
    importScripts('cleaner.js', 'messages-analytics.js');
}

/**
 * Parse messages and connections CSV payload.
 * @param {{messagesCsv?: string, connectionsCsv?: string}} payload - Raw CSV payload
 * @returns {{success: boolean, messageState?: object, connectionState?: object, totalInputRows?: number, connectionError?: string|null, error?: string, messagesData?: object[], connectionsData?: object[]}}
 */
function processPayload(payload) {
    const messagesCsv = typeof payload.messagesCsv === 'string' ? payload.messagesCsv : '';
    const connectionsCsv = typeof payload.connectionsCsv === 'string' ? payload.connectionsCsv : '';

    const messagesResult = LinkedInCleaner.process(messagesCsv, 'messages');
    if (!messagesResult.success) {
        return {
            success: false,
            error: messagesResult.error || 'Unable to parse messages.csv.'
        };
    }

    let connectionsData = [];
    let connectionError = null;

    if (connectionsCsv) {
        const connectionsResult = LinkedInCleaner.process(connectionsCsv, 'connections');
        if (connectionsResult.success) {
            connectionsData = connectionsResult.cleanedData;
        } else {
            connectionError = connectionsResult.error || 'Unable to parse Connections.csv.';
        }
    }

    const messagesData = messagesResult.cleanedData;
    const messageState = typeof MessagesAnalytics !== 'undefined'
        ? MessagesAnalytics.buildMessageState(messagesData)
        : null;
    const connectionState = typeof MessagesAnalytics !== 'undefined'
        ? MessagesAnalytics.buildConnectionState(connectionsData)
        : null;

    return {
        success: true,
        totalInputRows: messagesData.length,
        messageState: messageState ? serializeMessageState(messageState) : null,
        connectionState: connectionState ? serializeConnectionState(connectionState) : null,
        connectionError,
        messagesData: messageState ? [] : messagesData,
        connectionsData: connectionState ? [] : connectionsData
    };
}

/**
 * Serialize message state for structured clone.
 * @param {object} state - Message state with Maps/Sets
 * @returns {object}
 */
function serializeMessageState(state) {
    return {
        contacts: Array.from(state.contacts.values()),
        events: state.events,
        rowTimestamps: state.rowTimestamps,
        skippedRows: state.skippedRows,
        talkedNameKeys: Array.from(state.talkedNameKeys),
        talkedUrlKeys: Array.from(state.talkedUrlKeys),
        latestTimestamp: state.latestTimestamp
    };
}

/**
 * Serialize connection state for structured clone.
 * @param {object} state - Connection state with Maps
 * @returns {object}
 */
function serializeConnectionState(state) {
    return {
        list: state.list
    };
}

if (typeof self !== 'undefined') {
    self.addEventListener('message', (event) => {
        const message = event.data || {};
        if (message.type !== 'process') {
            return;
        }

        const requestId = message.requestId;
        const payload = processPayload(message.payload || {});
        self.postMessage({
            type: 'processed',
            requestId,
            payload
        });
    });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { processPayload };
}
