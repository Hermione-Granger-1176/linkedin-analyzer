/**
 * LinkedIn CSV Cleaner - JavaScript port of Python cleaning logic
 * Original: src/linkedin_analyzer/core/text.py
 */

const LinkedInCleaner = {
    /**
     * Column configurations for different file types
     * Matches Python configs in shares.py and comments.py
     */
    configs: {
        shares: {
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
        },
        comments: {
            columns: [
                { name: 'Date', width: 20 },
                { name: 'Link', width: 60 },
                { name: 'Message', width: 100, wrapText: true, cleaner: 'cleanCommentsMessage' }
            ],
            requiredColumns: ['Date', 'Link', 'Message'],
            outputName: 'Comments_Cleaned.xlsx'
        }
    },

    /**
     * Check if a value is missing (null, undefined, empty, or 'NA')
     * Port of: is_missing() from text.py
     * @param {*} value - Value to check
     * @returns {boolean}
     */
    isMissing(value) {
        if (value === null || value === undefined) return true;
        if (typeof value === 'string') {
            const trimmed = value.trim();
            return trimmed === '' || trimmed.toUpperCase() === 'NA' || trimmed === 'NaN';
        }
        return false;
    },

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
    cleanSharesCommentary(value) {
        if (this.isMissing(value)) {
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
    },

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
    cleanCommentsMessage(value) {
        if (this.isMissing(value)) {
            return '';
        }

        let text = String(value);

        // Replace backslash-escaped quotes with regular quotes
        text = text.replace(/\\"/g, '"');

        // Also handle any double-double quote escaping (fallback)
        text = text.replace(/""/g, '"');

        return text.trim();
    },

    /**
     * Clean empty or quoted-empty fields.
     * Port of: clean_empty_field() from text.py
     * 
     * @param {*} value - Raw value from CSV
     * @returns {string} Empty string if the field is empty/missing, otherwise the cleaned value
     */
    cleanEmptyField(value) {
        if (this.isMissing(value)) {
            return '';
        }
        const text = String(value).trim();
        return (text === '""' || text === '"' || text === '') ? '' : text;
    },

    /**
     * Auto-detect file type based on column headers
     * @param {string[]} headers - Array of column headers
     * @returns {string|null} 'shares', 'comments', or null if unknown
     */
    detectFileType(headers) {
        const headerSet = new Set(headers.map(h => h.trim()));
        
        // Check for Shares.csv columns
        if (headerSet.has('ShareCommentary') || headerSet.has('ShareLink')) {
            return 'shares';
        }
        
        // Check for Comments.csv columns
        if (headerSet.has('Message') && headerSet.has('Link') && !headerSet.has('ShareLink')) {
            return 'comments';
        }
        
        return null;
    },

    /**
     * Validate that required columns exist in the data
     * @param {string[]} headers - Array of column headers
     * @param {string} fileType - 'shares' or 'comments'
     * @returns {{valid: boolean, missing: string[]}}
     */
    validateColumns(headers, fileType) {
        const config = this.configs[fileType];
        if (!config) {
            return { valid: false, missing: ['Unknown file type'] };
        }

        const headerSet = new Set(headers.map(h => h.trim()));
        const missing = config.requiredColumns.filter(col => !headerSet.has(col));
        
        return {
            valid: missing.length === 0,
            missing
        };
    },

    /**
     * Parse CSV text into array of objects
     * @param {string} csvText - Raw CSV text
     * @returns {{headers: string[], data: object[], error: string|null}}
     */
    parseCSV(csvText) {
        try {
            const lines = csvText.split(/\r?\n/);
            if (lines.length < 2) {
                return { headers: [], data: [], error: 'CSV file is empty or has no data rows' };
            }

            // Parse header line
            const headers = this.parseCSVLine(lines[0]);
            if (headers.length === 0) {
                return { headers: [], data: [], error: 'Could not parse CSV headers' };
            }

            // Parse data lines
            const data = [];
            let currentLine = '';
            let inQuotes = false;
            
            for (let i = 1; i < lines.length; i++) {
                const line = lines[i];
                
                // Handle multi-line values (values with newlines inside quotes)
                currentLine += (currentLine ? '\n' : '') + line;
                
                // Count quotes to determine if we're inside a quoted value
                const quoteCount = (currentLine.match(/"/g) || []).length;
                inQuotes = quoteCount % 2 !== 0;
                
                if (!inQuotes) {
                    // We have a complete row
                    if (currentLine.trim()) {
                        const values = this.parseCSVLine(currentLine);
                        if (values.length > 0) {
                            const row = {};
                            headers.forEach((header, index) => {
                                row[header] = values[index] !== undefined ? values[index] : '';
                            });
                            data.push(row);
                        }
                    }
                    currentLine = '';
                }
            }

            return { headers, data, error: null };
        } catch (err) {
            return { headers: [], data: [], error: `CSV parsing error: ${err.message}` };
        }
    },

    /**
     * Parse a single CSV line into values
     * Handles quoted values and escaped quotes
     * @param {string} line - Single line of CSV
     * @returns {string[]}
     */
    parseCSVLine(line) {
        const values = [];
        let current = '';
        let inQuotes = false;
        
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            const nextChar = line[i + 1];
            
            if (char === '"') {
                if (inQuotes && nextChar === '"') {
                    // Escaped quote
                    current += '"';
                    i++; // Skip next quote
                } else {
                    // Toggle quote state
                    inQuotes = !inQuotes;
                }
            } else if (char === ',' && !inQuotes) {
                // Field separator
                values.push(current);
                current = '';
            } else if (char === '\\' && nextChar === '"' && inQuotes) {
                // Backslash-escaped quote (Comments.csv style)
                current += '"';
                i++; // Skip the quote
            } else {
                current += char;
            }
        }
        
        // Don't forget the last value
        values.push(current);
        
        return values;
    },

    /**
     * Clean the parsed data based on file type
     * @param {object[]} data - Parsed CSV data as array of objects
     * @param {string} fileType - 'shares' or 'comments'
     * @returns {object[]} Cleaned data
     */
    cleanData(data, fileType) {
        const config = this.configs[fileType];
        if (!config) return data;

        return data.map(row => {
            const cleanedRow = {};
            
            config.columns.forEach(col => {
                const value = row[col.name];
                
                if (col.cleaner && this[col.cleaner]) {
                    cleanedRow[col.name] = this[col.cleaner](value);
                } else {
                    cleanedRow[col.name] = value !== undefined ? String(value).trim() : '';
                }
            });
            
            return cleanedRow;
        });
    },

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
    process(csvText, fileType = 'auto') {
        // Parse CSV
        const { headers, data, error: parseError } = this.parseCSV(csvText);
        
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

        // Always detect the actual file type for better error messages
        const actualDetectedType = this.detectFileType(headers);

        // Determine which type to use for processing
        let processingType = fileType;
        if (fileType === 'auto') {
            processingType = actualDetectedType;
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

        // Validate columns - with smart error messages
        const validation = this.validateColumns(headers, processingType);
        if (!validation.valid) {
            // Generate a helpful error message
            let errorMsg = '';
            
            if (fileType !== 'auto' && actualDetectedType && actualDetectedType !== fileType) {
                // User selected wrong type
                const selectedLabel = fileType === 'shares' ? 'Shares' : 'Comments';
                const detectedLabel = actualDetectedType === 'shares' ? 'Shares' : 'Comments';
                errorMsg = `This looks like a ${detectedLabel} file, but you selected ${selectedLabel}. Please switch to "${detectedLabel}" or "Auto-detect".`;
            } else if (fileType !== 'auto' && !actualDetectedType) {
                // User selected a type but file doesn't match any known format
                const selectedLabel = fileType === 'shares' ? 'Shares' : 'Comments';
                errorMsg = `This file doesn't appear to be a LinkedIn ${selectedLabel} export. Missing columns: ${validation.missing.join(', ')}. Please check that you uploaded the correct file.`;
            } else {
                // Generic error with missing columns
                errorMsg = `Missing required columns: ${validation.missing.join(', ')}`;
            }

            return {
                success: false,
                fileType: processingType,
                detectedType: actualDetectedType,
                headers,
                originalData: data,
                cleanedData: [],
                rowCount: data.length,
                error: errorMsg
            };
        }

        // Clean the data
        const cleanedData = this.cleanData(data, processingType);

        return {
            success: true,
            fileType: processingType,
            detectedType: actualDetectedType,
            headers,
            originalData: data,
            cleanedData,
            rowCount: cleanedData.length,
            error: null
        };
    }
};

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = LinkedInCleaner;
}
