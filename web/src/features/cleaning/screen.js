/* Clean page logic */

import { toStoredFileMetadata } from "../../app/worker-contracts.js";
import { captureError } from "../../platform/observability/sentry.js";
import { DataCache } from "../../platform/persistence/data-cache.js";
import { Session } from "../../platform/persistence/session.js";
import { Storage } from "../../platform/persistence/storage.js";
import { FILE_TYPE_LABELS, FILE_TYPES } from "../../shared/constants.js";
import { EXCEL_EXPORT_MAX_BYTES } from "../../shared/limits.js";
import { celebrateDownload } from "../../shared/ui/mascot.js";

import { requestClean } from "./clean-client.js";
import { PREVIEW_ROW_LIMIT } from "./clean-job.js";
import { LinkedInCleaner } from "./cleaner.js";
import { cleanedCsvName } from "./csv-export.js";
import { ExcelGenerator } from "./excel.js";

export const CleanPage = (() => {
    "use strict";

    const PREVIEW_CELL_LIMIT = 50;
    const CLEAN_HINT_BY_CATEGORY = Object.freeze({
        all: () => "All files loaded. Choose one to clean and export.",
        many: (loadedCount) => `${loadedCount} files loaded. Choose one to clean.`,
        single: () => "Only one file is loaded. Upload more files for full features.",
        none: () => "Upload LinkedIn CSV files to start cleaning.",
    });

    // These nodes are part of the static page shell rendered in index.html, so
    // each lookup is annotated as a non-null element; a missing node is a build
    // error rather than a runtime state worth guarding on every read.
    const elements = {
        cleanEmpty: /** @type {HTMLElement} */ (document.getElementById("cleanEmpty")),
        cleanPanel: /** @type {HTMLElement} */ (document.getElementById("cleanPanel")),
        cleanerHint: /** @type {HTMLElement} */ (document.getElementById("cleanerHint")),
        cleanPreviewSection: /** @type {HTMLElement} */ (
            document.getElementById("cleanPreviewSection")
        ),
        cleanPreviewTable: /** @type {HTMLElement} */ (
            document.getElementById("cleanPreviewTable")
        ),
        cleanFileInfo: /** @type {HTMLElement} */ (document.getElementById("cleanFileInfo")),
        cleanPreviewNote: /** @type {HTMLElement} */ (
            document.getElementById("cleanPreviewNote")
        ),
        cleanDownloadSection: /** @type {HTMLElement} */ (
            document.getElementById("cleanDownloadSection")
        ),
        cleanDownloadBtn: /** @type {HTMLElement} */ (
            document.getElementById("cleanDownloadBtn")
        ),
        cleanCsvBtn: /** @type {HTMLElement} */ (document.getElementById("cleanCsvBtn")),
        cleanErrorMessage: /** @type {HTMLElement} */ (
            document.getElementById("cleanErrorMessage")
        ),
        cleanErrorText: /** @type {HTMLElement} */ (document.getElementById("cleanErrorText")),
        cleanFileTypeInputs: document.querySelectorAll('input[name="cleanFileType"]'),
    };

    const cache = {
        shares: null,
        comments: null,
        messages: null,
        connections: null,
    };

    const storedFiles = {
        shares: null,
        comments: null,
        messages: null,
        connections: null,
    };

    let initialized = false;
    // Counts preview requests, so a reply for a selection the user has moved
    // past is dropped rather than drawn.
    let previewRequest = 0;

    function formatRows(count) {
        return `${count} ${count === 1 ? "row" : "rows"}`;
    }

    /**
     * Initialize the clean page: load files, bind events, update view.
     */
    async function init() {
        if (initialized) {
            return;
        }
        initialized = true;
        bindEvents();
        await refresh();
    }

    /** Refresh file list and UI when route becomes active. */
    async function onRouteChange() {
        if (!initialized) {
            await init();
            return;
        }
        await refresh();
    }

    /** Reload files from storage and redraw the panel. */
    async function refresh() {
        try {
            await loadFiles();
            updateView();
        } catch (error) {
            captureError(error, {
                module: "clean",
                operation: "refresh",
            });
            showError("Unable to load saved files. Re-upload your CSV files and try again.");
            hidePreview();
            hideDownload();
        }
    }

    /**
     * Attach event listeners for file type radio buttons and download.
     */
    function bindEvents() {
        elements.cleanFileTypeInputs.forEach((input) => {
            input.addEventListener("change", renderPreview);
        });
        elements.cleanDownloadBtn.addEventListener("click", () => {
            handleDownload();
        });
        elements.cleanCsvBtn.addEventListener("click", () => {
            handleCsvDownload();
        });
    }

    /**
     * Load stored files from IndexedDB into local state.
     */
    async function loadFiles() {
        await Session.waitForCleanup();

        let files = DataCache.get("storage:files") || null;
        if (!files) {
            // Cache metadata only; the selected file's text is loaded on demand in
            // renderPreview so large exports aren't kept in memory.
            files = (await Storage.getAllFiles()).map(toStoredFileMetadata);
            DataCache.set("storage:files", files);
        }

        FILE_TYPES.forEach((type) => {
            storedFiles[type] = files.find((file) => file.type === type) || null;
        });
    }

    /**
     * Resolve cleaner hint text based on number of uploaded file types.
     * @param {number} loadedCount - Number of loaded file types
     * @returns {string}
     */
    function getCleanerHint(loadedCount) {
        if (loadedCount === FILE_TYPES.length) {
            return CLEAN_HINT_BY_CATEGORY.all();
        }
        if (loadedCount > 1) {
            return CLEAN_HINT_BY_CATEGORY.many(loadedCount);
        }
        if (loadedCount === 1) {
            return CLEAN_HINT_BY_CATEGORY.single();
        }
        return CLEAN_HINT_BY_CATEGORY.none();
    }

    /**
     * Update the clean page UI based on available files.
     */
    function updateView() {
        const loadedTypes = FILE_TYPES.filter((type) => Boolean(storedFiles[type]));
        const loadedCount = loadedTypes.length;
        const hasFiles = loadedCount > 0;

        elements.cleanEmpty.hidden = hasFiles;
        elements.cleanPanel.hidden = !hasFiles;

        elements.cleanFileTypeInputs.forEach((input) => {
            const el = /** @type {HTMLInputElement} */ (input);
            el.disabled = !storedFiles[el.value];
        });

        const selectedInput = /** @type {HTMLInputElement|null} */ (
            document.querySelector('input[name="cleanFileType"]:checked')
        );
        const selectedType = selectedInput ? selectedInput.value : null;
        if (!selectedType || storedFiles[selectedType] || loadedCount === 0) {
            elements.cleanerHint.textContent = getCleanerHint(loadedCount);
            renderPreview();
            return;
        }

        const fallbackType = loadedTypes[0];
        const fallbackInput = document.querySelector(
            `input[name="cleanFileType"][value="${fallbackType}"]`,
        );
        // loadedTypes comes from FILE_TYPES. Keep the guard for incomplete DOM setup.
        /* v8 ignore next */
        if (fallbackInput) {
            /** @type {HTMLInputElement} */ (fallbackInput).checked = true;
        }

        elements.cleanerHint.textContent = getCleanerHint(loadedCount);

        renderPreview();
    }

    /**
     * Get the currently selected file type from radio buttons.
     * @returns {string} The selected file type.
     */
    function getSelectedType() {
        const selected = /** @type {HTMLInputElement|null} */ (
            document.querySelector('input[name="cleanFileType"]:checked')
        );
        if (selected && storedFiles[selected.value]) {
            return selected.value;
        }
        const fallback = FILE_TYPES.find((type) => Boolean(storedFiles[type]));
        return fallback || "shares";
    }

    /**
     * Report a file parse error and reset the preview UI.
     * @param {unknown} error - The error to report
     * @param {string} message - User-facing error message
     * @param {string} fileType - The file type being parsed
     * @param {string|null} fileName - The file name, if available
     */
    function handleParseError(error, message, fileType, fileName) {
        captureError(error, {
            module: "clean",
            operation: "parse-file",
            fileType,
            fileName,
        });
        showError(message);
        hidePreview();
        hideDownload();
    }

    /**
     * Process the selected file and render the preview table.
     * @returns {Promise<void>}
     */
    async function renderPreview() {
        const type = getSelectedType();
        const file = storedFiles[type];
        if (!file) {
            showError(`No ${type} file uploaded yet.`);
            hidePreview();
            hideDownload();
            return;
        }

        hideError();

        const cached = cache[type];
        const fileUpdatedAt = file.updatedAt || 0;

        if (!cached || cached.updatedAt !== fileUpdatedAt) {
            const token = ++previewRequest;
            let stored;
            try {
                // The cached record is metadata only; load the stored upload on
                // demand. The worker reads and cleans it off the main thread.
                stored = await Storage.getFile(type);
                if (!stored || !stored.blob) {
                    // Metadata says the file exists but its contents are gone
                    // (cleared in another tab or degraded persistence); report a
                    // load failure rather than parsing an empty payload into a
                    // misleading parse error.
                    throw new Error("Stored file record is missing.");
                }
            } catch (error) {
                handleParseError(error, "Unable to load file.", type, file.name || null);
                return;
            }
            if (token !== previewRequest || getSelectedType() !== type) {
                return;
            }
            const reply = await requestClean({
                fileType: type,
                output: "preview",
                source: stored.blob,
                key: fileKey(type, fileUpdatedAt),
            });
            // The selection may have changed while the clean was in flight;
            // abandon this stale render so the newer one wins.
            if (token !== previewRequest || getSelectedType() !== type) {
                return;
            }
            if (!reply.success) {
                /* v8 ignore next */
                const message = reply.error || "Unable to parse file.";
                handleParseError(new Error(message), message, type, file.name || null);
                return;
            }
            cache[type] = {
                updatedAt: fileUpdatedAt,
                sourceSize: stored.blob.size,
                rowCount: reply.rowCount,
                previewRows: reply.previewRows,
            };
        }

        showPreview(cache[type], type);
        showDownload();
    }

    /**
     * Name a stored upload, so the worker can tell whether the rows it holds
     * came from it.
     * @param {string} type - File type
     * @param {number} updatedAt - Upload timestamp
     * @returns {string}
     */
    function fileKey(type, updatedAt) {
        return `${type}:${updatedAt}`;
    }

    /**
     * Populate the preview table with the worker's preview rows.
     * @param {{rowCount: number, previewRows: string[][]}} result - Preview from the worker
     * @param {string} fileType - Selected cleaner file type.
     */
    function showPreview(result, fileType) {
        const config = LinkedInCleaner.configs[fileType];
        /* v8 ignore next */
        if (!config) {
            return;
        }
        const headers = config.columns.map((column) => column.name);
        /* v8 ignore next */
        const label = FILE_TYPE_LABELS[fileType] || fileType;
        elements.cleanFileInfo.textContent = `${label} - ${formatRows(result.rowCount)}`;

        const thead = /** @type {HTMLElement} */ (
            elements.cleanPreviewTable.querySelector("thead")
        );
        const headerRow = document.createElement("tr");
        headers.forEach((header) => {
            const cell = document.createElement("th");
            cell.textContent = header;
            headerRow.append(cell);
        });
        thead.replaceChildren(headerRow);

        const tbody = /** @type {HTMLElement} */ (
            elements.cleanPreviewTable.querySelector("tbody")
        );
        const bodyFragment = document.createDocumentFragment();
        result.previewRows.forEach((row) => {
            const previewRow = document.createElement("tr");
            headers.forEach((_, index) => {
                /* v8 ignore next */
                const value = row[index] || "";
                const cell = document.createElement("td");
                cell.title = value;
                cell.textContent = truncate(value, PREVIEW_CELL_LIMIT);
                previewRow.append(cell);
            });
            bodyFragment.append(previewRow);
        });
        tbody.replaceChildren(bodyFragment);

        elements.cleanPreviewNote.textContent =
            result.rowCount > PREVIEW_ROW_LIMIT
                ? `Showing first ${PREVIEW_ROW_LIMIT} of ${formatRows(result.rowCount)}`
                : `Showing all ${formatRows(result.rowCount)}`;

        elements.cleanPreviewSection.hidden = false;
    }

    /**
     * Hide the preview section.
     */
    function hidePreview() {
        elements.cleanPreviewSection.hidden = true;
    }

    /**
     * Show the download section.
     */
    function showDownload() {
        elements.cleanDownloadSection.hidden = false;
    }

    /**
     * Hide the download section.
     */
    function hideDownload() {
        elements.cleanDownloadSection.hidden = true;
    }

    /**
     * Return the previewed file for the selected type, or report that there is
     * nothing to download.
     * @returns {{type: string, cached: object}|null}
     */
    function getDownloadable() {
        const type = getSelectedType();
        const cached = cache[type];
        if (!cached) {
            showError("No data to download.");
            captureError(new Error("No data to download from clean page."), {
                module: "clean",
                operation: "download-without-cache",
                fileType: type,
            });
            return null;
        }
        return { type, cached };
    }

    /**
     * Build one download in the worker from the stored upload.
     * @param {string} type - File type
     * @param {object} cached - Previewed file
     * @param {"xlsx"|"csv"} output - What to build
     * @returns {Promise<{success: boolean, error: string|null, blob: Blob|null}>}
     */
    async function buildDownload(type, cached, output) {
        let stored;
        try {
            stored = await Storage.getFile(type);
        } catch {
            stored = null;
        }
        if (!stored || !stored.blob) {
            return { success: false, error: "Stored file record is missing.", blob: null };
        }
        return requestClean({
            fileType: type,
            output,
            source: stored.blob,
            key: fileKey(type, cached.updatedAt),
        });
    }

    /**
     * Generate and trigger download of the cleaned Excel file. Files over the
     * Excel limit are refused with a pointer to the CSV download.
     */
    async function handleDownload() {
        const downloadable = getDownloadable();
        if (!downloadable) {
            return;
        }
        const { type, cached } = downloadable;
        if (cached.sourceSize > EXCEL_EXPORT_MAX_BYTES) {
            const limitMb = Math.round(EXCEL_EXPORT_MAX_BYTES / (1024 * 1024));
            showError(
                `This file is over ${limitMb} MB, too large to build an Excel file in the browser. ` +
                    "Download it as CSV instead; Excel opens CSV files too.",
            );
            return;
        }
        hideError();
        const reply = await buildDownload(type, cached, "xlsx");
        if (!reply.success || !reply.blob) {
            captureError(new Error("Excel generation failed."), {
                module: "clean",
                operation: "excel-generate",
                fileType: type,
            });
            showError(`Error generating Excel: ${reply.error || "Try again."}`);
            return;
        }
        ExcelGenerator.download(reply.blob, LinkedInCleaner.configs[type].outputName);
        celebrateDownload();
    }

    /**
     * Download the cleaned rows as CSV, built in parts so large files fit.
     */
    async function handleCsvDownload() {
        const downloadable = getDownloadable();
        if (!downloadable) {
            return;
        }
        const { type, cached } = downloadable;
        const reply = await buildDownload(type, cached, "csv");
        if (!reply.success || !reply.blob) {
            captureError(new Error("CSV generation failed."), {
                module: "clean",
                operation: "csv-generate",
                fileType: type,
            });
            showError("Error generating CSV. Try again.");
            return;
        }
        ExcelGenerator.download(reply.blob, cleanedCsvName(type));
        hideError();
        celebrateDownload();
    }

    /**
     * Show an error message in the error banner.
     * @param {string} message - The error message to display.
     */
    function showError(message) {
        elements.cleanErrorText.textContent = message;
        elements.cleanErrorMessage.hidden = false;
    }

    /**
     * Hide the error banner.
     */
    function hideError() {
        elements.cleanErrorMessage.hidden = true;
    }

    /**
     * Truncate a string to maxLength, appending '...' if needed.
     * @param {string} value - The string to truncate.
     * @param {number} maxLength - The maximum allowed length.
     * @returns {string} The truncated string.
     */
    function truncate(value, maxLength) {
        /* v8 ignore next */
        if (!value) {
            return "";
        }
        if (value.length <= maxLength) {
            return value;
        }
        return `${value.slice(0, maxLength)}...`;
    }

    return {
        init,
        onRouteChange,
    };
})();
