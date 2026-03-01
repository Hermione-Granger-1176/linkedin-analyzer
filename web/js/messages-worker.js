/* LinkedIn Analyzer - Messages parsing worker */

const WORKER_VERSION = '20260228-1';
if (typeof importScripts === 'function') {
    importScripts(`cleaner.js?v=${WORKER_VERSION}`);
}

/**
 * Parse messages and connections CSV payload.
 * @param {{messagesCsv?: string, connectionsCsv?: string}} payload - Raw CSV payload
 * @returns {{success: boolean, messagesData?: object[], connectionsData?: object[], connectionError?: string|null, error?: string}}
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

    return {
        success: true,
        messagesData: messagesResult.cleanedData,
        connectionsData,
        connectionError
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
