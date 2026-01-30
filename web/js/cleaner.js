/**
 * LinkedIn CSV Cleaner - JavaScript port of Python cleaning logic
 * Original: src/linkedin_analyzer/core/text.py
 */

const LinkedInCleaner = (() => {
    'use strict';

    const FILE_TYPE_LABELS = Object.freeze({
        shares: 'Shares',
        comments: 'Comments'
    });

    const CONFIGS = Object.freeze({
        shares: freezeConfig({
            columns: [
                { name: 'Date', width: 20 },
                { name: 'ShareLink', width: 60 },
                { name: 'ShareCommentary', width: 100, wrapText: true, cleaner: 'cleanSharesCommentary' },
                { name: 'SharedUrl', width: 30, cleaner: 'cleanEmptyField' },
                { name: 'MediaUrl', width: 30, cleaner: 'cleanEmptyField' },
                { name: 'Visibility', width: 18 }
            ],
            requiredColumns: ['Date', 'ShareLink', 'ShareCommentary'],
            outputName: 'Shares_Cleaned.xlsx'
        }),
        comments: freezeConfig({
            columns: [
                { name: 'Date', width: 20 },
                { name: 'Link', width: 60 },
                { name: 'Message', width: 100, wrapText: true, cleaner: 'cleanCommentsMessage' }
            ],
            requiredColumns: ['Date', 'Link', 'Message'],
            outputName: 'Comments_Cleaned.xlsx'
        })
    });

    const CSV_OPTIONS = Object.freeze({
        delimiter: ',',
        quote: '"',
        escape: '\\'
    });

    function freezeConfig(config) {
        const frozenColumns = config.columns.map(column => Object.freeze({ ...column }));
        return Object.freeze({
            ...config,
            columns: Object.freeze(frozenColumns)
        });
    }

    /**
     * Check if a value is missing (null, undefined, empty, or 'NA')
     * Port of: is_missing() from text.py
     * @param {*} value - Value to check
     * @returns {boolean}
     */
    function isMissing(value) {
        if (value === null || value === undefined) return true;
        if (typeof value === 'string') {
            const trimmed = value.trim();
            return trimmed === '' || trimmed.toUpperCase() === 'NA' || trimmed === 'NaN';
        }
        return false;
    }

    /**
     * Clean ShareCommentary field from LinkedIn Shares export.
     * Port of: clean_shares_commentary() from text.py
     *
     * Handles the double-double quote escaping pattern used in Shares.csv:
     * - Removes leading/trailing quotes
     * - Converts CSV line break patterns ("\n") to actual newlines
     * - Converts escaped quotes ("") to single quotes (")
     *
     * @param {*} value - Raw value from CSV
     * @returns {string} Cleaned string
     */
    function cleanSharesCommentary(value) {
        if (isMissing(value)) {
            return '';
        }

        let text = String(value);

        // Remove leading quote if present
        if (text.startsWith('"')) {
            text = text.slice(1);
        }

        // Remove trailing quote if present
        if (text.endsWith('"')) {
            text = text.slice(0, -1);
        }

        // Replace CSV line break pattern: "\n" (quote-newline-quote) with actual newline
        text = text.replace(/"\n"/g, '\n');

        // Replace escaped double quotes with single quotes
        text = text.replace(/""/g, '"');

        return text.trim();
    }

    /**
     * Clean Message field from LinkedIn Comments export.
     * Port of: clean_comments_message() from text.py
     *
     * Handles the backslash-escaped quote pattern used in Comments.csv:
     * - Converts backslash-escaped quotes (\") to regular quotes (")
     * - Handles any double-double quote escaping as fallback
     * - Preserves line breaks
     *
     * @param {*} value - Raw value from CSV
     * @returns {string} Cleaned string
     */
    function cleanCommentsMessage(value) {
        if (isMissing(value)) {
            return '';
        }

        let text = String(value);

        // Replace backslash-escaped quotes with regular quotes
        text = text.replace(/\\"/g, '"');

        // Also handle any double-double quote escaping (fallback)
        text = text.replace(/""/g, '"');

        return text.trim();
    }

    /**
     * Clean empty or quoted-empty fields.
     * Port of: clean_empty_field() from text.py
     *
     * @param {*} value - Raw value from CSV
     * @returns {string} Empty string if the field is empty/missing, otherwise the cleaned value
     */
    function cleanEmptyField(value) {
        if (isMissing(value)) {
            return '';
        }
        const text = String(value).trim();
        return (text === '""' || text === '"' || text === '') ? '' : text;
    }

    const CLEANERS = Object.freeze({
        cleanSharesCommentary,
        cleanCommentsMessage,
        cleanEmptyField
    });

    function normalizeHeader(header) {
        if (typeof header !== 'string') {
            return '';
        }
        return header.replace(/^\uFEFF/, '').trim();
    }

    function normalizeHeaders(headers) {
        return headers.map(normalizeHeader);
    }

    function isRowEmpty(row) {
        return row.every(cell => String(cell ?? '').trim() === '');
    }

    /**
     * Parse CSV into rows with support for quoted fields, escaped quotes, and newlines.
     * @param {string} csvText
     * @param {{delimiter: string, quote: string, escape: string}} options
     * @returns {{rows: string[][], error: string|null}}
     */
    function parseCsvRows(csvText, options = CSV_OPTIONS) {
        const { delimiter, quote, escape } = options;
        const rows = [];
        let row = [];
        let field = '';
        let inQuotes = false;

        const pushField = () => {
            row.push(field);
            field = '';
        };

        const pushRow = () => {
            rows.push(row);
            row = [];
        };

        for (let i = 0; i < csvText.length; i++) {
            const char = csvText[i];
            const nextChar = csvText[i + 1];

            if (inQuotes) {
                if (char === escape && nextChar === quote) {
                    field += quote;
                    i += 1;
                    continue;
                }

                if (char === quote) {
                    if (nextChar === quote) {
                        field += quote;
                        i += 1;
                        continue;
                    }
                    inQuotes = false;
                    continue;
                }

                if (char === '\r' && nextChar === '\n') {
                    field += '\n';
                    i += 1;
                    continue;
                }

                field += char;
                continue;
            }

            if (char === quote) {
                inQuotes = true;
                continue;
            }

            if (char === delimiter) {
                pushField();
                continue;
            }

            if (char === '\n') {
                pushField();
                pushRow();
                continue;
            }

            if (char === '\r') {
                pushField();
                pushRow();
                if (nextChar === '\n') {
                    i += 1;
                }
                continue;
            }

            field += char;
        }

        pushField();
        pushRow();

        while (rows.length && isRowEmpty(rows[rows.length - 1])) {
            rows.pop();
        }

        return {
            rows,
            error: inQuotes ? 'CSV parsing error: unmatched quote' : null
        };
    }

    /**
     * Parse CSV text into array of objects
     * @param {string} csvText - Raw CSV text
     * @returns {{headers: string[], data: object[], error: string|null}}
     */
    function parseCSV(csvText) {
        if (typeof csvText !== 'string' || !csvText.trim()) {
            return { headers: [], data: [], error: 'CSV file is empty or has no data rows' };
        }

        const { rows, error } = parseCsvRows(csvText, CSV_OPTIONS);
        if (error) {
            return { headers: [], data: [], error };
        }

        if (!rows.length) {
            return { headers: [], data: [], error: 'CSV file is empty or has no data rows' };
        }

        const headers = normalizeHeaders(rows[0]);
        if (!headers.length || headers.every(header => header === '')) {
            return { headers: [], data: [], error: 'Could not parse CSV headers' };
        }

        const dataRows = rows.slice(1).filter(row => !isRowEmpty(row));
        if (!dataRows.length) {
            return { headers, data: [], error: 'CSV file is empty or has no data rows' };
        }

        const data = dataRows.map(row => {
            const record = {};
            headers.forEach((header, index) => {
                record[header] = row[index] !== undefined ? row[index] : '';
            });
            return record;
        });

        return { headers, data, error: null };
    }

    /**
     * Auto-detect file type based on column headers
     * @param {string[]} headers - Array of column headers
     * @returns {string|null} 'shares', 'comments', or null if unknown
     */
    function detectFileType(headers) {
        const normalizedHeaders = normalizeHeaders(headers);
        const headerSet = new Set(normalizedHeaders);

        const sharesRequired = CONFIGS.shares.requiredColumns;
        const commentsRequired = CONFIGS.comments.requiredColumns;

        const isShares = sharesRequired.every(column => headerSet.has(column));
        const isComments = commentsRequired.every(column => headerSet.has(column));

        if (isShares && !isComments) return 'shares';
        if (isComments && !isShares) return 'comments';
        if (isShares) return 'shares';

        return null;
    }

    /**
     * Validate that required columns exist in the data
     * @param {string[]} headers - Array of column headers
     * @param {string} fileType - 'shares' or 'comments'
     * @returns {{valid: boolean, missing: string[]}}
     */
    function validateColumns(headers, fileType) {
        const config = CONFIGS[fileType];
        if (!config) {
            return { valid: false, missing: ['Unknown file type'] };
        }

        const normalizedHeaders = normalizeHeaders(headers);
        const headerSet = new Set(normalizedHeaders);
        const missing = config.requiredColumns.filter(column => !headerSet.has(column));

        return {
            valid: missing.length === 0,
            missing
        };
    }

    /**
     * Clean the parsed data based on file type
     * @param {object[]} data - Parsed CSV data as array of objects
     * @param {string} fileType - 'shares' or 'comments'
     * @returns {object[]} Cleaned data
     */
    function cleanData(data, fileType) {
        const config = CONFIGS[fileType];
        if (!config) return data;

        return data.map(row => {
            const cleanedRow = {};

            config.columns.forEach(column => {
                const value = row[column.name];
                const cleaner = column.cleaner ? CLEANERS[column.cleaner] : null;
                cleanedRow[column.name] = cleaner ? cleaner(value) : cleanValue(value);
            });

            return cleanedRow;
        });
    }

    function cleanValue(value) {
        if (isMissing(value)) {
            return '';
        }
        return String(value).trim();
    }

    function buildColumnErrorMessage(selectedType, detectedType, missing) {
        if (selectedType !== 'auto' && detectedType && detectedType !== selectedType) {
            const selectedLabel = FILE_TYPE_LABELS[selectedType] || selectedType;
            const detectedLabel = FILE_TYPE_LABELS[detectedType] || detectedType;
            return `This looks like a ${detectedLabel} file, but you selected ${selectedLabel}. Please switch to "${detectedLabel}" or "Auto-detect".`;
        }

        if (selectedType !== 'auto' && !detectedType) {
            const selectedLabel = FILE_TYPE_LABELS[selectedType] || selectedType;
            return `This file doesn't appear to be a LinkedIn ${selectedLabel} export. Missing columns: ${missing.join(', ')}. Please check that you uploaded the correct file.`;
        }

        return `Missing required columns: ${missing.join(', ')}`;
    }

    /**
     * Process a CSV file completely
     * @param {string} csvText - Raw CSV text
     * @param {string} fileType - 'shares', 'comments', or 'auto'
     * @returns {{
     *   success: boolean,
     *   fileType: string|null,
     *   detectedType: string|null,
     *   headers: string[],
     *   originalData: object[],
     *   cleanedData: object[],
     *   rowCount: number,
     *   error: string|null
     * }}
     */
    function process(csvText, fileType = 'auto') {
        const { headers, data, error: parseError } = parseCSV(csvText);

        if (parseError) {
            return {
                success: false,
                fileType: null,
                detectedType: null,
                headers: [],
                originalData: [],
                cleanedData: [],
                rowCount: 0,
                error: parseError
            };
        }

        const detectedType = detectFileType(headers);

        let processingType = fileType;
        if (fileType === 'auto') {
            processingType = detectedType;
            if (!processingType) {
                return {
                    success: false,
                    fileType: null,
                    detectedType: null,
                    headers,
                    originalData: data,
                    cleanedData: [],
                    rowCount: data.length,
                    error: 'Could not auto-detect file type. This file does not appear to be a LinkedIn Shares or Comments export. Please check that you uploaded the correct file.'
                };
            }
        }

        const validation = validateColumns(headers, processingType);
        if (!validation.valid) {
            return {
                success: false,
                fileType: processingType,
                detectedType,
                headers,
                originalData: data,
                cleanedData: [],
                rowCount: data.length,
                error: buildColumnErrorMessage(fileType, detectedType, validation.missing)
            };
        }

        const cleanedData = cleanData(data, processingType);

        return {
            success: true,
            fileType: processingType,
            detectedType,
            headers,
            originalData: data,
            cleanedData,
            rowCount: cleanedData.length,
            error: null
        };
    }

    return {
        configs: CONFIGS,
        process,
        parseCSV,
        detectFileType,
        validateColumns
    };
})();

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = LinkedInCleaner;
}
