/**
 * Text safety for the PDF export: keep what the document's fonts can draw, and
 * show where the rest was.
 *
 * The handwritten faces the export embeds are Latin, and jsPDF simply omits a
 * character they have no glyph for. "Ňuňo Smith" reached the page as "uo Smith"
 * and "田中 Fernández-Hall" as " Fernández-Hall": names damaged with nothing on
 * the page to say they had been. A face with wider coverage would add megabytes
 * to an app that fetches 225 KB of fonts only when an export runs, so the loss is
 * made visible instead. A reader who can see that a name is broken can go and
 * find it; a reader shown a quietly wrong name cannot.
 *
 * The core-font fallback needs the same pass for a different reason. jsPDF
 * writes a core-font string as WinAnsi bytes, and one character outside that
 * encoding turns the whole string into UTF-16 mojibake, so the same name printed
 * as "u0N-   F e r n á n d e z - H a l l". There one unsupported character costs
 * the rest of the line too, which is why the fallback declares its own narrower
 * coverage rather than skipping this.
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
 * @param {any} value - Value from the document model
 * @returns {boolean} True for object literals and null-prototype objects
 */
function isPlainObject(value) {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

/**
 * Sanitize every string in a document model, leaving its shape alone.
 *
 * One pass over the finished model rather than a call at each site: names,
 * companies, positions, topics, stat values and message bodies enter the
 * document from five different collectors, and the defect this exists to stop is
 * exactly the one where the sixth is added and nobody remembers. Numbers, dates
 * and anything else carrying behavior of its own are handed straight back, so
 * only literals and arrays are rebuilt.
 * @param {any} value - Document model, or any part of one
 * @param {Set<number>} coverage - Code points the document's fonts can draw
 * @returns {any} The same model with drawable text
 */
export function sanitizeModel(value, coverage) {
    if (typeof value === "string") {
        return sanitizeText(value, coverage);
    }
    if (Array.isArray(value)) {
        return value.map((entry) => sanitizeModel(entry, coverage));
    }
    if (!isPlainObject(value)) {
        return value;
    }

    const sanitized = {};
    for (const [key, entry] of Object.entries(value)) {
        sanitized[key] = sanitizeModel(entry, coverage);
    }
    return sanitized;
}
