/**
 * Manage the Save as PDF button, confirmation dialog, and export run.
 *
 * Load jsPDF and the export runtime on demand. Collect data, register fonts,
 * render the document, and download it through a temporary object URL.
 *
 * Names and message contents each need their own opt-in. Caught values are
 * discarded and only fixed error text is reported, since failures may contain
 * uploaded data.
 */

import { captureError } from "../../platform/observability/sentry.js";
import { DataCache } from "../../platform/persistence/data-cache.js";
import { downloadBlob } from "../../shared/ui/download.js";
import { LoadingOverlay } from "../../shared/ui/loading-overlay.js";
import { celebrateStaple } from "../../shared/ui/mascot.js";

import { hasExportableData } from "./availability.js";
import { ExportRefusal } from "./refusal.js";

const OVERLAY_SOURCE = "pdf-export";
const CACHE_EVENTS = new Set(["analyticsChanged", "storageCleared", "filesChanged"]);
const FOCUSABLE_SELECTOR = "button:not(:disabled), input:not(:disabled), [href]";

/**
 * The export's DOM nodes, once `init()` has found every required one.
 * @typedef {object} ExportElements
 * @property {HTMLElement} trigger - Export button
 * @property {HTMLElement|null} hint - Disabled-state hint
 * @property {HTMLElement} backdrop - Dialog backdrop
 * @property {HTMLElement} dialog - Confirmation dialog
 * @property {HTMLInputElement} includeNames - Names opt-in
 * @property {HTMLInputElement} includeMessages - Message contents opt-in
 * @property {HTMLElement} error - Error message slot
 * @property {HTMLElement} status - Live status slot
 * @property {HTMLElement} cancel - Cancel button
 * @property {HTMLButtonElement} confirm - Generate button
 */

/**
 * The same nodes as looked up, before anything is known to exist.
 * @typedef {{[K in keyof ExportElements]: ExportElements[K]|null}} ResolvedElements
 */

// These nodes are read without a null check. `hint` is excluded because every
// use of it already checks for null.
/** @type {ReadonlyArray<keyof ResolvedElements>} */
const REQUIRED_ELEMENTS = Object.freeze([
    "trigger",
    "backdrop",
    "dialog",
    "includeNames",
    "includeMessages",
    "error",
    "status",
    "cancel",
    "confirm",
]);

const ENABLED_LABEL = "Save your insights as a PDF";
const DISABLED_LABEL = "Save as PDF, unavailable until you upload a LinkedIn export";
const DISABLED_HINT = "Upload a LinkedIn export to enable saving as PDF.";
const GENERIC_ERROR = "Something went wrong while building the PDF. Please try again.";

