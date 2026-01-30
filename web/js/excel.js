/**
 * Excel Generation Module
 * Uses SheetJS (xlsx) library for Excel file creation with formatting
 */

const ExcelGenerator = {
    /**
     * Generate an Excel file from cleaned data
     * @param {object[]} data - Array of row objects
     * @param {string} fileType - 'shares' or 'comments'
     * @returns {Blob} Excel file as Blob
     */
    generate(data, fileType) {
        const config = LinkedInCleaner.configs[fileType];
        if (!config) {
            throw new Error(`Unknown file type: ${fileType}`);
        }

        // Create workbook
        const wb = XLSX.utils.book_new();
        
        // Get ordered headers from config
        const headers = config.columns.map(col => col.name);
        
        // Convert data to array of arrays (for better control over formatting)
        const rows = data.map(row => headers.map(h => row[h] || ''));
        
        // Create worksheet from array of arrays
        const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
        
        // Apply column widths
        ws['!cols'] = config.columns.map(col => ({
            wch: col.width
        }));
        
        // Apply cell styles
        this.applyStyles(ws, config, data.length);
        
        // Add worksheet to workbook
        const sheetName = fileType === 'shares' ? 'Shares' : 'Comments';
        XLSX.utils.book_append_sheet(wb, ws, sheetName);
        
        // Generate Excel file
        const wbout = XLSX.write(wb, { 
            bookType: 'xlsx', 
            type: 'array',
            cellStyles: true
        });
        
        return new Blob([wbout], { 
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' 
        });
    },

    /**
     * Apply styles to worksheet
     * @param {object} ws - Worksheet object
     * @param {object} config - Column configuration
     * @param {number} rowCount - Number of data rows
     */
    applyStyles(ws, config, rowCount) {
        // Get range of the worksheet
        const range = XLSX.utils.decode_range(ws['!ref']);
        
        // Style header row
        for (let col = range.s.c; col <= range.e.c; col++) {
            const cellRef = XLSX.utils.encode_cell({ r: 0, c: col });
            if (!ws[cellRef]) continue;
            
            ws[cellRef].s = {
                font: { bold: true, sz: 12 },
                fill: { fgColor: { rgb: 'E8E8E8' } },
                alignment: { horizontal: 'center', vertical: 'center' },
                border: {
                    top: { style: 'thin', color: { rgb: '000000' } },
                    bottom: { style: 'thin', color: { rgb: '000000' } },
                    left: { style: 'thin', color: { rgb: '000000' } },
                    right: { style: 'thin', color: { rgb: '000000' } }
                }
            };
        }
        
        // Style data cells
        for (let row = 1; row <= rowCount; row++) {
            for (let col = range.s.c; col <= range.e.c; col++) {
                const cellRef = XLSX.utils.encode_cell({ r: row, c: col });
                if (!ws[cellRef]) continue;
                
                const colConfig = config.columns[col];
                const style = {
                    alignment: { 
                        vertical: 'top',
                        wrapText: colConfig?.wrapText || false
                    },
                    border: {
                        bottom: { style: 'thin', color: { rgb: 'CCCCCC' } }
                    }
                };
                
                ws[cellRef].s = style;
            }
        }
        
        // Set row heights for rows with wrap text (estimate based on content)
        ws['!rows'] = [];
        for (let row = 0; row <= rowCount; row++) {
            ws['!rows'][row] = { hpt: row === 0 ? 25 : 20 }; // Header row slightly taller
        }
    },

    /**
     * Trigger file download
     * @param {Blob} blob - File blob
     * @param {string} filename - Name for the downloaded file
     */
    download(blob, filename) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    },

    /**
     * Generate and download Excel file
     * @param {object[]} data - Cleaned data array
     * @param {string} fileType - 'shares' or 'comments'
     * @param {string} [customFilename] - Optional custom filename
     */
    generateAndDownload(data, fileType, customFilename = null) {
        try {
            const blob = this.generate(data, fileType);
            const filename = customFilename || LinkedInCleaner.configs[fileType].outputName;
            this.download(blob, filename);
            return { success: true, error: null };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }
};

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ExcelGenerator;
}
