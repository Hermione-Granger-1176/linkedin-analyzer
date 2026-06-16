/**
 * LinkedIn CSV Cleaner - JavaScript port of Python cleaning logic
 * Original: src/linkedin_analyzer/core/text.py
 *
 * Public facade composed from three focused modules:
 * - csv-parser.js: low-level CSV tokenizing/row splitting
 * - cleaner-configs.js: per-file-type column/validation/skip-row config
 * - field-cleaners.js: cell-level value normalization
 */

import { CONFIGS, FILE_TYPES } from "./cleaner-configs.js";
import { FILE_TYPE_LABELS } from "./constants.js";
import {
    CSV_OPTIONS_COMMENTS,
    CSV_OPTIONS_DEFAULT,
    isRowEmpty,
    parseCsvRows,
} from "./csv-parser.js";
import { CLEANERS, cleanValue, escapeFormula, isMissing } from "./field-cleaners.js";

export const LinkedInCleaner = (() => {
    "use strict";

    const EMPTY_CSV_ERROR = "CSV file is empty or has no data rows";

    // Auto-detection only needs the header row, which sits at the top of the file
    // (after at most a few skip rows). For large files, parse just this prefix to
    // match a type, then full-parse the matched type once — instead of full-parsing
    // the whole file up to three times (one per distinct option/skip-row combo).
    // Files at or below this size skip the pre-pass and use the original full
    // multi-type detection, so small uploads are unaffected.
    const PREFIX_DETECT_CHARS = 64 * 1024;

    /**
     * Check if all required columns in a row have non-missing values.
     * @param {object} row - Row object
     * @param {string[]} requiredColumns - Columns that must be present
     * @returns {boolean}
     */
    function hasRequiredRowValues(row, requiredColumns) {
        if (!requiredColumns.length) {
            return true;
        }
        return requiredColumns.every((column) => !isMissing(row[column]));
    }

    /**
     * Check if at least one column has a non-missing value.
     * @param {object} row - Row object
     * @param {string[]} columns - Columns to scan
     * @returns {boolean}
     */
    function hasAnyRowValue(row, columns) {
        if (!columns.length) {
            return true;
        }
        return columns.some((column) => !isMissing(row[column]));
    }

    /**
     * Strip BOM and whitespace from a single header string.
     * @param {string} header - Raw header value
     * @returns {string} Normalized header
     */
    function normalizeHeader(header) {
        if (typeof header !== "string") {
            return "";
        }
        return header.replace(/^\uFEFF/, "").trim();
    }

    /**
     * Normalize an array of header strings.
     * @param {string[]} headers - Raw header values
     * @returns {string[]} Normalized headers
     */
    function normalizeHeaders(headers) {
        return headers.map(normalizeHeader);
    }

    /**
     * Build parse cache key from file type options.
     * @param {string} fileType - Target file type
     * @returns {string}
     */
    function getParseCacheKey(fileType) {
        const config = CONFIGS[fileType] || null;
        const skipRows = config && Number.isInteger(config.skipRows) ? config.skipRows : 0;
        const optionsKey = fileType === "comments" ? "comments" : "default";
        return `${optionsKey}:${skipRows}`;
    }

    /**
     * Parse CSV text into array of objects
     * @param {string} csvText - Raw CSV text
     * @param {string} [fileType='auto'] - Target file type for CSV options and skip rows
     * @param {Map<string, object>|null} [parseCache=null] - Optional parse cache map
     * @returns {{headers: string[], data: object[], error: string|null}}
     */
    function parseCSV(csvText, fileType = "auto", parseCache = null) {
        const cacheKey = parseCache ? getParseCacheKey(fileType) : null;
        if (parseCache && cacheKey && parseCache.has(cacheKey)) {
            return parseCache.get(cacheKey);
        }

        if (typeof csvText !== "string" || !csvText.trim()) {
            const emptyResult = { headers: [], data: [], error: EMPTY_CSV_ERROR };
            if (parseCache && cacheKey) {
                parseCache.set(cacheKey, emptyResult);
            }
            return emptyResult;
        }

        const csvOptions = fileType === "comments" ? CSV_OPTIONS_COMMENTS : CSV_OPTIONS_DEFAULT;
        let { rows, error } = parseCsvRows(csvText, csvOptions);
        if (error && error.includes("unmatched quote")) {
            ({ rows, error } = parseCsvRows(`${csvText}"`, csvOptions));
        }
        if (error) {
            const errorResult = { headers: [], data: [], error };
            if (parseCache && cacheKey) {
                parseCache.set(cacheKey, errorResult);
            }
            return errorResult;
        }

        if (!rows.length) {
            const emptyRowsResult = { headers: [], data: [], error: EMPTY_CSV_ERROR };
            if (parseCache && cacheKey) {
                parseCache.set(cacheKey, emptyRowsResult);
            }
            return emptyRowsResult;
        }

        const config = CONFIGS[fileType] || null;
        const skipRows = config && Number.isInteger(config.skipRows) ? config.skipRows : 0;
        const rowsAfterSkip = skipRows > 0 ? rows.slice(skipRows) : rows;
        if (!rowsAfterSkip.length) {
            const skipResult = {
                headers: [],
                data: [],
                error: "CSV file has no header rows after skip.",
            };
            if (parseCache && cacheKey) {
                parseCache.set(cacheKey, skipResult);
            }
            return skipResult;
        }

        const headers = normalizeHeaders(rowsAfterSkip[0]);
        if (!headers.length || headers.every((header) => header === "")) {
            const headerResult = { headers: [], data: [], error: "Could not parse CSV headers" };
            if (parseCache && cacheKey) {
                parseCache.set(cacheKey, headerResult);
            }
            return headerResult;
        }

        const headerCount = headers.length;
        const data = [];
        for (let r = 1; r < rowsAfterSkip.length; r += 1) {
            const row = rowsAfterSkip[r];
            if (isRowEmpty(row)) {
                continue;
            }
            // Null-prototype object: CSV headers are user-controlled, so keys
            // like "__proto__" must not mutate the prototype chain.
            const record = Object.create(null);
            for (let c = 0; c < headerCount; c += 1) {
                const value = row[c];
                record[headers[c]] = value !== undefined ? value : "";
            }
            data.push(record);
        }

        const result = { headers, data, error: null };
        if (parseCache && cacheKey) {
            parseCache.set(cacheKey, result);
        }
        return result;
    }

    /**
     * Auto-detect file type based on column headers
     * @param {string[]} headers - Array of column headers
     * @returns {string|null} File type or null if unknown
     */
    function detectFileType(headers) {
        const normalizedHeaders = normalizeHeaders(headers);
        const headerSet = new Set(normalizedHeaders);
        const detectedType = FILE_TYPES.find((type) => {
            const requiredColumns = CONFIGS[type].requiredColumns;
            return requiredColumns.every((column) => headerSet.has(column));
        });
        return detectedType || null;
    }

    /**
     * Find all supported file types that can parse and validate the given CSV text.
     * @param {string} csvText - Raw CSV text
     * @param {Map<string, object>|null} [parseCache=null] - Optional parse cache map
     * @returns {Array<{type: string, headers: string[], data: object[]}>}
     */
    function detectMatchingFileTypes(csvText, parseCache = null) {
        const matches = [];
        for (const type of FILE_TYPES) {
            const parsed = parseCSV(csvText, type, parseCache);
            if (parsed.error) {
                continue;
            }
            const validation = validateColumns(parsed.headers, type);
            if (!validation.valid) {
                continue;
            }
            matches.push({
                type,
                headers: parsed.headers,
                data: parsed.data,
            });
        }
        return matches;
    }

    /**
     * Cheaply detect a file's type from its header row by parsing only a prefix
     * of the text. Returns the first supported type (in FILE_TYPES order) whose
     * required columns are present, or null when no prefix match is found.
     *
     * A truncated tail can only corrupt the prefix's last row, never the header
     * at the top, so a positive match is reliable; a null result falls back to
     * full multi-type detection in the caller, which keeps behaviour identical.
     * Uses a throwaway parse cache so truncated parses never poison the caller's
     * full-parse cache.
     * @param {string} csvText - Raw CSV text
     * @returns {string|null} Detected file type, or null if unknown from the prefix
     */
    function detectTypeFromPrefix(csvText) {
        const prefix = csvText.slice(0, PREFIX_DETECT_CHARS);
        const prefixCache = new Map();
        for (const type of FILE_TYPES) {
            const parsed = parseCSV(prefix, type, prefixCache);
            if (parsed.error) {
                continue;
            }
            if (validateColumns(parsed.headers, type).valid) {
                return type;
            }
        }
        return null;
    }

    /**
     * Validate that required columns exist in the data
     * @param {string[]} headers - Array of column headers
     * @param {string} fileType - Supported file type
     * @returns {{valid: boolean, missing: string[]}}
     */
    function validateColumns(headers, fileType) {
        const config = CONFIGS[fileType];
        if (!config) {
            return { valid: false, missing: ["Unknown file type"] };
        }

        const normalizedHeaders = normalizeHeaders(headers);
        const headerSet = new Set(normalizedHeaders);
        const missing = config.requiredColumns.filter((column) => !headerSet.has(column));

        return {
            valid: missing.length === 0,
            missing,
        };
    }

    /**
     * Clean the parsed data based on file type
     * @param {object[]} data - Parsed CSV data as array of objects
     * @param {string} fileType - Supported file type
     * @returns {object[]} Cleaned data
     */
    function cleanData(data, fileType) {
        const config = CONFIGS[fileType];
        if (!config) {
            return data;
        }

        const requiredRowColumns = Array.isArray(config.requiredRowColumns)
            ? config.requiredRowColumns
            : config.requiredColumns;
        const dropIfAllMissing = Array.isArray(config.dropIfAllMissing)
            ? config.dropIfAllMissing
            : [];

        // Clean and filter in a single pass to avoid intermediate arrays.
        const cleanedRows = [];
        for (const row of data) {
            const cleanedRow = {};
            config.columns.forEach((column) => {
                const value = row[column.name];
                const cleaner = column.cleaner ? CLEANERS[column.cleaner] : null;
                const cleanedValue = cleaner ? cleaner(value) : cleanValue(value);
                cleanedRow[column.name] = escapeFormula(cleanedValue);
            });

            if (!hasRequiredRowValues(cleanedRow, requiredRowColumns)) {
                continue;
            }
            if (dropIfAllMissing.length && !hasAnyRowValue(cleanedRow, dropIfAllMissing)) {
                continue;
            }
            cleanedRows.push(cleanedRow);
        }

        return cleanedRows;
    }

    /**
     * Build a user-friendly error message for column validation failures.
     * @param {string} selectedType - The file type selected by the user ('shares', 'comments', 'messages', 'connections', or 'auto')
     * @param {string|null} detectedType - The auto-detected file type, or null
     * @param {string[]} missing - List of missing required column names
     * @returns {string} Descriptive error message
     */
    function buildColumnErrorMessage(selectedType, detectedType, missing) {
        if (selectedType !== "auto" && detectedType && detectedType !== selectedType) {
            const selectedLabel = FILE_TYPE_LABELS[selectedType] || selectedType;
            const detectedLabel = FILE_TYPE_LABELS[detectedType] || detectedType;
            return `This looks like a ${detectedLabel} file, but you selected ${selectedLabel}. Please switch to "${detectedLabel}" or "Auto-detect".`;
        }

        if (selectedType !== "auto" && !detectedType) {
            const selectedLabel = FILE_TYPE_LABELS[selectedType] || selectedType;
            return `This file doesn't appear to be a LinkedIn ${selectedLabel} export. Missing columns: ${missing.join(", ")}. Please check that you uploaded the correct file.`;
        }

        // Unreachable in practice: process() only calls this on the non-"auto"
        // path, so selectedType is never "auto" and one of the branches above
        // always returns. Kept as a defensive default.
        /* v8 ignore next */
        return `Missing required columns: ${missing.join(", ")}`;
    }

    /**
     * Build a standardised process() result object.
     * @param {boolean} success - Whether processing succeeded
     * @param {string|null} error - Error message, or null on success
     * @param {object} [overrides] - Fields that differ from the empty defaults
     * @returns {object}
     */
    function makeResult(success, error, overrides = {}) {
        return {
            success,
            fileType: null,
            detectedType: null,
            headers: [],
            cleanedData: [],
            rowCount: 0,
            error,
            ...overrides,
        };
    }

    /**
     * Process a CSV file completely
     * @param {string} csvText - Raw CSV text
     * @param {string} fileType - Supported file type or 'auto'
     * @returns {object}
     */
    function process(csvText, fileType = "auto") {
        const parseCache = new Map();

        if (fileType === "auto") {
            // Fast path for large files: detect the type from a small prefix, then
            // full-parse only the matched type once. Falls through to full
            // multi-type detection on a prefix miss or if the matched type fails
            // to parse/validate on the whole file, so the result is unchanged.
            if (typeof csvText === "string" && csvText.length > PREFIX_DETECT_CHARS) {
                const prefixType = detectTypeFromPrefix(csvText);
                if (prefixType) {
                    const parsed = parseCSV(csvText, prefixType, parseCache);
                    if (!parsed.error && validateColumns(parsed.headers, prefixType).valid) {
                        const cleanedData = cleanData(parsed.data, prefixType);
                        return makeResult(true, null, {
                            fileType: prefixType,
                            detectedType: prefixType,
                            headers: parsed.headers,
                            cleanedData,
                            rowCount: cleanedData.length,
                        });
                    }
                }
            }

            const matches = detectMatchingFileTypes(csvText, parseCache);
            if (matches.length) {
                const selected = matches[0];
                const cleanedData = cleanData(selected.data, selected.type);
                return makeResult(true, null, {
                    fileType: selected.type,
                    detectedType: selected.type,
                    headers: selected.headers,
                    cleanedData,
                    rowCount: cleanedData.length,
                });
            }

            const initialParse = parseCSV(csvText, "auto", parseCache);
            if (initialParse.error) {
                return makeResult(false, initialParse.error);
            }
            return makeResult(
                false,
                "Could not auto-detect file type. This file does not appear to be a LinkedIn Shares, Comments, Messages, or Connections export. Please check that you uploaded the correct file.",
                {
                    headers: initialParse.headers,
                    rowCount: initialParse.data.length,
                },
            );
        }

        const parsed = parseCSV(csvText, fileType, parseCache);
        if (parsed.error) {
            return makeResult(false, parsed.error);
        }

        const { headers, data } = parsed;
        let detectedType = detectFileType(headers);
        const validation = validateColumns(headers, fileType);
        if (!validation.valid) {
            detectedType =
                detectedType ||
                detectMatchingFileTypes(csvText, parseCache).find(
                    (match) => match.type !== fileType,
                )?.type ||
                null;
            return makeResult(
                false,
                buildColumnErrorMessage(fileType, detectedType, validation.missing),
                {
                    fileType,
                    detectedType,
                    headers,
                    rowCount: data.length,
                },
            );
        }

        const cleanedData = cleanData(data, fileType);

        return makeResult(true, null, {
            fileType,
            detectedType,
            headers,
            cleanedData,
            rowCount: cleanedData.length,
        });
    }

    return {
        configs: CONFIGS,
        process,
        parseCSV,
        detectFileType,
        validateColumns,
    };
})();
