/**
 * Load and register TrueType fonts for PDF export.
 *
 * Fetch fonts on demand and fall back to Helvetica if either font fails.
 * Read each font's cmap to record the code points the document can draw.
 */

import { captureError } from "../../platform/observability/sentry.js";

// Mirrors the @font-face sources in styles/foundations/variables.css.
const FONT_ASSETS = Object.freeze([
    Object.freeze({ role: "body", file: "PatrickHand-Regular.ttf", family: "PatrickHand" }),
    Object.freeze({ role: "accent", file: "Caveat-Regular.ttf", family: "Caveat" }),
]);

const FONT_BASE_PATH = "/fonts/";
const FONT_TIMEOUT_MS = 10000;

// jsPDF's built-in core font, used when the TrueType files cannot be fetched.
const FALLBACK_FAMILY = "helvetica";

/**
 * Font families used when embedded font registration fails.
 */
export const FALLBACK_FONTS = Object.freeze({
    body: FALLBACK_FAMILY,
    accent: FALLBACK_FAMILY,
});

// Bytes are converted to a binary string in slices of this size.
const BASE64_CHUNK_SIZE = 0x8000;

// The cp1252 characters in the 0x80 to 0x9F range that Latin-1 leaves unassigned.
// With printable ASCII and Latin-1, these are the characters the Helvetica
// fallback can draw. A character outside that set corrupts the whole string.
const WINANSI_EXTRAS = Object.freeze([
    0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
    0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122,
    0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

// The four-character tag of the TrueType table that maps characters to glyphs,
// and the one subtable format read below.
const CMAP_TAG = "cmap";
const CMAP_SEGMENTED_FORMAT = 4;

/**
 * Build the coverage of jsPDF's core fonts: printable ASCII, Latin-1 and cp1252.
 * @returns {Set<number>} Code points a core font can draw
 */
function buildWinAnsiCoverage() {
    const coverage = new Set(WINANSI_EXTRAS);
    addRange(coverage, 0x20, 0x7e);
    addRange(coverage, 0xa0, 0xff);
    return coverage;
}

/**
 * Add an inclusive range of code points to a coverage set.
 * @param {Set<number>} coverage - Set to add to
 * @param {number} from - First code point
 * @param {number} to - Last code point
 */
function addRange(coverage, from, to) {
    for (let code = from; code <= to; code += 1) {
        coverage.add(code);
    }
}

const WINANSI_COVERAGE = buildWinAnsiCoverage();

/**
 * Code points supported by the registered document fonts.
 * Use the fallback coverage until registration records the embedded coverage.
 * @type {Set<number>}
 */
let drawableCoverage = WINANSI_COVERAGE;

/**
 * Base64-encode font bytes for jsPDF's virtual file system.
 * @param {ArrayBuffer} buffer - Raw font file bytes
 * @returns {string} Base64 text
 */
export function encodeFontBytes(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_SIZE));
    }
    return btoa(binary);
}

/**
 * Locate a table in a TrueType file's directory.
 * @param {DataView} view - Whole font file
 * @param {string} tag - Four-character table tag
 * @returns {number} Byte offset of the table, or -1 when the file has no such table
 */
function findFontTable(view, tag) {
    const tableCount = view.getUint16(4);
    for (let index = 0; index < tableCount; index += 1) {
        const record = 12 + index * 16;
        const name = String.fromCharCode(
            view.getUint8(record),
            view.getUint8(record + 1),
            view.getUint8(record + 2),
            view.getUint8(record + 3),
        );
        if (name === tag) {
            return view.getUint32(record + 8);
        }
    }
    return -1;
}

/**
 * Collect code points listed by a segmented cmap subtable.
 * The shipped subsets list their retained characters. This reads segment bounds
 * without checking whether individual glyph IDs resolve to .notdef.
 * @param {DataView} view - Whole font file
 * @param {number} offset - Byte offset of the subtable
 * @param {Set<number>} coverage - Set to add to
 */
