/**
 * LinkedIn CSV Cleaner - JavaScript port of Python cleaning logic
 * Original: src/linkedin_analyzer/core/text.py
 *
 * Public facade composed from three focused modules:
 * - csv-parser.js: low-level CSV tokenizing/row splitting
 * - configs.js: per-file-type column/validation/skip-row config
 * - field-cleaners.js: cell-level value normalization
 */

import { FILE_TYPE_LABELS } from "../../shared/constants.js";

import { CONFIGS, FILE_TYPES } from "./configs.js";
import {
    CSV_OPTIONS_COMMENTS,
    CSV_OPTIONS_DEFAULT,
    createCsvRowParser,
    isRowEmpty,
    parseCsvRows,
} from "./csv-parser.js";
import {
    CLEANERS,
    cleanValue,
    escapeFormula,
    isMissing,
    removeIllegalChars,
} from "./field-cleaners.js";
import { createStringPool } from "./string-pool.js";

/** @typedef {import("./configs.js").FileType} FileType */
/** @typedef {import("./configs.js").CleanerConfig} CleanerConfig */
/** @typedef {import("./csv-parser.js").CsvRowParser} CsvRowParser */

/**
 * One parsed CSV data row, keyed by normalized header. Null-prototype object.
 * @typedef {Record<string, string>} CsvRecord
 */

/**
 * One cleaned row, keyed by the file type's configured column names.
 * @typedef {Record<string, string>} CleanedRow
 */

/**
 * Result of LinkedInCleaner.parseCSV().
 * @typedef {object} ParsedCsv
 * @property {string[]} headers - Normalized header names
 * @property {CsvRecord[]} data - Data rows
 * @property {string|null} error - Parse error, or null on success
 */

/**
 * Result of LinkedInCleaner.validateColumns().
 * @typedef {object} ColumnValidation
 * @property {boolean} valid - Whether every required column is present
 * @property {string[]} missing - Missing required columns
 */

/**
 * Result of LinkedInCleaner.process() and of a stream processor's finish().
 * @typedef {object} ProcessResult
 * @property {boolean} success - Whether the file parsed, validated, and cleaned
 * @property {string|null} fileType - Type processed as (requested type on a mismatch), or null
 * @property {FileType|null} detectedType - Type detected from the headers, or null
 * @property {string[]} headers - Normalized CSV headers
 * @property {CleanedRow[]} cleanedData - Cleaned rows (empty on failure)
 * @property {number} rowCount - Cleaned row count, or parsed row count on failure
 * @property {string|null} error - User-facing error, or null on success
 */

/**
 * Incremental processor returned by LinkedInCleaner.createStreamProcessor().
 * @typedef {object} StreamProcessor
 * @property {(text: string) => void} push - Feed the next text chunk
 * @property {() => ProcessResult|null} finish - Successful result, or null to use process()
 */

/**
 * One column's cleaning step.
 * @typedef {object} CleaningStep
 * @property {string} name - Column name
 * @property {import("./field-cleaners.js").Cleaner} clean - Cell cleaner
 */

/** @typedef {(row: CsvRecord) => CleanedRow|null} RowCleaner */

/**
 * Display labels, indexable by an arbitrary (possibly unknown) type string.
 * @type {Readonly<Record<string, string|undefined>>}
 */
const TYPE_LABELS = FILE_TYPE_LABELS;

/** @type {Readonly<Record<string, readonly CleaningStep[]>>} */
const CLEANING_PLANS = Object.freeze(
    Object.fromEntries(
        FILE_TYPES.map((fileType) => [
            fileType,
            CONFIGS[fileType].columns.map((column) => ({
                name: column.name,
                clean: (column.cleaner && CLEANERS[column.cleaner]) || cleanValue,
            })),
        ]),
    ),
);

