/**
 * Load the modules needed for one PDF export.
 *
 * `pdf.js` loads this module on demand, so the initial bundle contains only the
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
 * Keep worker termination here so `pdf.js` can cancel before this chunk loads
 * without importing it solely for cleanup. The worker modules are static imports
 * once this runtime chunk loads.
 */
export function terminateExportWorkers() {
    terminateThreadsWorker();
    terminateMessagesWorker();
    terminateConnectionsWorker();
    terminateAnalyticsWorker();
}
