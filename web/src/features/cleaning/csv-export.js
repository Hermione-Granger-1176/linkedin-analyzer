/**
 * Cleaned CSV export for files too large for an in-browser Excel workbook.
 * Rows are written in fixed-size parts and handed to a Blob, so the export
 * never builds one string for the whole file.
 */

import { LinkedInCleaner } from "./cleaner.js";

const ROWS_PER_PART = 2000;
// A byte order mark makes Excel read the file as UTF-8 instead of the system code page.
const BYTE_ORDER_MARK = "﻿";
const NEEDS_QUOTES = /[",\r\n]/;

/**
 * Quote one CSV field when it contains a separator, quote, or line break.
 * @param {unknown} value - Cleaned cell value
 * @returns {string}
 */
export function toCsvField(value) {
    const text = value === null || value === undefined ? "" : String(value);
    return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Build the cleaned rows of one file type as a CSV Blob.
 * @param {object[]} data - Cleaned rows keyed by column name
 * @param {string} fileType - Cleaner file type
 * @returns {Blob}
 */
export function buildCleanedCsvBlob(data, fileType) {
    const headers = getConfig(fileType).columns.map((column) => column.name);
    const toLine = (fields) => `${fields.map(toCsvField).join(",")}\r\n`;
    const parts = [BYTE_ORDER_MARK + toLine(headers)];
    for (let start = 0; start < data.length; start += ROWS_PER_PART) {
        const end = Math.min(start + ROWS_PER_PART, data.length);
        let part = "";
        for (let index = start; index < end; index += 1) {
            const row = data[index];
            part += toLine(headers.map((header) => row[header]));
        }
        parts.push(part);
    }
    return new Blob(parts, { type: "text/csv;charset=utf-8" });
}

/**
 * Download file name for a cleaned CSV. The suffix keeps it apart from the
 * LinkedIn export it came from, which has the same base name.
 * @param {string} fileType - Cleaner file type
 * @returns {string}
 */
export function cleanedCsvName(fileType) {
    return getConfig(fileType).outputName.replace(/\.xlsx$/, "_cleaned.csv");
}

function getConfig(fileType) {
    const config = LinkedInCleaner.configs[fileType];
    if (!config) {
        throw new Error(`Unknown file type: ${fileType}`);
    }
    return config;
}
