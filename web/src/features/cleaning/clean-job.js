/**
 * The Clean screen's work: clean one stored upload and build what the page
 * asked for from it. It runs in `cleaning-worker.js`, and on the main thread
 * only where Workers are unavailable.
 *
 * The cleaned rows of the last file stay here, keyed by the stored upload, so
 * a download after the preview reuses them instead of cleaning the file again.
 * Only the preview rows and the finished file go back to the page, never the
 * cleaned data.
 */

import { CLEAN_PREVIEW_MAX_ROWS } from "../../app/worker-contracts.js";
import { csvSourceSize } from "../../shared/csv-source.js";
import { EXCEL_EXPORT_MAX_BYTES } from "../../shared/limits.js";

import { LinkedInCleaner } from "./cleaner.js";
import { buildCleanedCsvBlob } from "./csv-export.js";
import { ExcelGenerator } from "./excel.js";
import { processCsvSource } from "./process-source.js";

export const PREVIEW_ROW_LIMIT = CLEAN_PREVIEW_MAX_ROWS;

/** @typedef {import("./cleaner.js").CleanedRow} CleanedRow */
/** @typedef {import("../../app/worker-contracts.js").CleaningRequestPayload} CleaningRequestPayload */
/** @typedef {import("../../app/worker-contracts.js").CleanedPayload} CleanedPayload */

/**
 * Cleaned rows of the last file, kept for a later download of the same upload.
 * @typedef {object} HeldClean
 * @property {string} key - Stored upload key
 * @property {string} fileType - File type the rows were cleaned as
 * @property {number} sourceSize - Size of the source, for the Excel size limit
 * @property {CleanedRow[]} rows - Cleaned rows
 * @property {number} rowCount - Cleaned row count
 */

/** @type {HeldClean|null} */
let held = null;

/** Drop the cleaned rows held from the last file. */
export function resetCleanJob() {
    held = null;
}

/**
 * Clean the requested file, or reuse the rows already cleaned from it.
 * @param {{fileType: string, source: Blob|string, key: string}} payload - Request payload
 * @returns {Promise<HeldClean|{error: string}>}
 */
async function cleanFile({ fileType, source, key }) {
    if (held && key && held.key === key && held.fileType === fileType) {
        return held;
    }
    // Drop the previous file's rows before reading the next one, so two
    // cleaned files are never alive at once.
    held = null;
    const processed = await processCsvSource(source, fileType);
    if (!processed.success) {
        return { error: processed.error || "Unable to parse file." };
    }
    held = {
        key,
        fileType,
        sourceSize: csvSourceSize(source),
        rows: processed.cleanedData,
        rowCount: processed.rowCount,
    };
    return held;
}

/**
 * Turn one cleaned cell into preview text.
 * @param {unknown} value - Cleaned cell value
 * @returns {string}
 */
function toPreviewText(value) {
    return value === null || value === undefined ? "" : String(value);
}

/**
 * Handle one cleaning request.
 * @param {CleaningRequestPayload} payload - Request payload
 * @returns {Promise<CleanedPayload>}
 */
export async function runCleanJob(payload) {
    const cleaned = await cleanFile(payload);
    if ("error" in cleaned) {
        return { success: false, error: cleaned.error, rowCount: 0, previewRows: [], blob: null };
    }
    /** @type {CleanedPayload} */
    const reply = {
        success: true,
        error: null,
        rowCount: cleaned.rowCount,
        previewRows: [],
        blob: null,
    };
    if (payload.output === "preview") {
        // The clean succeeded, so fileType names a known config.
        const config = /** @type {import("./configs.js").CleanerConfig} */ (
            LinkedInCleaner.configs[payload.fileType]
        );
        const headers = config.columns.map((column) => column.name);
        reply.previewRows = cleaned.rows
            .slice(0, PREVIEW_ROW_LIMIT)
            .map((row) => headers.map((header) => toPreviewText(row[header])));
        return reply;
    }
    if (payload.output === "csv") {
        reply.blob = buildCleanedCsvBlob(cleaned.rows, payload.fileType);
        return reply;
    }
    if (cleaned.sourceSize > EXCEL_EXPORT_MAX_BYTES) {
        return {
            ...reply,
            success: false,
            error: "This file is too large to build an Excel file.",
        };
    }
    reply.blob = await ExcelGenerator.generate(cleaned.rows, payload.fileType);
    return reply;
}
