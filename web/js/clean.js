/* Clean page logic */

(function() {
    'use strict';

    const PREVIEW_ROW_LIMIT = 5;
    const PREVIEW_CELL_LIMIT = 50;

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
        comments: null
    };

    const storedFiles = {
        shares: null,
        comments: null
    };

    /**
     * Initialize the clean page: load files, bind events, update view.
     */
    async function init() {
        await loadFiles();
        bindEvents();
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
        const files = await Storage.getAllFiles();
        storedFiles.shares = files.find(file => file.type === 'shares') || null;
        storedFiles.comments = files.find(file => file.type === 'comments') || null;
    }

    /**
     * Update the clean page UI based on available files.
     */
    function updateView() {
        const hasShares = Boolean(storedFiles.shares);
        const hasComments = Boolean(storedFiles.comments);

        elements.cleanEmpty.hidden = hasShares || hasComments;
        elements.cleanPanel.hidden = !(hasShares || hasComments);

        elements.cleanFileTypeInputs.forEach(input => {
            if (input.value === 'shares') input.disabled = !hasShares;
            if (input.value === 'comments') input.disabled = !hasComments;
        });

        if (hasShares && hasComments) {
            elements.cleanerHint.textContent = 'Both files loaded. Choose which one to clean.';
        } else if (hasShares || hasComments) {
            elements.cleanerHint.textContent = 'Only one file is loaded. Upload the other for full features.';
        } else {
            elements.cleanerHint.textContent = 'Upload Shares.csv or Comments.csv to start cleaning.';
        }

        renderPreview();
    }

    /**
     * Get the currently selected file type from radio buttons.
     * @returns {'shares'|'comments'} The selected file type.
     */
    function getSelectedType() {
        const selected = document.querySelector('input[name="cleanFileType"]:checked');
        return selected ? selected.value : 'shares';
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

        if (!cache[type]) {
            const processed = LinkedInCleaner.process(file.text, type);
            if (!processed.success) {
                showError(processed.error || 'Unable to parse file.');
                hidePreview();
                hideDownload();
                return;
            }
            cache[type] = processed;
        }

        showPreview(cache[type], type);
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
        elements.cleanFileInfo.textContent = `${fileType.charAt(0).toUpperCase() + fileType.slice(1)} - ${result.rowCount} rows`;

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
        const result = cache[type];
        if (!result) {
            showError('No data to download.');
            return;
        }
        const downloadResult = ExcelGenerator.generateAndDownload(result.cleanedData, type);
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

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
