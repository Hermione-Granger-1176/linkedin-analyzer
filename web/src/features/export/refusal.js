/**
 * An export the browser declines up front, with a reason safe to show as is.
 *
 * The PDF dialog shows a generic error for every other failure, because those
 * can carry the user's own text. A refusal carries only fixed text from this
 * module, so the dialog can tell the user exactly what to change. It lives
 * apart from the export runtime so the dialog can recognise one without
 * loading that chunk.
 */

import { THREADS_EXPORT_MAX_BYTES } from "../../shared/limits.js";

const MAX_MB = Math.round(THREADS_EXPORT_MAX_BYTES / (1024 * 1024));

/** Shown when message contents are asked for from a messages file too large to hold them. */
export const MESSAGES_TOO_LARGE_FOR_CONTENTS =
    `Message contents can't be added from a messages file over ${MAX_MB} MB: it needs more ` +
    'memory than a browser tab can count on. Untick "Include message contents" to export ' +
    "everything else.";

/** An export declined before it started, with fixed text for the user. */
export class ExportRefusal extends Error {
    /** @param {string} message - Fixed, user-facing reason */
    constructor(message) {
        super(message);
        this.name = "ExportRefusal";
    }
}
