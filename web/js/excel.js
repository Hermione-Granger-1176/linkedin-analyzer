/**
 * Excel Generation Module
 * Uses SheetJS (xlsx) library for Excel file creation with formatting
 */

const ExcelGenerator = (() => {
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
        if (typeof XLSX === 'undefined') {
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
     * Create a SheetJS worksheet from headers and row data.
     * @param {string[]} headers - Column header names
     * @param {string[][]} rows - 2D array of row data
     * @returns {object} SheetJS worksheet object
     */
    function createWorksheet(headers, rows) {
        return XLSX.utils.aoa_to_sheet([headers, ...rows]);
    }

    /**
     * Set column widths on the worksheet from config.
     * @param {object} ws - SheetJS worksheet
     * @param {object} config - Cleaner config with column width definitions
     */
    function applyColumnWidths(ws, config) {
        ws['!cols'] = config.columns.map(column => ({ wch: column.width }));
    }

    /**
     * Apply bold/centered styling to the header row.
     * @param {object} ws - SheetJS worksheet
     * @param {{s: {c: number}, e: {c: number}}} range - Decoded sheet range
     */
    function applyHeaderStyles(ws, range) {
        for (let col = range.s.c; col <= range.e.c; col++) {
            const cellRef = XLSX.utils.encode_cell({ r: 0, c: col });
            if (!ws[cellRef]) continue;
            ws[cellRef].s = HEADER_STYLE;
        }
    }

    /**
     * Apply alignment and border styles to data rows.
     * @param {object} ws - SheetJS worksheet
     * @param {object} config - Cleaner config with wrapText flags per column
     * @param {number} rowCount - Number of data rows
     * @param {{s: {c: number}, e: {c: number}}} range - Decoded sheet range
     */
    function applyBodyStyles(ws, config, rowCount, range) {
        for (let row = 1; row <= rowCount; row++) {
            for (let col = range.s.c; col <= range.e.c; col++) {
                const cellRef = XLSX.utils.encode_cell({ r: row, c: col });
                if (!ws[cellRef]) continue;

                const colConfig = config.columns[col];
                ws[cellRef].s = {
                    alignment: {
                        vertical: 'top',
                        wrapText: colConfig?.wrapText || false
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
     * @param {object} config - Cleaner config
     * @param {number} rowCount - Number of data rows
     */
    function applyStyles(ws, config, rowCount) {
        const range = XLSX.utils.decode_range(ws['!ref']);
        applyHeaderStyles(ws, range);
        applyBodyStyles(ws, config, rowCount, range);
        applyRowHeights(ws, rowCount);
    }

    /**
     * Generate an Excel file from cleaned data
     * @param {object[]} data - Array of row objects
     * @param {string} fileType - Supported file type
     * @returns {Blob} Excel file as Blob
     */
    function generate(data, fileType) {
        ensureXlsxAvailable();
        const config = getConfig(fileType);

        const workbook = XLSX.utils.book_new();
        const headers = config.columns.map(column => column.name);
        const rows = buildRows(data, headers);
        const worksheet = createWorksheet(headers, rows);

        applyColumnWidths(worksheet, config);
        applyStyles(worksheet, config, data.length);

        const SHEET_NAMES = {
            shares: 'Shares',
            comments: 'Comments',
            messages: 'Messages',
            connections: 'Connections'
        };
        const sheetName = SHEET_NAMES[fileType] || 'Sheet1';
        XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);

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
        generateAndDownload
    };
})();

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ExcelGenerator;
}
