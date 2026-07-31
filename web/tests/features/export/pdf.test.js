import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectFixedError, piiError } from "../../helpers/pii-sentinel.js";

const jsPDF = vi.hoisted(() => vi.fn());

vi.mock("jspdf", () => ({ jsPDF }));

vi.mock("../../../src/platform/observability/sentry.js", () => ({
    captureError: vi.fn(),
}));

vi.mock("../../../src/platform/persistence/data-cache.js", () => ({
    DataCache: { subscribe: vi.fn() },
}));

vi.mock("../../../src/shared/ui/loading-overlay.js", () => ({
    LoadingOverlay: { show: vi.fn(), hide: vi.fn() },
}));

vi.mock("../../../src/features/export/collect.js", () => ({
    collectExportData: vi.fn(),
    hasExportableData: vi.fn(),
    terminateAnalyticsWorker: vi.fn(),
}));

vi.mock("../../../src/features/export/fonts.js", () => ({
    registerPdfFonts: vi.fn(),
}));

vi.mock("../../../src/features/export/palette.js", () => ({
    readPdfPalette: vi.fn(),
}));

vi.mock("../../../src/features/export/pdf-document.js", () => ({
    renderPdfDocument: vi.fn(),
}));

vi.mock("../../../src/features/export/threads-transport.js", () => ({
    terminateThreadsWorker: vi.fn(),
}));

// Mirrors web/index.html, which renders the trigger in its unavailable resting
// state until the asynchronous availability check says otherwise.
const MARKUP = `
    <button
        id="pdfExportBtn"
        aria-disabled="true"
        aria-label="Save as PDF, unavailable until you upload a LinkedIn export"
        aria-describedby="pdfExportBtnHint"
        title="Save as PDF, unavailable until you upload a LinkedIn export"
    ></button>
    <span class="sr-only" id="pdfExportBtnHint">Upload a LinkedIn export to enable saving as PDF.</span>
    <div class="export-dialog-backdrop" id="pdfExportDialogBackdrop" hidden>
        <div id="pdfExportDialog" role="dialog" aria-modal="true">
            <input type="checkbox" id="pdfExportIncludeMessages" />
            <p id="pdfExportDialogError" hidden></p>
            <p id="pdfExportDialogStatus" role="status" aria-live="polite" hidden></p>
            <button id="pdfExportCancelBtn">Cancel</button>
            <button id="pdfExportConfirmBtn">Generate PDF</button>
        </div>
    </div>
`;

let docStub = null;
let PdfExport;
let collectExportData;
let hasExportableData;
let terminateAnalyticsWorker;
let registerPdfFonts;
let readPdfPalette;
let renderPdfDocument;
let terminateThreadsWorker;
let captureError;
let DataCache;
let LoadingOverlay;

/**
 * Re-import the export surface and every module it is mocked against.
 *
 * The module keeps an init latch, so each test needs a fresh instance; that
 * means re-reading the mocks too, since resetModules recreates them.
 * @returns {Promise<void>}
 */
async function loadModules() {
    vi.resetModules();
    ({ collectExportData, hasExportableData, terminateAnalyticsWorker } = await import(
        "../../../src/features/export/collect.js"
    ));
    ({ registerPdfFonts } = await import("../../../src/features/export/fonts.js"));
    ({ readPdfPalette } = await import("../../../src/features/export/palette.js"));
    ({ renderPdfDocument } = await import("../../../src/features/export/pdf-document.js"));
    ({ terminateThreadsWorker } = await import(
        "../../../src/features/export/threads-transport.js"
    ));
    ({ captureError } = await import("../../../src/platform/observability/sentry.js"));
    ({ DataCache } = await import("../../../src/platform/persistence/data-cache.js"));
    ({ LoadingOverlay } = await import("../../../src/shared/ui/loading-overlay.js"));
    ({ PdfExport } = await import("../../../src/features/export/pdf.js"));
}

/**
 * Read the currently mounted export elements.
 * @returns {object} Element references
 */