export const LinkedInCleaner = (() => {
    "use strict";

    const EMPTY_CSV_ERROR = "CSV file is empty or has no data rows";

    // Auto-detection only needs the header row, which sits at the top of the file
    // (after at most a few skip rows). For large files, parse this prefix to
    // match a type, then full-parse the matched type once, instead of full-parsing
    // the whole file up to three times (one per distinct option/skip-row combo).
    // Files at or below this size skip the pre-pass and use the original full
    // multi-type detection, so small uploads are unaffected.
    const PREFIX_DETECT_CHARS = 64 * 1024;

    /**
     * Check if all required columns in a row have non-missing values.
     * @param {CleanedRow} row - Row object
     * @param {readonly string[]} requiredColumns - Columns that must be present
     * @returns {boolean}
     */
    function hasRequiredRowValues(row, requiredColumns) {
        // Configurations normally define required columns. Treat an empty list as valid for malformed config.
        /* v8 ignore next 2 */
        if (!requiredColumns.length) {
            return true;
        }
        return requiredColumns.every((column) => !isMissing(row[column]));
    }

    /**
     * Check if at least one column has a non-missing value.
     * @param {CleanedRow} row - Row object
     * @param {readonly string[]} columns - Columns to scan
     * @returns {boolean}
     */
    function hasAnyRowValue(row, columns) {
        // cleanData() normally passes a non-empty list. Treat an empty list as valid for malformed config.
        /* v8 ignore next 2 */
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
        // CSV parsing normally returns strings. Ignore malformed headers.
        /* v8 ignore next 2 */
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
     * Find duplicate header names after normalization, preserving header order.
     * @param {string[]} headers - Normalized headers
     * @returns {string[]} Duplicate header names
     */
    function findDuplicateHeaders(headers) {
        const seen = new Set();
        const duplicateSet = new Set();
        const duplicates = [];
        for (const header of headers) {
            if (seen.has(header) && !duplicateSet.has(header)) {
                duplicateSet.add(header);
                duplicates.push(header);
            }
            seen.add(header);
        }
        return duplicates;
    }

    /**
     * Build the duplicate-header error used by the Python cleaner.
     * @param {string[]} headers - Duplicate normalized header names
     * @returns {string} User-facing error message
     */
    function buildDuplicateHeadersError(headers) {
        const labels = headers.map((header) => (header === "" ? "(blank)" : header));
        return `Duplicate columns after header normalization: ${labels.join(", ")}`;
    }

    /**
     * Build parse cache key from file type options.
     * @param {string} fileType - Target file type
     * @returns {string}
     */
    function getParseCacheKey(fileType) {
        const config = CONFIGS[fileType] || null;
        const skipRows =
            config && Number.isInteger(config.skipRows)
                ? /** @type {number} */ (config.skipRows)
                : 0;
        const optionsKey = fileType === "comments" ? "comments" : "default";
        return `${optionsKey}:${skipRows}`;
    }

    /**
     * Parse CSV text into array of objects
     * @param {string} csvText - Raw CSV text
     * @param {string} [fileType='auto'] - Target file type for CSV options and skip rows
     * @param {Map<string, ParsedCsv>|null} [parseCache=null] - Optional parse cache map
     * @returns {ParsedCsv}
     */
    function parseCSV(csvText, fileType = "auto", parseCache = null) {
        const cacheKey = parseCache ? getParseCacheKey(fileType) : null;
        if (parseCache && cacheKey && parseCache.has(cacheKey)) {
            return /** @type {ParsedCsv} */ (parseCache.get(cacheKey));
        }

        /**
         * @param {ParsedCsv} result - Parse result to cache
         * @returns {ParsedCsv} The same result
         */
        const finish = (result) => {
            if (parseCache && cacheKey) {
                parseCache.set(cacheKey, result);
            }
            return result;
        };

        if (typeof csvText !== "string" || !csvText.trim()) {
            return finish({ headers: [], data: [], error: EMPTY_CSV_ERROR });
        }

        const csvOptions = fileType === "comments" ? CSV_OPTIONS_COMMENTS : CSV_OPTIONS_DEFAULT;
        const { rows, error } = parseCsvRows(csvText, csvOptions);
        if (error) {
            return finish({ headers: [], data: [], error });
        }

        if (!rows.length) {
            return finish({ headers: [], data: [], error: EMPTY_CSV_ERROR });
        }

        const config = CONFIGS[fileType] || null;
        const skipRows =
            config && Number.isInteger(config.skipRows)
                ? /** @type {number} */ (config.skipRows)
                : 0;
        const rowsAfterSkip = skipRows > 0 ? rows.slice(skipRows) : rows;
        if (!rowsAfterSkip.length) {
            return finish({
                headers: [],
                data: [],
                error: "CSV file has no header rows after skip.",
            });
        }

        const headers = normalizeHeaders(rowsAfterSkip[0]);
        if (!headers.length || headers.every((header) => header === "")) {
            return finish({ headers: [], data: [], error: "Could not parse CSV headers" });
        }

        const duplicateHeaders = findDuplicateHeaders(headers);
        if (duplicateHeaders.length) {
            return finish({
                headers: [],
                data: [],
                error: buildDuplicateHeadersError(duplicateHeaders),
            });
        }

        const headerCount = headers.length;
        /** @type {CsvRecord[]} */
        const data = [];
        for (let r = 1; r < rowsAfterSkip.length; r += 1) {
            const row = rowsAfterSkip[r];
            if (isRowEmpty(row)) {
                continue;
            }
            if (row.length > headerCount) {
                return finish({
                    headers: [],
                    data: [],
                    error: "CSV parsing error: data row has more fields than the header.",
                });
            }
            // Null-prototype object: CSV headers are user-controlled, so keys
            // like "__proto__" must not mutate the prototype chain.
            /** @type {CsvRecord} */
            const record = Object.create(null);
            for (let c = 0; c < headerCount; c += 1) {
                const value = row[c];
                record[headers[c]] = value !== undefined ? value : "";
            }
            data.push(record);
        }

        return finish({ headers, data, error: null });
    }

    /**
     * Auto-detect file type based on column headers
     * @param {string[]} headers - Array of column headers
     * @returns {FileType|null} File type or null if unknown
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
     * @param {Map<string, ParsedCsv>|null} [parseCache=null] - Optional parse cache map
     * @returns {Array<{type: FileType, headers: string[], data: CsvRecord[]}>}
     */
    function detectMatchingFileTypes(csvText, parseCache = null) {
        /** @type {Array<{type: FileType, headers: string[], data: CsvRecord[]}>} */
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
     * Detect a supported type other than the one selected by the user.
     * @param {string} csvText - Raw CSV text
     * @param {string} selectedType - Type selected by the user
     * @param {Map<string, ParsedCsv>} parseCache - Full-file parse cache
     * @returns {FileType|null} First alternate type, or null when none matches
     */
    function detectAlternateFileType(csvText, selectedType, parseCache) {
        return (
            detectMatchingFileTypes(csvText, parseCache).find(
                (match) => match.type !== selectedType,
            )?.type || null
        );
    }

    /**
     * Cheaply detect a file's type from its header row by parsing only a prefix
     * of the text. Returns the first supported type (in FILE_TYPES order) whose
     * required columns are present, or null when no prefix match is found.
     *
     * Only the header row is read, so a truncated tail cannot affect the match
     * and a positive match is reliable; a null result falls back to full
     * multi-type detection in the caller, which keeps behavior identical.
     * @param {string} csvText - Raw CSV text
     * @returns {FileType|null} Detected file type, or null if unknown from the prefix
     */
    function detectTypeFromPrefix(csvText) {
        const prefix = csvText.slice(0, PREFIX_DETECT_CHARS);
        for (const type of FILE_TYPES) {
            const headers = readPrefixHeader(prefix, type);
            if (headers && validateColumns(headers, type).valid) {
                return type;
            }
        }
        return null;
    }

    /**
     * Read one type's header row from a prefix, the row parseCSV() would use.
     * The prefix is never finished, so a quoted field cut off at its end is
     * left open instead of failing the whole prefix with an unmatched quote.
     * @param {string} prefix - Start of the CSV text
     * @param {FileType} type - Supported file type
     * @returns {string[]|null} Normalized headers, or null when none can be used
     */
    function readPrefixHeader(prefix, type) {
        const config = CONFIGS[type];
        const skipRows = Number.isInteger(config.skipRows)
            ? /** @type {number} */ (config.skipRows)
            : 0;
        const csvOptions = type === "comments" ? CSV_OPTIONS_COMMENTS : CSV_OPTIONS_DEFAULT;
        /** @type {string[]|null} */
        let headerRow = null;
        let rowIndex = 0;
        const parser = createCsvRowParser(csvOptions, (row) => {
            if (rowIndex === skipRows) {
                headerRow = row;
            }
            rowIndex += 1;
        });
        if (parser.push(prefix) || !headerRow) {
            return null;
        }
        const headers = normalizeHeaders(headerRow);
        if (headers.every((header) => header === "") || findDuplicateHeaders(headers).length) {
            return null;
        }
        return headers;
    }

    /**
     * Validate that required columns exist in the data
     * @param {string[]} headers - Array of column headers
     * @param {string} fileType - Supported file type
     * @returns {ColumnValidation}
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
     * Build a function that cleans one parsed row for a file type.
     * @param {FileType} fileType - Supported file type
     * @returns {RowCleaner} Cleans a row, returning null when the row is dropped
     */
    function createRowCleaner(fileType) {
        const config = CONFIGS[fileType];
        const cleaningPlan = CLEANING_PLANS[fileType];
        const requiredRowColumns = Array.isArray(config.requiredRowColumns)
            ? config.requiredRowColumns
            : config.requiredColumns;
        const dropIfAllMissing = Array.isArray(config.dropIfAllMissing)
            ? config.dropIfAllMissing
            : [];

        return (row) => {
            /** @type {CleanedRow} */
            const cleanedRow = {};
            for (const column of cleaningPlan) {
                const cleanedValue = column.clean(row[column.name]);
                // Strip XML-illegal control characters before formula-escaping so a
                // cell like "\u0001=SUM(...)" is both export-safe and still detected
                // as a formula-injection payload to quote-prefix (mirrors cleaner.py).
                cleanedRow[column.name] = escapeFormula(removeIllegalChars(cleanedValue));
            }

            if (!hasRequiredRowValues(cleanedRow, requiredRowColumns)) {
                return null;
            }
            if (dropIfAllMissing.length && !hasAnyRowValue(cleanedRow, dropIfAllMissing)) {
                return null;
            }
            return cleanedRow;
        };
    }

    /**
     * Clean the parsed data based on file type
     * @param {CsvRecord[]} data - Parsed CSV data as array of objects
     * @param {string} fileType - Supported file type
     * @returns {CleanedRow[]} Cleaned data
     */
    function cleanData(data, fileType) {
        // process() validates the file type before cleaning. Keep the branch for an unknown type.
        /* v8 ignore next 2 */
        if (!CONFIGS[fileType]) {
            return data;
        }

        // Clean and filter in a single pass to avoid intermediate arrays.
        const cleanRow = createRowCleaner(/** @type {FileType} */ (fileType));
        /** @type {CleanedRow[]} */
        const cleanedRows = [];
        for (const row of data) {
            const cleanedRow = cleanRow(row);
            if (cleanedRow) {
                cleanedRows.push(cleanedRow);
            }
        }

        return cleanedRows;
    }

    /**
     * Build a user-friendly error message for column validation failures.
     * @param {string} selectedType - The file type selected by the user ('shares', 'comments', 'messages', 'connections', or 'auto')
     * @param {string|null} detectedType - The auto-detected file type, or null
     * @param {readonly string[]} missing - List of missing required column names
     * @returns {string} Descriptive error message
     */
    function buildColumnErrorMessage(selectedType, detectedType, missing) {
        if (selectedType !== "auto" && detectedType && detectedType !== selectedType) {
            // Known file types have labels. Fall back to the type name for malformed config.
            /* v8 ignore next 2 */
            const selectedLabel = TYPE_LABELS[selectedType] || selectedType;
            const detectedLabel = TYPE_LABELS[detectedType] || detectedType;
            return `This looks like a ${detectedLabel} file, but you selected ${selectedLabel}. Please switch to "${detectedLabel}" or "Auto-detect".`;
        }

        if (selectedType !== "auto" && !detectedType) {
            /* v8 ignore next */
            const selectedLabel = TYPE_LABELS[selectedType] || selectedType;
            return `This file doesn't appear to be a LinkedIn ${selectedLabel} export. Missing columns: ${missing.join(", ")}. Please check that you uploaded the correct file.`;
        }

        // process() normally returns through one of the branches above. Keep a
        // generic error for malformed input.
        /* v8 ignore next */
        return `Missing required columns: ${missing.join(", ")}`;
    }

    /**
     * Build a standardized process() result object.
     * @param {boolean} success - Whether processing succeeded
     * @param {string|null} error - Error message, or null on success
     * @param {Partial<ProcessResult>} [overrides] - Fields that differ from the empty defaults
     * @returns {ProcessResult}
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
     * Try the large-file prefix-detection fast path.
     * @param {unknown} csvText - Raw CSV text
     * @param {Map<string, ParsedCsv>} parseCache - Full-file parse cache
     * @returns {ProcessResult|null} Successful process result, or null to use full detection
     */
    function processPrefixMatch(csvText, parseCache) {
        if (typeof csvText !== "string" || csvText.length <= PREFIX_DETECT_CHARS) {
            return null;
        }

        const fileType = detectTypeFromPrefix(csvText);
        if (!fileType) {
            return null;
        }

        const parsed = parseCSV(csvText, fileType, parseCache);
        if (parsed.error || !validateColumns(parsed.headers, fileType).valid) {
            return null;
        }

        const cleanedData = cleanData(parsed.data, fileType);
        return makeResult(true, null, {
            fileType,
            detectedType: fileType,
            headers: parsed.headers,
            cleanedData,
            rowCount: cleanedData.length,
        });
    }

    /**
     * Process a CSV file completely
     * @param {string} csvText - Raw CSV text
     * @param {string} fileType - Supported file type or 'auto'
     * @returns {ProcessResult}
     */
    function process(csvText, fileType = "auto") {
        /** @type {Map<string, ParsedCsv>} */
        const parseCache = new Map();

        if (fileType === "auto") {
            // Fast path for large files: detect the type from a small prefix, then
            // full-parse only the matched type once. Falls through to full
            // multi-type detection on a prefix miss or if the matched type fails
            // to parse/validate on the whole file, so the result is unchanged.
            const prefixResult = processPrefixMatch(csvText, parseCache);
            if (prefixResult) {
                return prefixResult;
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
            if (parsed.error.includes("data row has more fields than the header")) {
                const alternateType = detectAlternateFileType(csvText, fileType, parseCache);
                if (alternateType) {
                    const missing = CONFIGS[fileType]?.requiredColumns || [];
                    return makeResult(
                        false,
                        buildColumnErrorMessage(fileType, alternateType, missing),
                        { fileType, detectedType: alternateType },
                    );
                }
            }
            return makeResult(false, parsed.error);
        }

        const { headers, data } = parsed;
        let detectedType = detectFileType(headers);
        const validation = validateColumns(headers, fileType);
        if (!validation.valid) {
            detectedType =
                detectedType ||
                detectAlternateFileType(csvText, fileType, parseCache);
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

    /**
     * Create a processor that parses and cleans text chunks as they arrive.
     *
     * It detects the file type from the first PREFIX_DETECT_CHARS characters,
     * the same way process() does for auto-detection, then parses and cleans
     * each row as it completes instead of building the full row and record
     * arrays first. finish() returns the same result process(text, "auto")
     * would for a successful file. On any error or ambiguity it returns null,
     * and the caller runs process() on the full text, so failures and their
     * messages stay identical.
     *
     * With onRecord, each parsed record goes to it uncleaned, as parseCSV()
     * would have produced it, and the result carries no cleaned rows. A caller
     * that needs values the spreadsheet cleaner would change reads them this
     * way.
     * @param {((record: CsvRecord) => void)|null} [onRecord] - Receives each parsed record instead of cleaning it
     * @returns {StreamProcessor}
     */
    function createStreamProcessor(onRecord = null) {
        let prefix = "";
        /** @type {FileType|null} */
        let fileType = null;
        /** @type {CsvRowParser|null} */
        let parser = null;
        let failed = false;
        let skipRows = 0;
        let rowIndex = 0;
        /** @type {string[]|null} */
        let headers = null;
        /** @type {RowCleaner|null} */
        let cleanRow = null;
        /** @type {CleanedRow[]} */
        const cleanedData = [];
        // Repeated values in the kept rows are stored once, and none of them
        // holds on to the decoded text.
        const keep = createStringPool();

        // Mirrors parseCSV(): skip rows, read and check the header, then build
        // and clean one record per non-empty data row.
        // onRow only runs once startParsing() has set fileType and cleanRow.
        /** @param {string[]} row */
        const onRow = (row) => {
            if (failed) {
                return;
            }
            rowIndex += 1;
            if (rowIndex <= skipRows) {
                return;
            }
            if (!headers) {
                const normalized = normalizeHeaders(row);
                // Prefix detection already parsed and validated this same header
                // row, so this guard only protects against a future drift.
                /* v8 ignore next 8 */
                if (
                    normalized.every((header) => header === "") ||
                    findDuplicateHeaders(normalized).length ||
                    !validateColumns(normalized, /** @type {FileType} */ (fileType)).valid
                ) {
                    failed = true;
                    return;
                }
                headers = normalized;
                return;
            }
            if (isRowEmpty(row)) {
                return;
            }
            if (row.length > headers.length) {
                failed = true;
                return;
            }
            // Null-prototype object, as in parseCSV().
            /** @type {CsvRecord} */
            const record = Object.create(null);
            for (let c = 0; c < headers.length; c += 1) {
                const value = row[c];
                record[headers[c]] = value !== undefined ? value : "";
            }
            if (onRecord) {
                onRecord(record);
                return;
            }
            const cleanedRow = /** @type {RowCleaner} */ (cleanRow)(record);
            if (cleanedRow) {
                for (const name of Object.keys(cleanedRow)) {
                    cleanedRow[name] = keep(cleanedRow[name], name);
                }
                cleanedData.push(cleanedRow);
            }
        };

        const startParsing = () => {
            fileType = detectTypeFromPrefix(prefix);
            if (!fileType) {
                failed = true;
                return;
            }
            const config = CONFIGS[fileType];
            skipRows = Number.isInteger(config.skipRows)
                ? /** @type {number} */ (config.skipRows)
                : 0;
            cleanRow = createRowCleaner(fileType);
            const csvOptions = fileType === "comments" ? CSV_OPTIONS_COMMENTS : CSV_OPTIONS_DEFAULT;
            parser = createCsvRowParser(csvOptions, onRow);
            if (parser.push(prefix)) {
                failed = true;
            }
            prefix = "";
        };

        /** @param {string} text */
        const push = (text) => {
            if (failed) {
                return;
            }
            if (!parser) {
                prefix += text;
                if (prefix.length >= PREFIX_DETECT_CHARS) {
                    startParsing();
                }
                return;
            }
            if (parser.push(text)) {
                failed = true;
            }
        };

        const finish = () => {
            if (!failed && !parser) {
                startParsing();
            }
            if (failed) {
                return null;
            }
            // Flushing the last row can also fail it, so check again afterward.
            const parseError = /** @type {CsvRowParser} */ (parser).finish();
            // Detection found a header row, so headers is always set by now.
            if (parseError || failed || /* v8 ignore next */ !headers) {
                return null;
            }
            return makeResult(true, null, {
                fileType,
                detectedType: fileType,
                headers,
                cleanedData,
                rowCount: cleanedData.length,
            });
        };

        return { push, finish };
    }

    return {
        configs: CONFIGS,
        process,
        createStreamProcessor,
        parseCSV,
        detectFileType,
        validateColumns,
    };
})();