export const PdfExport = (() => {
    "use strict";

    // Every function that reads this runs only after init() has assigned it, so
    // it is typed as the assigned value rather than as the null it starts as.
    let elements = /** @type {ExportElements} */ (/** @type {unknown} */ (null));
    let initialized = false;
    let isOpen = false;
    let isGenerating = false;
    // The trigger uses aria-disabled rather than native disabled, so it stays
    // focusable. open() checks this flag.
    let isAvailable = false;
    // Bumped on every availability check. A result is applied only if its token
    // is still current.
    let availabilityToken = 0;
    /** @type {HTMLElement|null} */
    let lastFocused = null;
    // Bumped when an export starts or is abandoned. A run whose token is no longer
    // current is cancelled and must not download, touch the dialog, move focus,
    // or hide an overlay owned by another run.
    let generationToken = 0;
    /**
     * The export's own modules, once a run has fetched them.
     * @type {typeof import("./pdf-runtime.js")|null}
     */
    let exportRuntime = null;
    /**
     * The fetch itself, kept so a second export reuses the first one's.
     * @type {Promise<typeof import("./pdf-runtime.js")>|null}
     */
    let exportRuntimeLoad = null;

    /**
     * Resolve the DOM elements used by the export.
     * @returns {ResolvedElements} Element references
     */
    function resolveElements() {
        return {
            trigger: document.getElementById("pdfExportBtn"),
            hint: document.getElementById("pdfExportBtnHint"),
            backdrop: document.getElementById("pdfExportDialogBackdrop"),
            dialog: document.getElementById("pdfExportDialog"),
            includeNames: /** @type {HTMLInputElement|null} */ (
                document.getElementById("pdfExportIncludeNames")
            ),
            includeMessages: /** @type {HTMLInputElement|null} */ (
                document.getElementById("pdfExportIncludeMessages")
            ),
            error: document.getElementById("pdfExportDialogError"),
            status: document.getElementById("pdfExportDialogStatus"),
            cancel: document.getElementById("pdfExportCancelBtn"),
            confirm: /** @type {HTMLButtonElement|null} */ (
                document.getElementById("pdfExportConfirmBtn")
            ),
        };
    }

    /** Wire the export button and its dialog. */
    function init() {
        if (initialized) {
            return;
        }

        const resolved = resolveElements();
        // If any required node is missing, init does nothing.
        if (REQUIRED_ELEMENTS.some((name) => !resolved[name])) {
            return;
        }

        // Every required node was checked just above.
        elements = /** @type {ExportElements} */ (resolved);
        initialized = true;
        elements.trigger.addEventListener("click", open);
        elements.cancel.addEventListener("click", close);
        elements.confirm.addEventListener("click", generate);
        elements.backdrop.addEventListener("mousedown", (event) => {
            if (event.target === elements.backdrop) {
                close();
            }
        });
        document.addEventListener("keydown", handleKeydown);

        DataCache.subscribe((event) => {
            const change = /** @type {{type: string}|null} */ (event);
            if (change && CACHE_EVENTS.has(change.type)) {
                refreshAvailability();
            }
        });

        refreshAvailability();
    }

    /**
     * Update export availability and its accessible explanation.
     * Keep the button focusable with aria-disabled so keyboard users can read
     * why it is unavailable. open() checks availability before opening the dialog.
     * @returns {Promise<void>}
     */
    async function refreshAvailability() {
        const token = ++availabilityToken;
        let available = false;
        try {
            available = await hasExportableData();
        } catch {
            captureError(new Error("Export availability check failed."), {
                module: "pdf-export",
                operation: "check-availability",
            });
        }
        // Results from superseded checks are ignored, so a late read cannot
        // overwrite a newer answer.
        if (token !== availabilityToken) {
            return;
        }
        isAvailable = available;
        const label = available ? ENABLED_LABEL : DISABLED_LABEL;
        elements.trigger.setAttribute("aria-disabled", available ? "false" : "true");
        elements.trigger.setAttribute("aria-label", label);
        elements.trigger.title = label;
        if (elements.hint) {
            elements.hint.textContent = available ? "" : DISABLED_HINT;
        }
    }

    /** Open the confirmation dialog. */
    function open() {
        if (isOpen || !isAvailable) {
            return;
        }
        isOpen = true;
        lastFocused = /** @type {HTMLElement|null} */ (document.activeElement);
        hideError();
        // Both opt-ins reset on every open.
        elements.includeNames.checked = false;
        elements.includeMessages.checked = false;
        elements.backdrop.hidden = false;
        focusFirst();
    }

    /** Move focus to the first focusable control in the dialog. */
    function focusFirst() {
        const [first] = focusableElements();
        if (first) {
            first.focus();
        }
    }

    /**
     * List the dialog's focusable controls in tab order.
     * @returns {HTMLElement[]} Focusable elements
     */
    function focusableElements() {
        return Array.from(elements.dialog.querySelectorAll(FOCUSABLE_SELECTOR));
    }

    /**
     * Close the dialog and hand focus back to the trigger.
     *
     * Closing during a generation cancels it.
     */
    function close() {
        if (!isOpen) {
            return;
        }
        isOpen = false;
        if (isGenerating) {
            cancelGeneration();
        }
        elements.backdrop.hidden = true;
        const target = canRestoreFocus(lastFocused) ? lastFocused : elements.trigger;
        lastFocused = null;
        target.focus();
    }

    /**
     * Check whether focus can return to the recorded element.
     * Excludes body, which is not a useful focus target.
     * @param {HTMLElement|null} node - Node recorded when the dialog opened
     * @returns {node is HTMLElement} True when focusing it would land somewhere useful
     */
    function canRestoreFocus(node) {
        return Boolean(
            node && node !== document.body && node.isConnected && typeof node.focus === "function",
        );
    }

    /**
     * Cancel the active export and reset the dialog.
     * Terminates workers only if the runtime is loaded. The runtime is never
     * fetched for cleanup.
     */
    function cancelGeneration() {
        generationToken += 1;
        if (exportRuntime) {
            exportRuntime.terminateExportWorkers();
        }
        setBusy(false);
        LoadingOverlay.hide(OVERLAY_SOURCE);
    }

    /**
     * Handle Escape and trap Tab inside the open dialog.
     * @param {KeyboardEvent} event - Key event
     */
    function handleKeydown(event) {
        // Ignores events when the dialog is no longer connected to the document.
        if (!isOpen || !elements.dialog.isConnected) {
            return;
        }
        if (event.key === "Escape") {
            event.preventDefault();
            close();
            return;
        }
        if (event.key !== "Tab") {
            return;
        }

        const target = tabTarget(event.shiftKey);
        if (!target) {
            return;
        }
        event.preventDefault();
        target.focus();
    }

    /**
     * Pick where a Tab press should send focus to keep it inside the dialog.
     * @param {boolean} backwards - Whether Shift is held
     * @returns {HTMLElement|null} Wrap target, or null to let Tab run natively
     */
    function tabTarget(backwards) {
        const focusable = focusableElements();
        if (!focusable.length) {
            return null;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        // If focus is outside the dialog (for example on body after a click on its
        // heading), Tab wraps to the first or last control instead of leaving it.
        if (!elements.dialog.contains(active)) {
            return backwards ? last : first;
        }
        if (backwards && active === first) {
            return last;
        }
        if (!backwards && active === last) {
            return first;
        }
        return null;
    }

    /**
     * Show a failure message inside the dialog.
     * @param {string} message - Fixed, user-facing text
     */
    function showError(message) {
        elements.error.textContent = message;
    }

    /** Clear any previous failure message. */
    function hideError() {
        showError("");
    }

    /**
     * Set the dialog's busy state. Cancel stays enabled as a focus target for the
     * Tab trap. Progress is announced through the live region.
     * @param {boolean} busy - Whether an export is running
     */
    function setBusy(busy) {
        isGenerating = busy;
        elements.confirm.disabled = busy;
        elements.includeNames.disabled = busy;
        elements.includeMessages.disabled = busy;
        elements.confirm.textContent = busy ? "Generating…" : "Generate PDF";
        elements.dialog.setAttribute("aria-busy", busy ? "true" : "false");

        if (!busy) {
            elements.status.textContent = "";
            return;
        }

        elements.status.textContent = "Generating your PDF. Cancel to stop.";
        // Disabling Confirm moves focus to body, so focus moves to Cancel.
        elements.cancel.focus();
    }

    /**
     * Build the dated file name.
     * @param {Date} generatedAt - Generation timestamp
     * @returns {string} File name
     */
    function buildFilename(generatedAt) {
        const year = generatedAt.getFullYear();
        const month = String(generatedAt.getMonth() + 1).padStart(2, "0");
        const day = String(generatedAt.getDate()).padStart(2, "0");
        return `linkedin-insights-${year}-${month}-${day}.pdf`;
    }

    /**
     * Fetch the export's own modules, at most once a session.
     *
     * The promise is kept, so an export started before the first finishes shares
     * its fetch. A failed fetch is not cached.
     * @returns {Promise<typeof import("./pdf-runtime.js")>} Loaded modules
     */
    function loadExportRuntime() {
        if (!exportRuntimeLoad) {
            exportRuntimeLoad = import("./pdf-runtime.js")
                .then((runtime) => {
                    exportRuntime = runtime;
                    return runtime;
                })
                .catch((error) => {
                    exportRuntimeLoad = null;
                    throw error;
                });
        }
        return exportRuntimeLoad;
    }

    /**
     * Build and download the document.
     * @returns {Promise<void>}
     */
    async function generate() {
        if (isGenerating) {
            return;
        }
        const includeNames = elements.includeNames.checked;
        const includeMessages = elements.includeMessages.checked;
        hideError();
        setBusy(true);
        const token = ++generationToken;
        const isCancelled = () => token !== generationToken;
        let downloaded = false;
        LoadingOverlay.show(OVERLAY_SOURCE, {
            title: "Building your PDF",
            message: "Laying out your insights. Everything stays in this browser.",
        });

        try {
            // Two chunks, fetched together. A run needs both before it can draw,
            // and a failure in either fails the run. A run cancelled during the
            // fetch returns once the chunks arrive.
            const [{ jsPDF }, runtime] = await Promise.all([
                import("jspdf"),
                loadExportRuntime(),
            ]);
            if (isCancelled()) {
                return;
            }
            const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });
            const palette = runtime.readPdfPalette();
            const fonts = await runtime.registerPdfFonts(doc);
            if (isCancelled()) {
                return;
            }
            const generatedAt = new Date();
            const data = await runtime.collectExportData({
                includeNames,
                includeMessages,
                generatedAt,
                // Collection checks cancellation during its storage reads, since
                // terminating a worker that does not exist yet does nothing.
                isCancelled,
            });
            if (isCancelled()) {
                return;
            }

            runtime.renderPdfDocument(doc, data, { palette, fonts });
            downloadBlob(doc.output("blob"), buildFilename(generatedAt));

            // setBusy(false) runs before close(), because close() cancels a
            // generation that is still marked busy. Reversing the order would bump
            // the token for a completed run, so the finally block would skip
            // hiding its overlay.
            setBusy(false);
            close();
            downloaded = true;
        } catch (error) {
            // A cancelled run's failure is neither reported nor shown.
            if (isCancelled()) {
                return;
            }
            // A refusal is shown as is and not reported.
            if (error instanceof ExportRefusal) {
                setBusy(false);
                showError(error.message);
                return;
            }
            // The caught value is discarded, since it can carry the user's own
            // text. Only a fixed error is reported to telemetry.
            captureError(new Error("PDF generation failed."), {
                module: "pdf-export",
                operation: "generate",
            });
            setBusy(false);
            showError(GENERIC_ERROR);
        } finally {
            // A cancelled run leaves the overlay alone, since it may now belong to a newer run.
            if (!isCancelled()) {
                LoadingOverlay.hide(OVERLAY_SOURCE);
            }
        }

        // Celebrates after the download is triggered. Kept outside the catch, so a
        // celebration error does not mark the export as failed.
        if (downloaded) {
            celebrateStaple();
        }
    }

    return { init };
})();