function ui() {
    return {
        trigger: document.getElementById("pdfExportBtn"),
        hint: document.getElementById("pdfExportBtnHint"),
        backdrop: document.getElementById("pdfExportDialogBackdrop"),
        checkbox: document.getElementById("pdfExportIncludeMessages"),
        error: document.getElementById("pdfExportDialogError"),
        status: document.getElementById("pdfExportDialogStatus"),
        dialog: document.getElementById("pdfExportDialog"),
        cancel: document.getElementById("pdfExportCancelBtn"),
        confirm: document.getElementById("pdfExportConfirmBtn"),
    };
}

/**
 * Press a key on the document, the way the dialog listens for it.
 * @param {string} key - Key name
 * @param {boolean} [shiftKey] - Whether Shift is held
 * @returns {KeyboardEvent} The dispatched event
 */
function press(key, shiftKey = false) {
    const event = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    return event;
}

const DOCUMENT_MODEL = Object.freeze({
    rangeLabel: "Last 12 months",
    insights: [],
    tip: null,
    allTime: [],
    threads: [],
});

/**
 * Load a fresh export surface, stub its collaborators, mount it and init.
 * @param {() => void} [configure] - Applied after the defaults, before init
 * @returns {Promise<void>}
 */
async function setup(configure) {
    await loadModules();
    // The mocked modules are shared across resetModules(), so their call
    // history has to be cleared explicitly for each fresh surface.
    vi.clearAllMocks();

    docStub = { output: vi.fn(() => new Blob(["%PDF-1.3"], { type: "application/pdf" })) };
    jsPDF.mockReset();
    // jsPDF is called with `new`, so the stub has to be constructible: an
    // arrow function would throw "is not a constructor".
    jsPDF.mockImplementation(class {
        constructor() {
            return docStub;
        }
    });
    hasExportableData.mockResolvedValue(true);
    readPdfPalette.mockReturnValue({ "--bg-primary": { r: 255, g: 253, b: 247 } });
    registerPdfFonts.mockResolvedValue({ body: "PatrickHand", accent: "Caveat", embedded: true });
    collectExportData.mockResolvedValue({ ...DOCUMENT_MODEL, generatedAt: new Date(2026, 6, 31) });

    globalThis.URL.createObjectURL = vi.fn(() => "blob:pdf");
    globalThis.URL.revokeObjectURL = vi.fn();

    if (configure) {
        configure();
    }

    document.body.innerHTML = MARKUP;
    PdfExport.init();
    // init() resolves availability asynchronously.
    await vi.waitFor(() => expect(hasExportableData).toHaveBeenCalled());
    await Promise.resolve();
}

