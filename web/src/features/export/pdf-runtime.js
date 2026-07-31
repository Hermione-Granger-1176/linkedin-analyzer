/**
 * Everything an export needs the moment one actually runs.
 *
 * The button and its dialog are on every screen, so pdf.js is wired up on every
 * page load; collection, the transports, the layout engine, the fonts and the
 * palette are reached only by a run. Behind this one boundary they are a chunk
 * of their own, which a visitor who never exports never downloads, and it is one
 * boundary rather than six so that a run costs one fetch and the surface has one
 * thing to hold once it has arrived.
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
 * End every worker a run can have started.
 *
 * The analytics one early on, the messages and connections ones while the
 * dashboards are being built, the threads one when message contents were opted
 * into. Gathered here because the surface that cancels no longer holds the four
 * modules they live in: naming them there would mean fetching this chunk to
 * cancel a run that never got as far as needing it.
 */
export function terminateExportWorkers() {
    terminateThreadsWorker();
    terminateMessagesWorker();
    terminateConnectionsWorker();
    terminateAnalyticsWorker();
}
