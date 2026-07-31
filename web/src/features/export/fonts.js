/**
 * Font loading for the PDF export.
 *
 * The handwritten faces the app uses on screen ship alongside the `.woff2`
 * files as TrueType, which is the only outline format jsPDF can embed. They are
 * fetched at export time so they never enter a JavaScript bundle, and any
 * failure degrades to jsPDF's built-in Helvetica rather than aborting the
 * export.
 *
 * Registration also settles what the document can spell: the faces are Latin,
 * and the collector has to know that before it puts a name on the page. The
 * answer is read out of each face's own cmap rather than assumed, so swapping a
 * face changes what survives without changing any code.
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
 * Font families available to the layout engine when embedding fails.
 *
 * No separate "did this embed" flag: it is the family names that say so, and a
 * second field carrying the same fact is one more thing to keep true.
 */
export const FALLBACK_FONTS = Object.freeze({
    body: FALLBACK_FAMILY,
    accent: FALLBACK_FAMILY,
});

// btoa() takes a binary string, and spreading a multi-megabyte array into
// String.fromCharCode overflows the call stack, so it is fed in slices.
const BASE64_CHUNK_SIZE = 0x8000;

// The characters cp1252 maps in the gap Latin-1 leaves at 0x80 to 0x9F. jsPDF
// writes a core font's text as WinAnsi bytes, so those plus printable ASCII and
// Latin-1 are exactly what the Helvetica fallback can show, and one character
// outside them turns the whole string into UTF-16 mojibake rather than costing
// only itself.
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
    for (let code = 0x20; code <= 0x7e; code += 1) {
        coverage.add(code);
    }
    for (let code = 0xa0; code <= 0xff; code += 1) {
        coverage.add(code);
    }
    return coverage;
}

const WINANSI_COVERAGE = buildWinAnsiCoverage();

/**
 * What the document currently being drawn can spell.
 *
 * Registration is the only step that knows which faces a document ended up
 * with, and it runs before a word of it is collected, so it records the answer
 * here instead of the collector re-deriving it. Until it has, the coverage every
 * path is sure of is assumed.
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
 * Collect the code points one segmented cmap subtable lists.
 *
 * The segment bounds are read, not the glyph ids they resolve to: a subsetted
 * face lists exactly the characters it kept, which is what both shipped faces
 * do, and resolving ids would buy only the ability to notice a face that maps
 * one of its own listed characters to .notdef.
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
        // 0xFFFF closes the list, and real segments are ordered and never
        // overlap: anything else is a table this cannot read, and walking it
        // would go over the same ranges again and again.
        if (start === 0xffff || start <= previousEnd || end < start) {
            return;
        }
        for (let code = start; code <= end; code += 1) {
            coverage.add(code);
        }
        previousEnd = end;
    }
}

/**
 * Read the code points one face can draw, out of its own cmap.
 *
 * A cmap written in a format this does not read reports nothing rather than
 * guessing, and the caller falls back to the coverage every path is sure of.
 * That under-uses such a face; it never claims a glyph that is not there.
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
 * Narrow several faces' coverage to the characters all of them carry.
 *
 * The document model is built without knowing which face will draw which
 * string, so a character counts as drawable only when every embedded face has
 * it. A face whose cmap could not be read takes the whole document back to
 * WinAnsi rather than lending it coverage nobody has checked.
 * @param {Array<Set<number>|null>} coverages - One entry per embedded face
 * @returns {Set<number>} Code points the document can draw
 */
function intersectCoverage(coverages) {
    if (coverages.some((coverage) => coverage === null)) {
        return WINANSI_COVERAGE;
    }
    const [first, ...rest] = /** @type {Array<Set<number>>} */ (coverages);
    const shared = new Set(first);
    for (const coverage of rest) {
        for (const code of shared) {
            if (!coverage.has(code)) {
                shared.delete(code);
            }
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
 * Fetch one TrueType asset, giving up rather than hanging.
 *
 * A font server that accepts the connection and then never answers would
 * otherwise leave the dialog busy and the overlay up forever: the export awaits
 * these before it draws anything. An abort is treated like any other font
 * failure, so the document falls back to Helvetica and still downloads.
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
 * Registration is all-or-nothing: a document with one embedded face and one
 * core face would look broken, so a single failure falls back to Helvetica for
 * everything.
 * @param {object} doc - jsPDF document instance
 * @returns {Promise<Readonly<{body: string, accent: string}>>} Registered family names
 */
export async function registerPdfFonts(doc) {
    try {
        const buffers = await Promise.all(FONT_ASSETS.map((asset) => fetchFont(asset.file)));
        // Read before anything is registered: a file this cannot get through is
        // not one the document should be drawn with either, and the catch below
        // then leaves both the families and the coverage on the fallback.
        const coverage = intersectCoverage(buffers.map(readFontCoverage));

        const families = { body: FALLBACK_FAMILY, accent: FALLBACK_FAMILY };
        FONT_ASSETS.forEach((asset, index) => {
            doc.addFileToVFS(asset.file, encodeFontBytes(buffers[index]));
            doc.addFont(asset.file, asset.family, "normal");
            families[asset.role] = asset.family;
        });
        drawableCoverage = coverage;
        return Object.freeze(families);
    } catch {
        // The export still produces a valid document, so this is a degradation
        // rather than a failure. The caught value is discarded so this path
        // matches the rest of the export: fixed errors only.
        captureError(new Error("PDF font registration failed."), {
            module: "pdf-export",
            operation: "register-fonts",
        });
        drawableCoverage = WINANSI_COVERAGE;
        return FALLBACK_FONTS;
    }
}
