/**
 * Load the modules needed for one PDF export.
 *
 * `pdf.js` loads this module on demand. The initial bundle holds only the
 * export button, dialog, and availability check. One dynamic import loads the
 * collector, workers, layout code, fonts, and palette for the export run.
 */

import { collectExportData, terminateAnalyticsWorker } from "./collect.js";
import { terminateConnectionsWorker } from "./connections-transport.js";
import { registerPdfFonts } from "./fonts.js";
import { terminateMessagesWorker } from "./messages-transport.js";
import { readPdfPalette } from "./palette.js";
import { renderPdfDocument } from "./pdf-document.js";
import { terminateThreadsWorker } from "./threads-transport.js";

export { collectExportData, readPdfPalette, registerPdfFonts, renderPdfDocument };

/**
 * Stop every worker an export can start.
 *
 * The worker modules are static imports of this chunk.
 */
export function terminateExportWorkers() {
    terminateThreadsWorker();
    terminateMessagesWorker();
    terminateConnectionsWorker();
    terminateAnalyticsWorker();
}
