/**
 * Per-file-type configuration for the LinkedIn cleaner.
 *
 * Column definitions, required-column/skip-row settings, and CSV parse options
 * used by auto-detection and processing. Consumed by the LinkedInCleaner facade
 * in cleaner.js.
 */

/** Supported file types, in auto-detection priority order. */
export const FILE_TYPES = Object.freeze(["shares", "comments", "messages", "connections"]);

/**
 * Deep-freeze a cleaner configuration object.
 * @param {object} config - Configuration with columns, requiredColumns, and outputName
 * @returns {object} Frozen configuration object
 */
function freezeConfig(config) {
    const frozenColumns = config.columns.map((column) => Object.freeze({ ...column }));
    return Object.freeze({
        ...config,
        columns: Object.freeze(frozenColumns),
    });
}

/** Per-file-type column, validation, and output configuration. */
export const CONFIGS = Object.freeze({
    shares: freezeConfig({
        columns: [
            { name: "Date", width: 20, cleaner: "cleanDate" },
            { name: "ShareLink", width: 60 },
            {
                name: "ShareCommentary",
                width: 100,
                wrapText: true,
                cleaner: "cleanSharesCommentary",
            },
            { name: "SharedUrl", width: 30, cleaner: "cleanEmptyField" },
            { name: "MediaUrl", width: 30, cleaner: "cleanEmptyField" },
            { name: "Visibility", width: 18 },
        ],
        requiredColumns: ["Date", "ShareLink", "ShareCommentary"],
        outputName: "Shares.xlsx",
    }),
    comments: freezeConfig({
        columns: [
            { name: "Date", width: 20, cleaner: "cleanDate" },
            { name: "Link", width: 60 },
            { name: "Message", width: 100, wrapText: true, cleaner: "cleanCommentsMessage" },
        ],
        requiredColumns: ["Date", "Link", "Message"],
        outputName: "Comments.xlsx",
    }),
    messages: freezeConfig({
        columns: [
            { name: "FROM", width: 24 },
            { name: "TO", width: 24 },
            { name: "DATE", width: 20, cleaner: "cleanDate" },
            { name: "CONTENT", width: 100, wrapText: true, cleaner: "cleanMessagesContent" },
            { name: "FOLDER", width: 16 },
            { name: "CONVERSATION ID", width: 40 },
            { name: "SENDER PROFILE URL", width: 48, cleaner: "cleanEmptyField" },
            { name: "RECIPIENT PROFILE URLS", width: 48, cleaner: "cleanEmptyField" },
        ],
        requiredColumns: ["FROM", "TO", "DATE", "CONTENT"],
        outputName: "Messages.xlsx",
    }),
    connections: freezeConfig({
        columns: [
            { name: "First Name", width: 20 },
            { name: "Last Name", width: 20 },
            { name: "URL", width: 50, cleaner: "cleanEmptyField" },
            { name: "Email Address", width: 32, cleaner: "cleanEmptyField" },
            { name: "Company", width: 30 },
            { name: "Position", width: 30 },
            { name: "Connected On", width: 20, cleaner: "cleanConnectionsDate" },
        ],
        requiredColumns: ["First Name", "Last Name", "Connected On"],
        requiredRowColumns: ["Connected On"],
        dropIfAllMissing: ["First Name", "Last Name", "URL"],
        outputName: "Connections.xlsx",
        skipRows: 3,
    }),
});
