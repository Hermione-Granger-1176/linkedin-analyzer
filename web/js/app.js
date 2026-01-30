/**
 * LinkedIn Analyzer - Main Application
 * Handles UI interactions, file upload, theme toggle, and orchestrates cleaning/export
 */

(function() {
    'use strict';

    const PREVIEW_ROW_LIMIT = 5;
    const PREVIEW_CELL_LIMIT = 50;
    const FILE_TYPE_LABELS = Object.freeze({
        shares: 'Shares',
        comments: 'Comments'
    });

    const state = {
        currentFile: null,
        processedResult: null,
        theme: 'light'
    };

    let elements = null;

    function init() {
        elements = getElements();
        if (!elementsReady(elements)) {
            return;
        }

        initTheme();
        bindEvents();
        initRoughDecorations();
    }

    function getElements() {
        return {
            themeToggle: document.getElementById('themeToggle'),
            dropZone: document.getElementById('dropZone'),
            fileInput: document.getElementById('fileInput'),
            dropZoneSuccess: document.querySelector('.drop-zone-success'),
            fileNameDisplay: document.querySelector('.file-name-display'),
            previewSection: document.getElementById('previewSection'),
            previewTable: document.getElementById('previewTable'),
            fileInfo: document.getElementById('fileInfo'),
            previewNote: document.getElementById('previewNote'),
            downloadSection: document.getElementById('downloadSection'),
            downloadBtn: document.getElementById('downloadBtn'),
            resetBtn: document.getElementById('resetBtn'),
            errorMessage: document.getElementById('errorMessage'),
            errorText: document.getElementById('errorText'),
            fileTypeInputs: document.querySelectorAll('input[name="fileType"]'),
            mainContent: document.querySelector('.main-content')
        };
    }

    function elementsReady(el) {
        const requiredKeys = [
            'themeToggle',
            'dropZone',
            'fileInput',
            'dropZoneSuccess',
            'fileNameDisplay',
            'previewSection',
            'previewTable',
            'fileInfo',
            'previewNote',
            'downloadSection',
            'downloadBtn',
            'resetBtn',
            'errorMessage',
            'errorText'
        ];

        const missing = requiredKeys.filter(key => !el[key]);
        if (!el.fileTypeInputs || el.fileTypeInputs.length === 0) {
            missing.push('fileTypeInputs');
        }

        if (missing.length) {
            console.error(`Missing required elements: ${missing.join(', ')}`);
            return false;
        }

        return true;
    }

    /**
     * Initialize theme from localStorage or system preference
     */
    function initTheme() {
        const savedTheme = localStorage.getItem('linkedin-analyzer-theme');
        const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

        state.theme = savedTheme || (systemPrefersDark ? 'dark' : 'light');
        applyTheme(state.theme);

        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
            if (!localStorage.getItem('linkedin-analyzer-theme')) {
                state.theme = event.matches ? 'dark' : 'light';
                applyTheme(state.theme);
            }
        });
    }

    /**
     * Apply theme to document
     * @param {string} theme - 'light' or 'dark'
     */
    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        state.theme = theme;
    }

    /**
     * Toggle between light and dark theme
     */
    function toggleTheme() {
        const newTheme = state.theme === 'light' ? 'dark' : 'light';
        applyTheme(newTheme);
        localStorage.setItem('linkedin-analyzer-theme', newTheme);
        initRoughDecorations();
    }

    /**
     * Initialize all event listeners
     */
    function bindEvents() {
        elements.themeToggle.addEventListener('click', toggleTheme);

        elements.dropZone.addEventListener('click', () => elements.fileInput.click());
        elements.dropZone.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                elements.fileInput.click();
            }
        });

        elements.fileInput.addEventListener('change', handleFileSelect);
        elements.dropZone.addEventListener('dragover', handleDragOver);
        elements.dropZone.addEventListener('dragleave', handleDragLeave);
        elements.dropZone.addEventListener('drop', handleDrop);

        window.addEventListener('dragover', (event) => event.preventDefault());
        window.addEventListener('drop', (event) => event.preventDefault());

        elements.fileTypeInputs.forEach(input => {
            input.addEventListener('change', handleFileTypeChange);
        });

        elements.downloadBtn.addEventListener('click', handleDownload);
        elements.resetBtn.addEventListener('click', handleReset);
    }

    /**
     * Handle drag over event
     * @param {DragEvent} event
     */
    function handleDragOver(event) {
        event.preventDefault();
        event.stopPropagation();
        elements.dropZone.classList.add('drag-over');
    }

    /**
     * Handle drag leave event
     * @param {DragEvent} event
     */
    function handleDragLeave(event) {
        event.preventDefault();
        event.stopPropagation();
        elements.dropZone.classList.remove('drag-over');
    }

    /**
     * Handle file drop event
     * @param {DragEvent} event
     */
    function handleDrop(event) {
        event.preventDefault();
        event.stopPropagation();
        elements.dropZone.classList.remove('drag-over');

        const files = event.dataTransfer?.files;
        if (files && files.length > 0) {
            void processFile(files[0]);
        }
    }

    /**
     * Handle file input selection
     * @param {Event} event
     */
    function handleFileSelect(event) {
        const files = event.target.files;
        if (files && files.length > 0) {
            void processFile(files[0]);
        }
    }

    /**
     * Handle file type radio change
     */
    function handleFileTypeChange() {
        if (state.currentFile) {
            void processFile(state.currentFile);
        }
    }

    /**
     * Process uploaded file
     * @param {File} file
     */
    async function processFile(file) {
        if (!isCsvFile(file)) {
            showError('Please upload a CSV file.');
            resetDropZone();
            return;
        }

        state.currentFile = file;
        hideError();
        showFileUploaded(file.name);
        setProcessing(true);

        try {
            const csvText = await readFileAsText(file);
            const fileType = getSelectedFileType();
            const result = LinkedInCleaner.process(csvText, fileType);

            state.processedResult = result;

            if (result.success) {
                showPreview(result);
                showDownloadSection();
            } else {
                showError(result.error);
                hidePreview();
                hideDownloadSection();
                resetDropZone();
            }
        } catch (error) {
            showError(getErrorMessage(error));
            hidePreview();
            hideDownloadSection();
            resetDropZone();
        } finally {
            setProcessing(false);
        }
    }

    function isCsvFile(file) {
        return Boolean(file && file.name && file.name.toLowerCase().endsWith('.csv'));
    }

    function readFileAsText(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
            reader.onerror = () => reject(new Error('Error reading file. Please try again.'));
            reader.readAsText(file);
        });
    }

    function getErrorMessage(error) {
        if (error instanceof Error) {
            return error.message;
        }
        return 'An unexpected error occurred. Please try again.';
    }

    /**
     * Get selected file type from radio buttons
     * @returns {string} 'shares', 'comments', or 'auto'
     */
    function getSelectedFileType() {
        const selected = document.querySelector('input[name="fileType"]:checked');
        return selected ? selected.value : 'auto';
    }

    /**
     * Show preview of processed data
     * @param {object} result - Processing result from cleaner
     */
    function showPreview(result) {
        const { cleanedData, fileType, rowCount } = result;
        const config = LinkedInCleaner.configs[fileType];

        if (!config) {
            showError('Unknown file type. Please try again.');
            return;
        }

        const headers = config.columns.map(column => column.name);
        const fileTypeLabel = FILE_TYPE_LABELS[fileType] || 'Unknown';
        elements.fileInfo.textContent = `${fileTypeLabel} - ${rowCount} rows`;

        const thead = elements.previewTable.querySelector('thead');
        thead.innerHTML = `<tr>${headers.map(header => `<th>${escapeHtml(header)}</th>`).join('')}</tr>`;

        const tbody = elements.previewTable.querySelector('tbody');
        const previewRows = cleanedData.slice(0, PREVIEW_ROW_LIMIT);
        tbody.innerHTML = previewRows.map(row =>
            `<tr>${headers.map(header => {
                const value = row[header] || '';
                return `<td title="${escapeHtml(value)}">${escapeHtml(truncate(value, PREVIEW_CELL_LIMIT))}</td>`;
            }).join('')}</tr>`
        ).join('');

        if (rowCount > PREVIEW_ROW_LIMIT) {
            elements.previewNote.textContent = `Showing first ${PREVIEW_ROW_LIMIT} of ${rowCount} rows`;
        } else {
            elements.previewNote.textContent = `Showing all ${rowCount} rows`;
        }

        elements.previewSection.hidden = false;
    }

    function hidePreview() {
        elements.previewSection.hidden = true;
    }

    function showDownloadSection() {
        elements.downloadSection.hidden = false;
    }

    function hideDownloadSection() {
        elements.downloadSection.hidden = true;
    }

    /**
     * Handle download button click
     */
    function handleDownload() {
        if (!state.processedResult || !state.processedResult.success) {
            showError('No data to download. Please upload a file first.');
            return;
        }

        const { cleanedData, fileType } = state.processedResult;
        const result = ExcelGenerator.generateAndDownload(cleanedData, fileType);

        if (!result.success) {
            showError(`Error generating Excel: ${result.error}`);
        }
    }

    /**
     * Handle reset button click - clear everything and start fresh
     */
    function handleReset() {
        state.currentFile = null;
        state.processedResult = null;

        elements.fileInput.value = '';
        resetDropZone();
        hidePreview();
        hideDownloadSection();
        hideError();
        setProcessing(false);

        const autoRadio = document.querySelector('input[name="fileType"][value="auto"]');
        if (autoRadio) {
            autoRadio.checked = true;
        }
    }

    function showError(message) {
        elements.errorText.textContent = message;
        elements.errorMessage.hidden = false;
    }

    function hideError() {
        elements.errorMessage.hidden = true;
    }

    function showFileUploaded(filename) {
        elements.dropZone.classList.add('has-file');
        elements.fileNameDisplay.textContent = filename;
        elements.dropZoneSuccess.hidden = false;
    }

    function resetDropZone() {
        elements.dropZone.classList.remove('has-file');
        elements.dropZoneSuccess.hidden = true;
        elements.fileNameDisplay.textContent = '';
    }

    function setProcessing(isProcessing) {
        if (!elements.mainContent) {
            return;
        }
        elements.mainContent.classList.toggle('loading', isProcessing);
    }

    function escapeHtml(value) {
        const div = document.createElement('div');
        div.textContent = value;
        return div.innerHTML;
    }

    function truncate(value, maxLength) {
        if (!value) return '';
        if (value.length <= maxLength) return value;
        return value.slice(0, maxLength) + '...';
    }

    /**
     * Initialize RoughJS decorations
     * Draws hand-drawn style decorative elements
     */
    function initRoughDecorations() {
        const canvas = document.getElementById('roughCanvas');
        if (!canvas || typeof rough === 'undefined') return;

        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;

        const rc = rough.canvas(canvas);
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const isDark = state.theme === 'dark';
        const colors = {
            blue: isDark ? 'rgba(127, 179, 213, 0.15)' : 'rgba(91, 155, 213, 0.1)',
            yellow: isDark ? 'rgba(247, 220, 111, 0.1)' : 'rgba(244, 208, 63, 0.08)',
            purple: isDark ? 'rgba(187, 143, 206, 0.1)' : 'rgba(155, 89, 182, 0.08)'
        };

        rc.circle(canvas.width - 100, 150, 200, {
            fill: colors.blue,
            fillStyle: 'solid',
            stroke: 'transparent',
            roughness: 2
        });

        rc.circle(80, canvas.height - 150, 180, {
            fill: colors.purple,
            fillStyle: 'solid',
            stroke: 'transparent',
            roughness: 2
        });

        rc.circle(canvas.width - 200, canvas.height - 100, 100, {
            fill: colors.yellow,
            fillStyle: 'solid',
            stroke: 'transparent',
            roughness: 2
        });
    }

    let resizeTimeout;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(initRoughDecorations, 250);
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
