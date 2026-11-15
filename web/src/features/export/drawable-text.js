/**
 * Replace text the PDF fonts cannot draw with a visible placeholder.
 *
 * The embedded handwritten fonts omit unsupported characters, and the Helvetica
 * fallback draws only WinAnsi characters. Each font path supplies its supported
 * code points.
 */

// Drawn once in place of each run of undrawable characters, not once per
// character. Every face the export can use draws a question mark, including the
// core font.
const PLACEHOLDER = "?";

// Always drawable: jsPDF's line splitting reads these from message bodies, and
// no font carries a glyph for them.
const LAYOUT_CHARACTERS = new Set(["\n", "\r", "\t"]);

/**
 * Report whether one character has a glyph in the document's fonts.
 * @param {string} character - Single character
 * @param {Set<number>} coverage - Code points the document's fonts can draw
 * @returns {boolean} True when it can be drawn as it is
 */
function isDrawable(character, coverage) {
    if (LAYOUT_CHARACTERS.has(character)) {
        return true;
    }
    // Iterating a string yields whole characters, so there is always a code
    // point here, surrogate pairs included.
    return coverage.has(/** @type {number} */ (character.codePointAt(0)));
}

/**
 * Replace every undrawable run in a string with one placeholder.
 *
 * Normalized to NFC first, so a decomposed accented letter is checked in its
 * precomposed form.
 * @param {string} value - Text bound for the document
 * @param {Set<number>} coverage - Code points the document's fonts can draw
 * @returns {string} Text the fonts can draw
 */
export function sanitizeText(value, coverage) {
    const text = value.normalize("NFC");
    let drawn = "";
    let replaced = false;
    let inRun = false;

    for (const character of text) {
        if (isDrawable(character, coverage)) {
            drawn += character;
            inRun = false;
            continue;
        }
        if (!inRun) {
            drawn += PLACEHOLDER;
            inRun = true;
            replaced = true;
        }
    }

    // Trimmed only when a run was replaced. Text with no replacements is returned
    // unchanged. Trimming removes the spaces left beside a replaced run.
    return replaced ? drawn.trim() : text;
}

/**
 * Report whether a value is a bare object worth walking into.
 * @param {unknown} value - Value from the document model
 * @returns {value is Record<string, unknown>} True for object literals and null-prototype objects
 */
function isPlainObject(value) {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

/**
 * Sanitize strings throughout the completed document model.
 * Plain objects and arrays are rebuilt. Numbers, dates, and other non-plain
 * values are returned as they are.
 * @template T
 * @param {T} value - Document model, or any part of one
 * @param {Set<number>} coverage - Code points the document's fonts can draw
 * @returns {T} The same model with drawable text
 */
export function sanitizeModel(value, coverage) {
    // Each rebuilt value keeps the input's shape, so the casts return it as type T.
    if (typeof value === "string") {
        return /** @type {T} */ (sanitizeText(value, coverage));
    }
    if (Array.isArray(value)) {
        return /** @type {T} */ (value.map((entry) => sanitizeModel(entry, coverage)));
    }
    if (!isPlainObject(value)) {
        return value;
    }

    /** @type {Record<string, unknown>} */
    const sanitized = {};
    for (const [key, entry] of Object.entries(value)) {
        sanitized[key] = sanitizeModel(entry, coverage);
    }
    return /** @type {T} */ (sanitized);
}
