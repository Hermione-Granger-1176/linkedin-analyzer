/**
 * Font loading for the PDF export.
 *
 * The handwritten faces the app uses on screen ship alongside the `.woff2`
 * files as TrueType, which is the only outline format jsPDF can embed. They are
 * fetched at export time so they never enter a JavaScript bundle, and any
 * failure degrades to jsPDF's built-in Helvetica rather than aborting the
 * export.
 */

import { captureError } from "../../platform/observability/sentry.js";

// Mirrors the @font-face sources in styles/foundations/variables.css.
const FONT_ASSETS = Object.freeze([
    Object.freeze({ role: "body", file: "PatrickHand-Regular.ttf", family: "PatrickHand" }),
    Object.freeze({ role: "accent", file: "Caveat-Regular.ttf", family: "Caveat" }),
]);

const FONT_BASE_PATH = "/fonts/";

// jsPDF's built-in core font, used when the TrueType files cannot be fetched.
const FALLBACK_FAMILY = "helvetica";

/** Font families available to the layout engine when embedding fails. */
export const FALLBACK_FONTS = Object.freeze({
    body: FALLBACK_FAMILY,
    accent: FALLBACK_FAMILY,
    embedded: false,
});

// btoa() takes a binary string, and spreading a multi-megabyte array into
// String.fromCharCode overflows the call stack, so it is fed in slices.
const BASE64_CHUNK_SIZE = 0x8000;

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
 * Fetch one TrueType asset.
 * @param {string} file - File name under the public fonts directory
 * @returns {Promise<ArrayBuffer>} Font bytes
 */
async function fetchFont(file) {
    const response = await fetch(`${FONT_BASE_PATH}${file}`);
    if (!response.ok) {
        throw new Error(`Font request failed with status ${response.status}`);
    }
    return response.arrayBuffer();
}

/**
 * Fetch and register the handwritten faces on a jsPDF document.
 *
 * Registration is all-or-nothing: a document with one embedded face and one
 * core face would look broken, so a single failure falls back to Helvetica for
 * everything.
 * @param {object} doc - jsPDF document instance
 * @returns {Promise<Readonly<{body: string, accent: string, embedded: boolean}>>} Registered family names
 */
export async function registerPdfFonts(doc) {
    try {
        const buffers = await Promise.all(FONT_ASSETS.map((asset) => fetchFont(asset.file)));

        FONT_ASSETS.forEach((asset, index) => {
            doc.addFileToVFS(asset.file, encodeFontBytes(buffers[index]));
            doc.addFont(asset.file, asset.family, "normal");
        });

        const families = { body: FALLBACK_FAMILY, accent: FALLBACK_FAMILY, embedded: true };
        for (const asset of FONT_ASSETS) {
            families[asset.role] = asset.family;
        }
        return Object.freeze(families);
    } catch (error) {
        // The export still produces a valid document, so this is a degradation
        // rather than a failure. No file contents or user text are attached.
        captureError(error, {
            module: "pdf-export",
            operation: "register-fonts",
        });
        return FALLBACK_FONTS;
    }
}
