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

    function getConfig(fileType) {
        const config = LinkedInCleaner.configs[fileType];
        if (!config) {
            throw new Error(`Unknown file type: ${fileType}`);
        }
        return config;
    }

    function ensureXlsxAvailable() {
        if (typeof XLSX === 'undefined') {
            throw new Error('Excel export library failed to load. Please refresh and try again.');
        }
    }

    function buildRows(data, headers) {
        return data.map(row => headers.map(header => row[header] || ''));
    }

    function createWorksheet(headers, rows) {
        return XLSX.utils.aoa_to_sheet([headers, ...rows]);
    }

    function applyColumnWidths(ws, config) {
        ws['!cols'] = config.columns.map(column => ({ wch: column.width }));
    }

    function applyHeaderStyles(ws, range) {
        for (let col = range.s.c; col <= range.e.c; col++) {
            const cellRef = XLSX.utils.encode_cell({ r: 0, c: col });
            if (!ws[cellRef]) continue;
            ws[cellRef].s = HEADER_STYLE;
        }
    }

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

    function applyRowHeights(ws, rowCount) {
        ws['!rows'] = [];
        for (let row = 0; row <= rowCount; row++) {
            ws['!rows'][row] = { hpt: row === 0 ? HEADER_ROW_HEIGHT : DATA_ROW_HEIGHT };
        }
    }

    function applyStyles(ws, config, rowCount) {
        const range = XLSX.utils.decode_range(ws['!ref']);
        applyHeaderStyles(ws, range);
        applyBodyStyles(ws, config, rowCount, range);
        applyRowHeights(ws, rowCount);
    }

    /**
     * Generate an Excel file from cleaned data
     * @param {object[]} data - Array of row objects
     * @param {string} fileType - 'shares' or 'comments'
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

        const sheetName = fileType === 'shares' ? 'Shares' : 'Comments';
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
     * @param {string} fileType - 'shares' or 'comments'
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
