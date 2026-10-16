/**
 * Per-file-type configuration for the LinkedIn cleaner.
 *
 * Column definitions, required-column/skip-row settings, and CSV parse options
 * used by auto-detection and processing. Consumed by the LinkedInCleaner facade
 * in cleaner.js.
 */

import { FILE_TYPES as SHARED_FILE_TYPES } from "../../shared/constants.js";

/**
 * A supported LinkedIn export type.
 * @typedef {"shares"|"comments"|"messages"|"connections"} FileType
 */

// Re-exported so existing `import { FILE_TYPES } from "./configs.js"`
// call sites keep working; the canonical definition lives in constants.js, a
// dependency-free module that stays out of the worker bundle graph. Same array,
// narrowed to the FileType union.
export const FILE_TYPES = /** @type {readonly FileType[]} */ (SHARED_FILE_TYPES);

/**
 * One output column of a cleaned file.
 * @typedef {object} ColumnConfig
 * @property {string} name - Column header, as it appears in the CSV and the output
 * @property {number} width - Excel column width
 * @property {boolean} [wrapText] - Whether Excel wraps the cell text
 * @property {import("./field-cleaners.js").CleanerName} [cleaner] - Named cell cleaner
 */

/**
 * Column, validation, and output configuration for one file type.
 * @typedef {object} CleanerConfig
 * @property {readonly ColumnConfig[]} columns - Output columns, in order
 * @property {readonly string[]} requiredColumns - Headers that must be present
 * @property {readonly string[]} [requiredRowColumns] - Columns a kept row needs (default:
 * requiredColumns)
 * @property {readonly string[]} [dropIfAllMissing] - Drop a row when all are missing
 * @property {string} outputName - Download filename for the cleaned workbook
 * @property {number} [skipRows] - Preamble rows before the header row
 */

/** @typedef {Readonly<Record<FileType, CleanerConfig>>} CleanerConfigsByType */
/** @typedef {Readonly<Partial<Record<string, CleanerConfig>>>} CleanerConfigsByName */

/**
 * Configs keyed by file type. Indexing with an arbitrary string may miss.
 * @typedef {CleanerConfigsByType & CleanerConfigsByName} CleanerConfigs
 */

/**
 * Deep-freeze a cleaner configuration object.
 * @param {CleanerConfig} config - Configuration with columns, requiredColumns, and outputName
 * @returns {CleanerConfig} Frozen configuration object
 */
function freezeConfig(config) {
    const frozenColumns = config.columns.map((column) => Object.freeze({ ...column }));
    return Object.freeze({
        ...config,
        columns: Object.freeze(frozenColumns),
    });
}

/**
 * Per-file-type column, validation, and output configuration.
 * @type {CleanerConfigs}
 */
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
