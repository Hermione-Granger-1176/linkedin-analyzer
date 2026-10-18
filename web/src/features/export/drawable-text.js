/**
 * Replace text the PDF fonts cannot draw with a visible placeholder.
 *
 * The embedded handwritten fonts omit unsupported characters. Without a
 * placeholder, a name can lose characters without any indication. The Helvetica
 * fallback also needs this pass because characters outside WinAnsi can corrupt
 * the rest of a line. Each font path supplies its supported code points.
 */

// Drawn in place of each run of characters the fonts cannot show. A question
// mark is itself drawable by every face the export can be using, the core font
// included, and it is already read as "something was here that could not be
// shown". One per run rather than one per character: a name in Chinese should
// read as a name that could not be printed, not as a row of marks.
const PLACEHOLDER = "?";

// Layout rather than glyphs: jsPDF's own line splitting reads these out of a
// message body, and no cmap carries a newline.
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
 * Composed first: a decomposed "é" is an "e" and a combining acute, and both
 * faces carry the precomposed letter, so normalizing keeps an accent that would
 * otherwise have been drawn loose or dropped.
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

    // Trimmed only where something was replaced, so ordinary text is handed back
    // exactly as it came: a name that was nothing but undrawable characters
    // should not print as an indented placeholder, and the space a lost
    // character used to sit beside must not survive it either.
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
 * Rebuild plain objects and arrays so every collector receives the same text
 * handling. Preserve numbers, dates, and other non-plain values.
 * @template T
 * @param {T} value - Document model, or any part of one
 * @param {Set<number>} coverage - Code points the document's fonts can draw
 * @returns {T} The same model with drawable text
 */
export function sanitizeModel(value, coverage) {
    // Each rebuilt value keeps the shape it came in with, which is what lets
    // the casts below hand it back as the type it was given as.
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
