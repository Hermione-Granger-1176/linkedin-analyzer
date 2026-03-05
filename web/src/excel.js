/**
 * Excel Generation Module
 * Uses SheetJS (xlsx) library for Excel file creation with formatting
 */

import * as XLSX from 'xlsx';

import { LinkedInCleaner } from './cleaner.js';

export const ExcelGenerator = (() => {
    'use strict';

    const HEADER_STYLE = Object.freeze({
        font: { bold: true, sz: 12 },
        fill: { fgColor: { rgb: 'E8E8E8' } },
        alignment: { horizontal: 'center', vertical: 'center' },
        border: {
            top: { style: 'thin', color: { rgb: '000000' } },
            bottom: { style: 'thin', color: { rgb: '000000' } },
            left: { style: 'thin', color: { rgb: '000000' } },
            right: { style: 'thin', color: { rgb: '000000' } }
        }
    });

    const DATA_BORDER = Object.freeze({
        bottom: { style: 'thin', color: { rgb: 'CCCCCC' } }
    });

    const HEADER_ROW_HEIGHT = 25;
    const DATA_ROW_HEIGHT = 20;
    const MIN_COLUMN_WIDTH = 10;
    const MAX_COLUMN_WIDTH = 60;
    const COLUMN_WIDTH_PADDING = 2;

    /**
     * Get the cleaner config for a file type, throwing on unknown types.
     * @param {string} fileType - Supported file type
     * @returns {object} Frozen config with columns, requiredColumns, and outputName
     * @throws {Error} If fileType is not recognized
     */
    function getConfig(fileType) {
        const config = LinkedInCleaner.configs[fileType];
        if (!config) {
            throw new Error(`Unknown file type: ${fileType}`);
        }
        return config;
    }

    /**
     * Throw if the XLSX library is not loaded.
     * @throws {Error} If XLSX global is undefined
     */
    function ensureXlsxAvailable() {
        if (!XLSX) {
            throw new Error('Excel export library failed to load. Please refresh and try again.');
        }
    }

    /**
     * Convert row objects into a 2D array ordered by headers.
     * @param {object[]} data - Array of row objects
     * @param {string[]} headers - Column names in display order
     * @returns {string[][]} 2D array of cell values
     */
    function buildRows(data, headers) {
        return data.map(row => headers.map(header => row[header] || ''));
    }

    /**
     * Normalize a raw cell into a value/hyperlink cell object.
     * @param {*} rawCell - Raw row cell
     * @returns {{value: *, hyperlink: string}} Normalized cell
     */
    function normalizeCell(rawCell) {
        if (rawCell && typeof rawCell === 'object' && !Array.isArray(rawCell)) {
            const hasStructuredShape = Object.prototype.hasOwnProperty.call(rawCell, 'value')
                || Object.prototype.hasOwnProperty.call(rawCell, 'hyperlink');

            if (hasStructuredShape) {
                const hyperlink = typeof rawCell.hyperlink === 'string' ? rawCell.hyperlink.trim() : '';
                const value = Object.prototype.hasOwnProperty.call(rawCell, 'value')
                    ? rawCell.value
                    : hyperlink;
                return { value, hyperlink };
            }
        }

        return { value: rawCell, hyperlink: '' };
    }

    /**
     * Coerce a normalized cell value to displayable text for width calculations.
     * @param {{value: *, hyperlink: string}} cell - Normalized cell
     * @returns {string} String representation
     */
    function valueToText(cell) {
        if (!cell || cell.value === null || typeof cell.value === 'undefined') {return '';}
        return String(cell.value);
    }

    /**
     * Apply hyperlink metadata to worksheet cells.
     * @param {object} ws - SheetJS worksheet object
     * @param {Array<Array<{value: *, hyperlink: string}>>} rows - Normalized row cells
     */
    function applyHyperlinks(ws, rows) {
        rows.forEach((row, rowIndex) => {
            row.forEach((cell, colIndex) => {
                if (!cell.hyperlink) {
                    return;
                }

                const cellRef = XLSX.utils.encode_cell({ r: rowIndex + 1, c: colIndex });
                if (!ws[cellRef]) {
                    ws[cellRef] = { t: 's', v: valueToText(cell) };
                }
                ws[cellRef].l = { Target: cell.hyperlink, Tooltip: cell.hyperlink };
            });
        });
    }

    /**
     * Create a SheetJS worksheet from headers and row data.
     * @param {string[]} headers - Column header names
     * @param {Array<Array<{value: *, hyperlink: string}>>} rows - 2D array of normalized row cells
     * @returns {object} SheetJS worksheet object
     */
    function createWorksheet(headers, rows) {
        const values = rows.map(row => row.map(cell => cell.value));
        const worksheet = XLSX.utils.aoa_to_sheet([headers, ...values]);
        applyHyperlinks(worksheet, rows);
        return worksheet;
    }

    /**
     * Build clamped column widths from header and row content lengths.
     * @param {string[]} headers - Column header names
     * @param {Array<Array<*>>} rows - 2D row values
     * @returns {number[]} Widths in character units
     */
    function computeColumnWidths(headers, rows) {
        return headers.map((header, colIdx) => {
            let maxLength = valueToText(header).length;

            for (const row of rows) {
                const valueLength = valueToText(row[colIdx]).length;
                if (valueLength > maxLength) {
                    maxLength = valueLength;
                }
            }

            const width = maxLength + COLUMN_WIDTH_PADDING;
            return Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, width));
        });
    }

    /**
     * Set column widths on the worksheet.
     * @param {object} ws - SheetJS worksheet
     * @param {number[]} widths - Column widths in character units
     */
    function applyColumnWidths(ws, widths) {
        ws['!cols'] = widths.map(width => ({ wch: width }));
    }

    /**
     * Apply bold/centered styling to the header row.
     * @param {object} ws - SheetJS worksheet
     * @param {{s: {c: number}, e: {c: number}}} range - Decoded sheet range
     */
    function applyHeaderStyles(ws, range) {
        for (let col = range.s.c; col <= range.e.c; col++) {
            const cellRef = XLSX.utils.encode_cell({ r: 0, c: col });
            if (!ws[cellRef]) {continue;}
            ws[cellRef].s = HEADER_STYLE;
        }
    }

    /**
     * Apply alignment and border styles to data rows.
     * @param {object} ws - SheetJS worksheet
     * @param {boolean[]} wrapColumns - Columns to wrap text
     * @param {number} rowCount - Number of data rows
     * @param {{s: {c: number}, e: {c: number}}} range - Decoded sheet range
     */
    function applyBodyStyles(ws, wrapColumns, rowCount, range) {
        for (let row = 1; row <= rowCount; row++) {
            for (let col = range.s.c; col <= range.e.c; col++) {
                const cellRef = XLSX.utils.encode_cell({ r: row, c: col });
                if (!ws[cellRef]) {continue;}

                ws[cellRef].s = {
                    alignment: {
                        vertical: 'top',
                        wrapText: wrapColumns[col] || false
                    },
                    border: DATA_BORDER
                };
            }
        }
    }

    /**
     * Set row heights for header and data rows.
     * @param {object} ws - SheetJS worksheet
     * @param {number} rowCount - Number of data rows
     */
    function applyRowHeights(ws, rowCount) {
        ws['!rows'] = Array.from({ length: rowCount + 1 }, (_, row) => ({
            hpt: row === 0 ? HEADER_ROW_HEIGHT : DATA_ROW_HEIGHT
        }));
    }

    /**
     * Apply all formatting (headers, body, row heights) to a worksheet.
     * @param {object} ws - SheetJS worksheet
     * @param {boolean[]} wrapColumns - Columns to wrap text
     * @param {number} rowCount - Number of data rows
     */
    function applyStyles(ws, wrapColumns, rowCount) {
        if (!ws['!ref']) {
            applyRowHeights(ws, rowCount);
            return;
        }

        const range = XLSX.utils.decode_range(ws['!ref']);
        applyHeaderStyles(ws, range);
        applyBodyStyles(ws, wrapColumns, rowCount, range);
        applyRowHeights(ws, rowCount);
    }

    /**
     * Validate and normalize a worksheet spec.
     * @param {object} spec - Input worksheet spec
     * @returns {{sheetName: string, headers: string[], rows: Array<Array<*>>, columnWidths: number[], wrapColumns: boolean[]}} Normalized spec
     */
    function normalizeSpec(spec) {
        if (!spec || typeof spec !== 'object') {
            throw new Error('Invalid sheet spec');
        }

        const { sheetName, headers, rows, columnWidths, wrapColumns } = spec;

        if (typeof sheetName !== 'string' || !sheetName.trim()) {
            throw new Error('Sheet spec requires a non-empty sheetName');
        }

        if (!Array.isArray(headers)) {
            throw new Error('Sheet spec headers must be an array');
        }

        if (!Array.isArray(rows)) {
            throw new Error('Sheet spec rows must be an array');
        }

        const normalizedRows = rows.map(row => {
            if (!Array.isArray(row)) {
                throw new Error('Each sheet spec row must be an array');
            }

            return headers.map((_, index) => {
                if (index >= row.length) {return normalizeCell('');}
                return normalizeCell(row[index]);
            });
        });

        let normalizedWidths;
        if (Array.isArray(columnWidths)) {
            normalizedWidths = headers.map((_, index) => {
                const width = Number(columnWidths[index]);
                if (!Number.isFinite(width)) {
                    return MIN_COLUMN_WIDTH;
                }
                return Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, width));
            });
        } else {
            normalizedWidths = computeColumnWidths(headers, normalizedRows);
        }

        const normalizedWrapColumns = headers.map((_, index) => Boolean(wrapColumns && wrapColumns[index]));

        return {
            sheetName,
            headers,
            rows: normalizedRows,
            columnWidths: normalizedWidths,
            wrapColumns: normalizedWrapColumns
        };
    }

    /**
     * Generate an Excel file from a generic worksheet spec.
     * @param {{sheetName: string, headers: string[], rows: Array<Array<*>>, columnWidths?: number[], wrapColumns?: boolean[]}} spec - Worksheet specification
     * @returns {Blob} Excel file as Blob
     */
    function generateFromSpec(spec) {
        ensureXlsxAvailable();

        const normalizedSpec = normalizeSpec(spec);
        const workbook = XLSX.utils.book_new();
        const worksheet = createWorksheet(normalizedSpec.headers, normalizedSpec.rows);

        applyColumnWidths(worksheet, normalizedSpec.columnWidths);
        applyStyles(worksheet, normalizedSpec.wrapColumns, normalizedSpec.rows.length);

        XLSX.utils.book_append_sheet(workbook, worksheet, normalizedSpec.sheetName);

        const workbookOutput = XLSX.write(workbook, {
            bookType: 'xlsx',
            type: 'array',
            cellStyles: true
        });

        return new Blob([workbookOutput], {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        });
    }

    /**
     * Generate and download an Excel file from a worksheet spec.
     * @param {{sheetName: string, headers: string[], rows: Array<Array<*>>, columnWidths?: number[], wrapColumns?: boolean[]}} spec - Worksheet specification
     * @param {string} filename - Name for the downloaded file
     * @returns {{success: boolean, error: string|null}} Result state
     */
    function downloadFromSpec(spec, filename) {
        try {
            const blob = generateFromSpec(spec);
            download(blob, filename);
            return { success: true, error: null };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    /**
     * Convert legacy fileType + row objects into a generic worksheet spec.
     * @param {object[]} data - Array of row objects
     * @param {string} fileType - Supported file type
     * @returns {{sheetName: string, headers: string[], rows: string[][], columnWidths: number[], wrapColumns: boolean[]}} Worksheet specification
     */
    function createSpecFromDataAndType(data, fileType) {
        const config = getConfig(fileType);
        const headers = config.columns.map(column => column.name);
        const rows = buildRows(data, headers);

        const SHEET_NAMES = {
            shares: 'Shares',
            comments: 'Comments',
            messages: 'Messages',
            connections: 'Connections'
        };

        return {
            sheetName: SHEET_NAMES[fileType] || 'Sheet1',
            headers,
            rows,
            columnWidths: config.columns.map(column => column.width),
            wrapColumns: config.columns.map(column => Boolean(column.wrapText))
        };
    }

    /**
     * Generate an Excel file from cleaned data
     * @param {object[]} data - Array of row objects
     * @param {string} fileType - Supported file type
     * @returns {Blob} Excel file as Blob
     */
    function generate(data, fileType) {
        const spec = createSpecFromDataAndType(data, fileType);
        return generateFromSpec(spec);
    }

    /**
     * Trigger file download
     * @param {Blob} blob - File blob
     * @param {string} filename - Name for the downloaded file
     */
    function download(blob, filename) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    /**
     * Generate and download Excel file
     * @param {object[]} data - Cleaned data array
     * @param {string} fileType - Supported file type
     * @param {string} [customFilename] - Optional custom filename
     * @returns {{success: boolean, error: string|null}}
     */
    function generateAndDownload(data, fileType, customFilename = null) {
        try {
            const blob = generate(data, fileType);
            const filename = customFilename || getConfig(fileType).outputName;
            download(blob, filename);
            return { success: true, error: null };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    return {
        generate,
        generateAndDownload,
        generateFromSpec,
        downloadFromSpec
    };
})();
