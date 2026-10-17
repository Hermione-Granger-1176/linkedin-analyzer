/* Upload size limits, shared by the main thread and the workers. */

const MIB = 1024 * 1024;

/** @typedef {{maxFileBytes: number, maxCsvChars: number, maxCsvRows: number}} UploadLimits */

/** The limits every production build enforces. */
export const PUBLIC_LIMITS = Object.freeze({
    maxFileBytes: 80 * MIB,
    maxCsvChars: 60 * MIB,
    maxCsvRows: 500000,
});

/** Higher limits for measuring large exports in development and test builds. */
export const MEASUREMENT_LIMITS = Object.freeze({
    maxFileBytes: 128 * MIB,
    maxCsvChars: 128 * MIB,
    maxCsvRows: 1000000,
});

/**
 * Pick the limits for a build. The measurement limits apply only when a
 * non-production build sets VITE_MEASUREMENT_LIMITS to "1", so a production
 * build always enforces the public limits.
 * @param {{MODE?: string, VITE_MEASUREMENT_LIMITS?: string}|undefined} env - Vite build environment
 * @returns {UploadLimits}
 */
export function resolveLimits(env) {
    if (env && env.MODE !== "production" && env.VITE_MEASUREMENT_LIMITS === "1") {
        return MEASUREMENT_LIMITS;
    }
    return PUBLIC_LIMITS;
}

const LIMITS = resolveLimits(import.meta.env);

/** Hard ceiling on a single uploaded file, in bytes. */
export const MAX_FILE_BYTES = LIMITS.maxFileBytes;

/** Maximum decoded CSV size, in characters. */
export const MAX_CSV_CHARS = LIMITS.maxCsvChars;

/** Maximum CSV rows the parser accepts. */
export const MAX_CSV_ROWS = LIMITS.maxCsvRows;

/**
 * Largest messages file the PDF export takes message contents from. Above it
 * the bodies cannot be held alongside the analysis within the memory budget,
 * so the export is refused with a reason and the rest can be exported without
 * them.
 */
export const THREADS_EXPORT_MAX_BYTES = 60 * MIB;

/**
 * Largest file the Clean screen turns into an Excel workbook. The workbook is
 * built whole in memory at about 25 bytes of heap per byte of file, so larger
 * files download as cleaned CSV instead.
 */
export const EXCEL_EXPORT_MAX_BYTES = 10 * MIB;