describe("PdfExport", () => {
    beforeEach(async () => {
        await setup();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        document.body.innerHTML = "";
    });

    it("does nothing when the export markup is absent", () => {
        document.body.innerHTML = "";
        expect(() => PdfExport.init()).not.toThrow();
    });

    it("subscribes once and ignores a repeat init", async () => {
        const subscriptions = DataCache.subscribe.mock.calls.length;
        PdfExport.init();

        expect(DataCache.subscribe.mock.calls).toHaveLength(subscriptions);
    });

    it("opens the dialog with the message checkbox unchecked", () => {
        ui().trigger.click();

        expect(ui().backdrop.hidden).toBe(false);
        expect(ui().checkbox.checked).toBe(false);
        expect(document.activeElement).toBe(ui().checkbox);
    });

    it("forgets a previous opt-in when reopened", () => {
        ui().trigger.click();
        ui().checkbox.checked = true;
        ui().cancel.click();
        ui().trigger.click();

        expect(ui().checkbox.checked).toBe(false);
    });

    it("ignores a second open while already open", () => {
        ui().trigger.click();
        ui().confirm.focus();
        ui().trigger.click();

        expect(document.activeElement).toBe(ui().confirm);
    });

    it("returns focus to the trigger on cancel", () => {
        ui().trigger.focus();
        ui().trigger.click();
        ui().cancel.click();

        expect(ui().backdrop.hidden).toBe(true);
        expect(document.activeElement).toBe(ui().trigger);
    });

    it("closes on Escape", () => {
        ui().trigger.click();
        const event = press("Escape");

        expect(event.defaultPrevented).toBe(true);
        expect(ui().backdrop.hidden).toBe(true);
    });

    it("ignores a close while the dialog is already shut", () => {
        ui().cancel.click();

        expect(ui().backdrop.hidden).toBe(true);
    });

    it("ignores keys while the dialog is closed", () => {
        expect(press("Escape").defaultPrevented).toBe(false);
    });

    it("ignores keys other than Escape and Tab", () => {
        ui().trigger.click();

        expect(press("a").defaultPrevented).toBe(false);
    });

    it("closes when the backdrop itself is clicked", () => {
        ui().trigger.click();
        ui().backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

        expect(ui().backdrop.hidden).toBe(true);
    });

    it("stays open when the dialog body is clicked", () => {
        ui().trigger.click();
        ui().confirm.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

        expect(ui().backdrop.hidden).toBe(false);
    });

    it("traps Tab inside the dialog", () => {
        ui().trigger.click();

        ui().confirm.focus();
        expect(press("Tab").defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(ui().checkbox);

        expect(press("Tab", true).defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(ui().confirm);
    });

    it("leaves Tab alone in the middle of the dialog", () => {
        ui().trigger.click();
        ui().cancel.focus();

        expect(press("Tab").defaultPrevented).toBe(false);
        expect(press("Tab", true).defaultPrevented).toBe(false);
    });

    it("disables the trigger with an accessible reason when there is no data", async () => {
        await setup(() => hasExportableData.mockResolvedValue(false));

        // aria-disabled, not the disabled property: the button has to stay in
        // the tab order for the reason on it to be reachable at all.
        expect(ui().trigger.disabled).toBe(false);
        expect(ui().trigger.getAttribute("aria-disabled")).toBe("true");
        expect(ui().trigger.getAttribute("aria-label")).toBe(
            "Save as PDF, unavailable until you upload a LinkedIn export",
        );
        expect(ui().trigger.title).toBe(
            "Save as PDF, unavailable until you upload a LinkedIn export",
        );
        expect(ui().trigger.getAttribute("aria-describedby")).toBe("pdfExportBtnHint");
        expect(ui().hint.textContent).toBe("Upload a LinkedIn export to enable saving as PDF.");

        // Clicking it anyway must not open the dialog over data that is not there.
        ui().trigger.click();
        expect(ui().backdrop.hidden).toBe(true);
    });

    it("keeps the trigger disabled while the availability check is pending", async () => {
        let settle = null;
        await setup(() =>
            hasExportableData.mockReturnValue(
                new Promise((resolve) => {
                    settle = resolve;
                }),
            ),
        );

        expect(ui().trigger.getAttribute("aria-disabled")).toBe("true");
        expect(ui().trigger.getAttribute("aria-label")).toBe(
            "Save as PDF, unavailable until you upload a LinkedIn export",
        );
        expect(ui().trigger.title).toBe(
            "Save as PDF, unavailable until you upload a LinkedIn export",
        );
        ui().trigger.click();
        expect(ui().backdrop.hidden).toBe(true);

        settle(true);
        await vi.waitFor(() => expect(ui().trigger.getAttribute("aria-disabled")).toBe("false"));
        expect(ui().trigger.getAttribute("aria-label")).toBe("Save your insights as a PDF");
        expect(ui().hint.textContent).toBe("");
    });

    it("enables the trigger when data exists", () => {
        expect(ui().trigger.getAttribute("aria-disabled")).toBe("false");
        expect(ui().trigger.getAttribute("aria-label")).toBe("Save your insights as a PDF");
    });

    it("ignores an availability check that finishes after a newer one", async () => {
        let settleFirst = null;
        await setup(() =>
            hasExportableData.mockReturnValue(
                new Promise((resolve) => {
                    settleFirst = resolve;
                }),
            ),
        );

        const [listener] = DataCache.subscribe.mock.calls[0];
        let settleSecond = null;
        hasExportableData.mockReturnValue(
            new Promise((resolve) => {
                settleSecond = resolve;
            }),
        );
        listener({ type: "filesChanged" });

        // The newer check answers first and enables the button.
        settleSecond(true);
        await vi.waitFor(() => expect(ui().trigger.getAttribute("aria-disabled")).toBe("false"));

        // The older read, against storage as it was before the upload, must not
        // now disable it again for the rest of the session.
        settleFirst(false);
        await Promise.resolve();
        await Promise.resolve();
        expect(ui().trigger.getAttribute("aria-disabled")).toBe("false");
        expect(ui().trigger.getAttribute("aria-label")).toBe("Save your insights as a PDF");
    });

    it("re-checks availability when the cache says the data changed", async () => {
        const [listener] = DataCache.subscribe.mock.calls[0];
        hasExportableData.mockClear();

        listener({ type: "chartHovered" });
        expect(hasExportableData).not.toHaveBeenCalled();

        listener({ type: "analyticsChanged" });
        await vi.waitFor(() => expect(hasExportableData).toHaveBeenCalledTimes(1));
    });

    it("keeps the trigger disabled when the availability check fails", async () => {
        await setup(() => hasExportableData.mockRejectedValue(new Error("storage gone")));

        expect(ui().trigger.getAttribute("aria-disabled")).toBe("true");
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "check-availability",
        });
    });

    it("builds and downloads the document in order", async () => {
        const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click");
        ui().trigger.focus();
        ui().trigger.click();
        ui().confirm.click();

        await vi.waitFor(() => expect(ui().backdrop.hidden).toBe(true));

        expect(LoadingOverlay.show).toHaveBeenCalledWith("pdf-export", expect.any(Object));
        expect(jsPDF).toHaveBeenCalledWith({ unit: "mm", format: "a4", compress: true });
        expect(readPdfPalette).toHaveBeenCalled();
        expect(registerPdfFonts).toHaveBeenCalledWith(docStub);
        expect(collectExportData).toHaveBeenCalledWith({
            includeMessages: false,
            generatedAt: expect.any(Date),
        });
        expect(renderPdfDocument).toHaveBeenCalledWith(docStub, expect.any(Object), {
            palette: { "--bg-primary": { r: 255, g: 253, b: 247 } },
            fonts: { body: "PatrickHand", accent: "Caveat", embedded: true },
        });
        expect(docStub.output).toHaveBeenCalledWith("blob");
        expect(anchorClick).toHaveBeenCalled();
        expect(URL.createObjectURL).toHaveBeenCalled();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:pdf");
        expect(LoadingOverlay.hide).toHaveBeenCalledWith("pdf-export");
        expect(document.activeElement).toBe(ui().trigger);
        anchorClick.mockRestore();
    });

    it("names the file after the generation date", async () => {
        vi.setSystemTime(new Date(2026, 6, 31, 12));
        let downloadName = null;
        const anchorClick = vi
            .spyOn(HTMLAnchorElement.prototype, "click")
            .mockImplementation(function capture() {
                downloadName = this.download;
            });

        ui().trigger.click();
        ui().confirm.click();
        await vi.waitFor(() => expect(downloadName).not.toBeNull());

        expect(downloadName).toBe("linkedin-insights-2026-07-31.pdf");
        anchorClick.mockRestore();
        vi.useRealTimers();
    });

    it("passes the opt-in through when the checkbox is ticked", async () => {
        vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
        ui().trigger.click();
        ui().checkbox.checked = true;
        ui().confirm.click();

        await vi.waitFor(() =>
            expect(collectExportData).toHaveBeenCalledWith({
                includeMessages: true,
                generatedAt: expect.any(Date),
            }),
        );
        vi.restoreAllMocks();
    });

    it("surfaces a failure in the dialog and hides the overlay", async () => {
        collectExportData.mockRejectedValue(new Error("worker gone"));
        ui().trigger.click();
        ui().confirm.click();

        await vi.waitFor(() => expect(ui().error.hidden).toBe(false));

        expect(ui().error.textContent).toBe(
            "Something went wrong while building the PDF. Please try again.",
        );
        expect(ui().backdrop.hidden).toBe(false);
        expect(ui().confirm.disabled).toBe(false);
        expect(ui().confirm.textContent).toBe("Generate PDF");
        expect(LoadingOverlay.hide).toHaveBeenCalledWith("pdf-export");
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "generate",
        });
    });

    it("never reports the exception the export path caught", async () => {
        const thrown = piiError("render");
        collectExportData.mockRejectedValue(thrown);
        ui().trigger.click();
        ui().confirm.click();

        await vi.waitFor(() => expect(ui().error.hidden).toBe(false));

        const [reported, context] = captureError.mock.calls[0];
        expectFixedError(reported, thrown);
        expect(context).toEqual({ module: "pdf-export", operation: "generate" });
    });

    it("never reports the exception an availability check caught", async () => {
        const thrown = piiError("availability");
        await setup(() => hasExportableData.mockRejectedValue(thrown));

        const [reported, context] = captureError.mock.calls[0];
        expectFixedError(reported, thrown);
        expect(context).toEqual({ module: "pdf-export", operation: "check-availability" });
    });

    it("clears a previous failure on the next attempt", async () => {
        collectExportData.mockRejectedValueOnce(new Error("worker gone"));
        ui().trigger.click();
        ui().confirm.click();
        await vi.waitFor(() => expect(ui().error.hidden).toBe(false));

        vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
        ui().confirm.click();
        await vi.waitFor(() => expect(ui().backdrop.hidden).toBe(true));

        expect(ui().error.hidden).toBe(true);
        vi.restoreAllMocks();
    });

    it("refuses a second generate while one is running", async () => {
        let release = null;
        collectExportData.mockReturnValue(
            new Promise((resolve) => {
                release = resolve;
            }),
        );
        vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

        ui().trigger.click();
        ui().confirm.click();
        await vi.waitFor(() => expect(collectExportData).toHaveBeenCalledTimes(1));

        expect(ui().confirm.textContent).toBe("Generating…");
        expect(ui().confirm.disabled).toBe(true);
        expect(ui().checkbox.disabled).toBe(true);

        // The button is disabled, so this stands in for any programmatic
        // re-entry: generate() has to refuse it on its own.
        ui().confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(jsPDF).toHaveBeenCalledTimes(1);
        expect(collectExportData).toHaveBeenCalledTimes(1);

        release({ ...DOCUMENT_MODEL, generatedAt: new Date(2026, 6, 31) });
        await vi.waitFor(() => expect(ui().backdrop.hidden).toBe(true));
        vi.restoreAllMocks();
    });

    it("keeps Tab inside the dialog while an export is running", async () => {
        let release = null;
        collectExportData.mockReturnValue(
            new Promise((resolve) => {
                release = resolve;
            }),
        );
        vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

        ui().trigger.click();
        ui().confirm.click();
        await vi.waitFor(() => expect(collectExportData).toHaveBeenCalledTimes(1));

        // Cancel is the only control left enabled, so it is both the first and
        // the last stop in the trap, and it holds focus.
        expect(ui().cancel.disabled).toBe(false);
        expect(document.activeElement).toBe(ui().cancel);
        expect(ui().dialog.getAttribute("aria-busy")).toBe("true");
        expect(ui().status.hidden).toBe(false);
        expect(ui().status.textContent).toContain("Generating");

        expect(press("Tab").defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(ui().cancel);
        expect(press("Tab", true).defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(ui().cancel);

        release({ ...DOCUMENT_MODEL, generatedAt: new Date(2026, 6, 31) });
        await vi.waitFor(() => expect(ui().backdrop.hidden).toBe(true));
        expect(ui().dialog.getAttribute("aria-busy")).toBe("false");
        expect(ui().status.hidden).toBe(true);
        vi.restoreAllMocks();
    });

    it("cancels a running export from the Cancel button", async () => {
        collectExportData.mockReturnValue(new Promise(() => {}));

        ui().trigger.click();
        ui().confirm.click();
        await vi.waitFor(() => expect(collectExportData).toHaveBeenCalledTimes(1));

        ui().cancel.click();

        expect(ui().backdrop.hidden).toBe(true);
        expect(terminateThreadsWorker).toHaveBeenCalled();
        expect(terminateAnalyticsWorker).toHaveBeenCalled();
        expect(ui().dialog.getAttribute("aria-busy")).toBe("false");
    });

    it("closes on Escape during generation and cancels the export", async () => {
        let release = null;
        collectExportData.mockReturnValue(
            new Promise((resolve) => {
                release = resolve;
            }),
        );
        const anchorClick = vi
            .spyOn(HTMLAnchorElement.prototype, "click")
            .mockImplementation(() => {});
        const rejections = [];
        const onRejection = (event) => rejections.push(event);
        window.addEventListener("unhandledrejection", onRejection);

        ui().trigger.focus();
        ui().trigger.click();
        ui().confirm.click();
        await vi.waitFor(() => expect(collectExportData).toHaveBeenCalledTimes(1));

        // The dialog's every control is disabled while generating, so refusing
        // to close would trap a keyboard user inside it.
        expect(press("Escape").defaultPrevented).toBe(true);
        expect(ui().backdrop.hidden).toBe(true);
        expect(document.activeElement).toBe(ui().trigger);
        expect(LoadingOverlay.hide).toHaveBeenCalledWith("pdf-export");
        expect(terminateThreadsWorker).toHaveBeenCalled();
        expect(ui().confirm.disabled).toBe(false);
        expect(ui().confirm.textContent).toBe("Generate PDF");

        // The export that was already running must not download anything or
        // reopen what the user closed.
        release({ ...DOCUMENT_MODEL, generatedAt: new Date(2026, 6, 31) });
        await Promise.resolve();
        await Promise.resolve();

        expect(renderPdfDocument).not.toHaveBeenCalled();
        expect(anchorClick).not.toHaveBeenCalled();
        expect(ui().backdrop.hidden).toBe(true);
        expect(rejections).toEqual([]);
        window.removeEventListener("unhandledrejection", onRejection);
        vi.restoreAllMocks();
    });

    it("stops an export cancelled before jsPDF has even loaded", async () => {
        ui().trigger.click();
        // generate() runs synchronously up to its first await, so this Escape
        // lands before the dynamic import resolves.
        ui().confirm.click();
        press("Escape");
        await vi.waitFor(() => expect(ui().backdrop.hidden).toBe(true));
        await Promise.resolve();
        await Promise.resolve();

        expect(collectExportData).not.toHaveBeenCalled();
        expect(renderPdfDocument).not.toHaveBeenCalled();
    });

    it("stops an export cancelled while the fonts are still loading", async () => {
        let settleFonts = null;
        registerPdfFonts.mockReturnValue(
            new Promise((resolve) => {
                settleFonts = resolve;
            }),
        );

        ui().trigger.click();
        ui().confirm.click();
        await vi.waitFor(() => expect(registerPdfFonts).toHaveBeenCalled());

        press("Escape");
        settleFonts({ body: "helvetica", accent: "helvetica", embedded: false });
        await Promise.resolve();
        await Promise.resolve();

        expect(collectExportData).not.toHaveBeenCalled();
        expect(renderPdfDocument).not.toHaveBeenCalled();
    });

    it("keeps a cancelled failure out of the dialog and out of telemetry", async () => {
        let fail = null;
        collectExportData.mockReturnValue(
            new Promise((resolve, reject) => {
                fail = reject;
            }),
        );

        ui().trigger.click();
        ui().confirm.click();
        await vi.waitFor(() => expect(collectExportData).toHaveBeenCalledTimes(1));

        press("Escape");
        fail(new Error("worker gone"));
        await Promise.resolve();
        await Promise.resolve();

        expect(ui().error.hidden).toBe(true);
        expect(ui().backdrop.hidden).toBe(true);
        expect(captureError).not.toHaveBeenCalled();
    });

    it("lets a new export run after a cancelled one", async () => {
        let release = null;
        collectExportData.mockReturnValueOnce(
            new Promise((resolve) => {
                release = resolve;
            }),
        );
        vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

        ui().trigger.click();
        ui().confirm.click();
        await vi.waitFor(() => expect(collectExportData).toHaveBeenCalledTimes(1));
        press("Escape");

        ui().trigger.click();
        ui().confirm.click();
        await vi.waitFor(() => expect(ui().backdrop.hidden).toBe(true));

        expect(renderPdfDocument).toHaveBeenCalledTimes(1);

        // The abandoned run resolving afterwards changes nothing.
        release({ ...DOCUMENT_MODEL, generatedAt: new Date(2026, 6, 31) });
        await Promise.resolve();
        expect(renderPdfDocument).toHaveBeenCalledTimes(1);
        vi.restoreAllMocks();
    });

    it("revokes the object URL even when the download click throws", async () => {
        const anchorClick = vi
            .spyOn(HTMLAnchorElement.prototype, "click")
            .mockImplementation(() => {
                throw new Error("download blocked");
            });

        ui().trigger.click();
        ui().confirm.click();
        await vi.waitFor(() => expect(ui().error.hidden).toBe(false));

        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:pdf");
        expect(document.querySelector("a[download]")).toBeNull();
        anchorClick.mockRestore();
    });
});
