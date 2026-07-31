/**
 * Save as PDF orchestrator.
 *
 * Owns the global export button and its confirmation dialog, and runs the
 * export: jsPDF is imported lazily so it stays out of the initial bundle, the
 * palette and fonts are gathered, the layout engine draws the document, and the
 * result is downloaded through the same anchor/object-URL dance the Excel
 * export uses.
 *
 * Message bodies can end up inside the downloaded file, by explicit opt-in.
 * Nothing about them is ever logged, reported or sent anywhere: diagnostics
 * from here carry fixed identifiers only.
 */

import { captureError } from "../../platform/observability/sentry.js";
import { DataCache } from "../../platform/persistence/data-cache.js";
import { LoadingOverlay } from "../../shared/ui/loading-overlay.js";

import { collectExportData, hasExportableData } from "./collect.js";
import { registerPdfFonts } from "./fonts.js";
import { readPdfPalette } from "./palette.js";
import { renderPdfDocument } from "./pdf-document.js";

const OVERLAY_SOURCE = "pdf-export";
const CACHE_EVENTS = new Set(["analyticsChanged", "storageCleared", "filesChanged"]);
const FOCUSABLE_SELECTOR = "button:not(:disabled), input:not(:disabled), [href]";

const ENABLED_LABEL = "Save your insights as a PDF";
const DISABLED_LABEL = "Save as PDF, unavailable until you upload a LinkedIn export";
const GENERIC_ERROR = "Something went wrong while building the PDF. Please try again.";

export const PdfExport = (() => {
    "use strict";

    let elements = null;
    let initialized = false;
    let isOpen = false;
    let isGenerating = false;
    let lastFocused = null;

    /**
     * Resolve the DOM the export surface owns.
     * @returns {object} Element references
     */
    function resolveElements() {
        return {
            trigger: document.getElementById("pdfExportBtn"),
            backdrop: document.getElementById("pdfExportDialogBackdrop"),
            dialog: document.getElementById("pdfExportDialog"),
            includeMessages: /** @type {HTMLInputElement|null} */ (
                document.getElementById("pdfExportIncludeMessages")
            ),
            error: document.getElementById("pdfExportDialogError"),
            cancel: document.getElementById("pdfExportCancelBtn"),
            confirm: document.getElementById("pdfExportConfirmBtn"),
        };
    }

    /** Wire the export button and its dialog. */
    function init() {
        if (initialized) {
            return;
        }

        elements = resolveElements();
        if (!elements.trigger || !elements.backdrop || !elements.confirm) {
            return;
        }

        initialized = true;
        elements.trigger.addEventListener("click", open);
        elements.cancel.addEventListener("click", () => close());
        elements.confirm.addEventListener("click", generate);
        elements.backdrop.addEventListener("mousedown", (event) => {
            if (event.target === elements.backdrop) {
                close();
            }
        });
        document.addEventListener("keydown", handleKeydown);

        DataCache.subscribe((event) => {
            if (event && CACHE_EVENTS.has(event.type)) {
                refreshAvailability();
            }
        });

        refreshAvailability();
    }

    /**
     * Enable or disable the trigger, with a reason a screen reader can read.
     * @returns {Promise<void>}
     */
    async function refreshAvailability() {
        let available = false;
        try {
            available = await hasExportableData();
        } catch (error) {
            captureError(error, { module: "pdf-export", operation: "check-availability" });
        }
        elements.trigger.disabled = !available;
        elements.trigger.setAttribute("aria-label", available ? ENABLED_LABEL : DISABLED_LABEL);
        elements.trigger.title = available ? ENABLED_LABEL : DISABLED_LABEL;
    }

    /** Open the confirmation dialog. */
    function open() {
        if (isOpen) {
            return;
        }
        isOpen = true;
        lastFocused = document.activeElement;
        hideError();
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

    /** Close the dialog and hand focus back to the trigger. */
    function close() {
        if (!isOpen || isGenerating) {
            return;
        }
        isOpen = false;
        elements.backdrop.hidden = true;
        const target = lastFocused && lastFocused.focus ? lastFocused : elements.trigger;
        lastFocused = null;
        target.focus();
    }

    /**
     * Handle Escape and trap Tab inside the open dialog.
     * @param {KeyboardEvent} event - Key event
     */
    function handleKeydown(event) {
        if (!isOpen) {
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

        const focusable = focusableElements();
        if (!focusable.length) {
            return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
            return;
        }
        if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    /**
     * Show a failure message inside the dialog.
     * @param {string} message - Fixed, user-facing text
     */
    function showError(message) {
        elements.error.textContent = message;
        elements.error.hidden = false;
    }

    /** Clear any previous failure message. */
    function hideError() {
        elements.error.textContent = "";
        elements.error.hidden = true;
    }

    /**
     * Toggle the dialog's busy state.
     * @param {boolean} busy - Whether an export is running
     */
    function setBusy(busy) {
        isGenerating = busy;
        elements.confirm.disabled = busy;
        elements.cancel.disabled = busy;
        elements.includeMessages.disabled = busy;
        elements.confirm.textContent = busy ? "Generating…" : "Generate PDF";
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
     * Download a blob under the given name.
     * @param {Blob} blob - PDF bytes
     * @param {string} filename - File name
     */
    function download(blob, filename) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    /**
     * Build and download the document.
     * @returns {Promise<void>}
     */
    async function generate() {
        if (isGenerating) {
            return;
        }
        const includeMessages = elements.includeMessages.checked;
        hideError();
        setBusy(true);
        LoadingOverlay.show(OVERLAY_SOURCE, {
            title: "Building your PDF",
            message: "Laying out your insights. Everything stays in this browser.",
        });

        try {
            const { jsPDF } = await import("jspdf");
            const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });
            const palette = readPdfPalette();
            const fonts = await registerPdfFonts(doc);
            const generatedAt = new Date();
            const data = await collectExportData({ includeMessages, generatedAt });

            renderPdfDocument(doc, data, { palette, fonts });
            download(doc.output("blob"), buildFilename(generatedAt));

            setBusy(false);
            close();
        } catch (error) {
            captureError(error, { module: "pdf-export", operation: "generate" });
            setBusy(false);
            showError(GENERIC_ERROR);
        } finally {
            LoadingOverlay.hide(OVERLAY_SOURCE);
        }
    }

    return { init };
})();