function addSegmentedCoverage(view, offset, coverage) {
    const segmentCount = view.getUint16(offset + 6) / 2;
    const endCodes = offset + 14;
    // Two bytes of padding sit between the end codes and the start codes.
    const startCodes = endCodes + segmentCount * 2 + 2;

    let previousEnd = -1;
    for (let index = 0; index < segmentCount; index += 1) {
        const start = view.getUint16(startCodes + index * 2);
        const end = view.getUint16(endCodes + index * 2);
        // 0xFFFF ends the list. Segments must be ordered and non-overlapping;
        // anything else stops the read.
        if (start === 0xffff || start <= previousEnd || end < start) {
            return;
        }
        addRange(coverage, start, end);
        previousEnd = end;
    }
}

/**
 * Read supported code points from a font's cmap.
 * Returns null when the cmap is missing or lists no code points.
 * @param {ArrayBuffer} buffer - Whole font file
 * @returns {Set<number>|null} Code points, or null when the cmap says nothing
 */
function readFontCoverage(buffer) {
    const view = new DataView(buffer);
    const cmap = findFontTable(view, CMAP_TAG);
    if (cmap < 0) {
        return null;
    }

    const coverage = new Set();
    const subtableCount = view.getUint16(cmap + 2);
    for (let index = 0; index < subtableCount; index += 1) {
        const subtable = cmap + view.getUint32(cmap + 8 + index * 8);
        if (view.getUint16(subtable) === CMAP_SEGMENTED_FORMAT) {
            addSegmentedCoverage(view, subtable, coverage);
        }
    }
    return coverage.size ? coverage : null;
}

/**
 * Intersect the coverage of all registered faces.
 * Returns the code points present in every face, since a string is not assigned
 * a face. Falls back to WinAnsi when any cmap is unreadable or there are no faces.
 * @param {Array<Set<number>|null>} coverages - One entry per embedded face
 * @returns {Set<number>} Code points the document can draw
 */
function intersectCoverage(coverages) {
    if (!coverages.length || coverages.includes(null)) {
        return WINANSI_COVERAGE;
    }
    const [first, ...rest] = /** @type {Array<Set<number>>} */ (coverages);
    const shared = new Set();
    for (const code of first) {
        if (rest.every((coverage) => coverage.has(code))) {
            shared.add(code);
        }
    }
    return shared;
}

/**
 * Report the code points the document being drawn can show.
 * @returns {Set<number>} Code points recorded by the last registration
 */
export function readDrawableCoverage() {
    return drawableCoverage;
}

/**
 * Fetch one TrueType asset. The request is aborted after FONT_TIMEOUT_MS.
 * @param {string} file - File name under the public fonts directory
 * @returns {Promise<ArrayBuffer>} Font bytes
 */
async function fetchFont(file) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), FONT_TIMEOUT_MS);
    try {
        const response = await fetch(`${FONT_BASE_PATH}${file}`, { signal: controller.signal });
        if (!response.ok) {
            throw new Error(`Font request failed with status ${response.status}`);
        }
        return await response.arrayBuffer();
    } finally {
        window.clearTimeout(timeoutId);
    }
}

/**
 * Fetch and register the handwritten faces on a jsPDF document.
 *
 * Registration is all-or-nothing: a single failure falls back to Helvetica for
 * every face.
 * @param {import("jspdf").jsPDF} doc - jsPDF document instance
 * @returns {Promise<Readonly<{body: string, accent: string}>>} Registered family names
 */
export async function registerPdfFonts(doc) {
    try {
        // Each face carries its own bytes.
        const faces = await Promise.all(
            FONT_ASSETS.map(async (asset) => ({ asset, buffer: await fetchFont(asset.file) })),
        );
        // Coverage is read before anything is registered. If it fails, the catch
        // below leaves both the families and the coverage on the fallback.
        const coverage = intersectCoverage(faces.map((face) => readFontCoverage(face.buffer)));

        const families = { body: FALLBACK_FAMILY, accent: FALLBACK_FAMILY };
        for (const { asset, buffer } of faces) {
            doc.addFileToVFS(asset.file, encodeFontBytes(buffer));
            doc.addFont(asset.file, asset.family, "normal");
            families[asset.role] = asset.family;
        }
        drawableCoverage = coverage;
        return Object.freeze(families);
    } catch {
        // A registration failure degrades the export rather than failing it. The
        // caught value is not reported; only the fixed error is.
        captureError(new Error("PDF font registration failed."), {
            module: "pdf-export",
            operation: "register-fonts",
        });
        drawableCoverage = WINANSI_COVERAGE;
        return FALLBACK_FONTS;
    }
}
