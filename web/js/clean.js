/* Clean page logic */
/* exported CleanPage */

const CleanPage = (() => {
    'use strict';

    const PREVIEW_ROW_LIMIT = 5;
    const PREVIEW_CELL_LIMIT = 50;
    const FILE_TYPE_ORDER = Object.freeze(['shares', 'comments', 'messages', 'connections']);
    const FILE_TYPE_LABELS = Object.freeze({
        shares: 'Shares',
        comments: 'Comments',
        messages: 'Messages',
        connections: 'Connections'
    });
    const CLEAN_HINT_BY_CATEGORY = Object.freeze({
        all: () => 'All files loaded. Choose one to clean and export.',
        many: loadedCount => `${loadedCount} files loaded. Choose one to clean.`,
        single: () => 'Only one file is loaded. Upload more files for full features.',
        none: () => 'Upload LinkedIn CSV files to start cleaning.'
    });

    const elements = {
        cleanEmpty: document.getElementById('cleanEmpty'),
        cleanPanel: document.getElementById('cleanPanel'),
        cleanerHint: document.getElementById('cleanerHint'),
        cleanPreviewSection: document.getElementById('cleanPreviewSection'),
        cleanPreviewTable: document.getElementById('cleanPreviewTable'),
        cleanFileInfo: document.getElementById('cleanFileInfo'),
        cleanPreviewNote: document.getElementById('cleanPreviewNote'),
        cleanDownloadSection: document.getElementById('cleanDownloadSection'),
        cleanDownloadBtn: document.getElementById('cleanDownloadBtn'),
        cleanErrorMessage: document.getElementById('cleanErrorMessage'),
        cleanErrorText: document.getElementById('cleanErrorText'),
        cleanFileTypeInputs: document.querySelectorAll('input[name="cleanFileType"]')
    };

    const cache = {
        shares: null,
        comments: null,
        messages: null,
        connections: null
    };

    const storedFiles = {
        shares: null,
        comments: null,
        messages: null,
        connections: null
    };

    let initialized = false;

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
        await loadFiles();
        updateView();
    }

    /**
     * Attach event listeners for file type radio buttons and download.
     */
    function bindEvents() {
        elements.cleanFileTypeInputs.forEach(input => {
            input.addEventListener('change', renderPreview);
        });
        elements.cleanDownloadBtn.addEventListener('click', handleDownload);
    }

    /**
     * Load stored files from IndexedDB into local state.
     */
    async function loadFiles() {
        if (typeof Session !== 'undefined' && typeof Session.waitForCleanup === 'function') {
            await Session.waitForCleanup();
        }

        let files = null;
        if (typeof DataCache !== 'undefined') {
            files = DataCache.get('storage:files') || null;
        }
        if (!files) {
            files = await Storage.getAllFiles();
            if (typeof DataCache !== 'undefined') {
                DataCache.set('storage:files', files);
            }
        }

        FILE_TYPE_ORDER.forEach(type => {
            storedFiles[type] = files.find(file => file.type === type) || null;
        });
    }

    /**
     * Resolve cleaner hint text based on number of uploaded file types.
     * @param {number} loadedCount - Number of loaded file types
     * @returns {string}
     */
    function getCleanerHint(loadedCount) {
        const category = loadedCount === FILE_TYPE_ORDER.length
            ? 'all'
            : (loadedCount > 1 ? 'many' : (loadedCount === 1 ? 'single' : 'none'));
        return CLEAN_HINT_BY_CATEGORY[category](loadedCount);
    }

    /**
     * Update the clean page UI based on available files.
     */
    function updateView() {
        const loadedTypes = FILE_TYPE_ORDER.filter(type => Boolean(storedFiles[type]));
        const loadedCount = loadedTypes.length;
        const hasFiles = loadedCount > 0;

        elements.cleanEmpty.hidden = hasFiles;
        elements.cleanPanel.hidden = !hasFiles;

        elements.cleanFileTypeInputs.forEach(input => {
            input.disabled = !storedFiles[input.value];
        });

        const selectedType = getSelectedType();
        if (!storedFiles[selectedType] && loadedCount > 0) {
            const fallbackType = loadedTypes[0];
            const fallbackInput = document.querySelector(
                `input[name="cleanFileType"][value="${fallbackType}"]`
            );
            if (fallbackInput) {
                fallbackInput.checked = true;
            }
        }

        elements.cleanerHint.textContent = getCleanerHint(loadedCount);

        renderPreview();
    }

    /**
     * Get the currently selected file type from radio buttons.
     * @returns {string} The selected file type.
     */
    function getSelectedType() {
        const selected = document.querySelector('input[name="cleanFileType"]:checked');
        if (selected && storedFiles[selected.value]) {
            return selected.value;
        }
        const fallback = FILE_TYPE_ORDER.find(type => Boolean(storedFiles[type]));
        return fallback || 'shares';
    }

    /**
     * Process the selected file and render the preview table.
     */
    function renderPreview() {
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
            const processed = LinkedInCleaner.process(file.text, type);
            if (!processed.success) {
                showError(processed.error || 'Unable to parse file.');
                hidePreview();
                hideDownload();
                return;
            }
            cache[type] = {
                updatedAt: fileUpdatedAt,
                result: processed
            };
        }

        showPreview(cache[type].result, type);
        showDownload();
    }

    /**
     * Populate the preview table with cleaned data.
     * @param {Object} result - The processed result from LinkedInCleaner.
     * @param {string} fileType - The file type ('shares' or 'comments').
     */
    function showPreview(result, fileType) {
        const config = LinkedInCleaner.configs[fileType];
        if (!config) return;
        const headers = config.columns.map(column => column.name);
        const label = FILE_TYPE_LABELS[fileType] || fileType;
        elements.cleanFileInfo.textContent = `${label} - ${result.rowCount} rows`;

        const thead = elements.cleanPreviewTable.querySelector('thead');
        thead.innerHTML = `<tr>${headers.map(header => `<th>${escapeHtml(header)}</th>`).join('')}</tr>`;

        const tbody = elements.cleanPreviewTable.querySelector('tbody');
        const previewRows = result.cleanedData.slice(0, PREVIEW_ROW_LIMIT);
        tbody.innerHTML = previewRows.map(row =>
            `<tr>${headers.map(header => {
                const value = row[header] || '';
                return `<td title="${escapeHtml(value)}">${escapeHtml(truncate(value, PREVIEW_CELL_LIMIT))}</td>`;
            }).join('')}</tr>`
        ).join('');

        elements.cleanPreviewNote.textContent = result.rowCount > PREVIEW_ROW_LIMIT
            ? `Showing first ${PREVIEW_ROW_LIMIT} of ${result.rowCount} rows`
            : `Showing all ${result.rowCount} rows`;

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
     * Generate and trigger download of the cleaned Excel file.
     */
    function handleDownload() {
        const type = getSelectedType();
        const cached = cache[type];
        if (!cached || !cached.result) {
            showError('No data to download.');
            return;
        }
        const downloadResult = ExcelGenerator.generateAndDownload(cached.result.cleanedData, type);
        if (!downloadResult.success) {
            showError(`Error generating Excel: ${downloadResult.error}`);
        }
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
     * Escape a string for safe HTML insertion.
     * @param {string} value - The string to escape.
     * @returns {string} The HTML-escaped string.
     */
    function escapeHtml(value) {
        const div = document.createElement('div');
        div.textContent = value;
        return div.innerHTML;
    }

    /**
     * Truncate a string to maxLength, appending '...' if needed.
     * @param {string} value - The string to truncate.
     * @param {number} maxLength - The maximum allowed length.
     * @returns {string} The truncated string.
     */
    function truncate(value, maxLength) {
        if (!value) return '';
        if (value.length <= maxLength) return value;
        return value.slice(0, maxLength) + '...';
    }

    return {
        init,
        onRouteChange
    };
})();
