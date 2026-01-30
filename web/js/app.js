/**
 * LinkedIn Analyzer - Main Application
 * Handles UI interactions, file upload, theme toggle, and orchestrates cleaning/export
 */

(function() {
    'use strict';

    // State
    const state = {
        currentFile: null,
        processedResult: null,
        theme: 'light'
    };

    // DOM Elements
    const elements = {
        themeToggle: document.getElementById('themeToggle'),
        dropZone: document.getElementById('dropZone'),
        fileInput: document.getElementById('fileInput'),
        dropZoneContent: document.querySelector('.drop-zone-content'),
        dropZoneSuccess: document.querySelector('.drop-zone-success'),
        fileNameDisplay: document.querySelector('.file-name-display'),
        previewSection: document.getElementById('previewSection'),
        previewTable: document.getElementById('previewTable'),
        fileInfo: document.getElementById('fileInfo'),
        previewNote: document.getElementById('previewNote'),
        downloadSection: document.getElementById('downloadSection'),
        downloadBtn: document.getElementById('downloadBtn'),
        errorMessage: document.getElementById('errorMessage'),
        errorText: document.getElementById('errorText'),
        fileTypeInputs: document.querySelectorAll('input[name="fileType"]')
    };

    /**
     * Initialize the application
     */
    function init() {
        initTheme();
        initEventListeners();
        initRoughDecorations();
    }

    /**
     * Initialize theme from localStorage or system preference
     */
    function initTheme() {
        const savedTheme = localStorage.getItem('linkedin-analyzer-theme');
        const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        
        state.theme = savedTheme || (systemPrefersDark ? 'dark' : 'light');
        applyTheme(state.theme);

        // Listen for system theme changes
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
            if (!localStorage.getItem('linkedin-analyzer-theme')) {
                state.theme = e.matches ? 'dark' : 'light';
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
        
        // Redraw rough decorations for new theme
        initRoughDecorations();
    }

    /**
     * Initialize all event listeners
     */
    function initEventListeners() {
        // Theme toggle
        elements.themeToggle.addEventListener('click', toggleTheme);

        // File input click
        elements.dropZone.addEventListener('click', () => elements.fileInput.click());
        elements.dropZone.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                elements.fileInput.click();
            }
        });

        // File input change
        elements.fileInput.addEventListener('change', handleFileSelect);

        // Drag and drop
        elements.dropZone.addEventListener('dragover', handleDragOver);
        elements.dropZone.addEventListener('dragleave', handleDragLeave);
        elements.dropZone.addEventListener('drop', handleDrop);

        // Prevent default drag behavior on window
        window.addEventListener('dragover', (e) => e.preventDefault());
        window.addEventListener('drop', (e) => e.preventDefault());

        // File type change
        elements.fileTypeInputs.forEach(input => {
            input.addEventListener('change', handleFileTypeChange);
        });

        // Download button
        elements.downloadBtn.addEventListener('click', handleDownload);
    }

    /**
     * Handle drag over event
     * @param {DragEvent} e
     */
    function handleDragOver(e) {
        e.preventDefault();
        e.stopPropagation();
        elements.dropZone.classList.add('drag-over');
    }

    /**
     * Handle drag leave event
     * @param {DragEvent} e
     */
    function handleDragLeave(e) {
        e.preventDefault();
        e.stopPropagation();
        elements.dropZone.classList.remove('drag-over');
    }

    /**
     * Handle file drop event
     * @param {DragEvent} e
     */
    function handleDrop(e) {
        e.preventDefault();
        e.stopPropagation();
        elements.dropZone.classList.remove('drag-over');
        
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            processFile(files[0]);
        }
    }

    /**
     * Handle file input selection
     * @param {Event} e
     */
    function handleFileSelect(e) {
        const files = e.target.files;
        if (files.length > 0) {
            processFile(files[0]);
        }
    }

    /**
     * Handle file type radio change
     */
    function handleFileTypeChange() {
        if (state.currentFile) {
            processFile(state.currentFile);
        }
    }

    /**
     * Process uploaded file
     * @param {File} file
     */
    function processFile(file) {
        // Validate file type
        if (!file.name.toLowerCase().endsWith('.csv')) {
            showError('Please upload a CSV file.');
            resetDropZone();
            return;
        }

        state.currentFile = file;
        hideError();
        showFileUploaded(file.name);

        // Read file
        const reader = new FileReader();
        reader.onload = (e) => {
            const csvText = e.target.result;
            const fileType = getSelectedFileType();
            
            // Process with cleaner
            const result = LinkedInCleaner.process(csvText, fileType);
            state.processedResult = result;

            if (result.success) {
                showPreview(result, file.name);
                showDownloadSection();
            } else {
                showError(result.error);
                hidePreview();
                hideDownloadSection();
                resetDropZone();
            }
        };

        reader.onerror = () => {
            showError('Error reading file. Please try again.');
            resetDropZone();
        };

        reader.readAsText(file);
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
     * @param {string} filename - Original filename
     */
    function showPreview(result, filename) {
        const { cleanedData, fileType, rowCount } = result;
        const config = LinkedInCleaner.configs[fileType];
        const headers = config.columns.map(c => c.name);
        
        // Update file info
        const fileTypeLabel = fileType === 'shares' ? 'Shares' : 'Comments';
        elements.fileInfo.textContent = `${fileTypeLabel} - ${rowCount} rows`;

        // Build table header
        const thead = elements.previewTable.querySelector('thead');
        thead.innerHTML = `<tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr>`;

        // Build table body (show first 5 rows)
        const tbody = elements.previewTable.querySelector('tbody');
        const previewRows = cleanedData.slice(0, 5);
        tbody.innerHTML = previewRows.map(row => 
            `<tr>${headers.map(h => `<td title="${escapeHtml(row[h] || '')}">${escapeHtml(truncate(row[h] || '', 50))}</td>`).join('')}</tr>`
        ).join('');

        // Update preview note
        if (rowCount > 5) {
            elements.previewNote.textContent = `Showing first 5 of ${rowCount} rows`;
        } else {
            elements.previewNote.textContent = `Showing all ${rowCount} rows`;
        }

        elements.previewSection.hidden = false;
    }

    /**
     * Hide preview section
     */
    function hidePreview() {
        elements.previewSection.hidden = true;
    }

    /**
     * Show download section
     */
    function showDownloadSection() {
        elements.downloadSection.hidden = false;
    }

    /**
     * Hide download section
     */
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
     * Show error message
     * @param {string} message
     */
    function showError(message) {
        elements.errorText.textContent = message;
        elements.errorMessage.hidden = false;
    }

    /**
     * Hide error message
     */
    function hideError() {
        elements.errorMessage.hidden = true;
    }

    /**
     * Show file uploaded state in drop zone
     * @param {string} filename - Name of the uploaded file
     */
    function showFileUploaded(filename) {
        elements.dropZone.classList.add('has-file');
        elements.fileNameDisplay.textContent = filename;
        elements.dropZoneSuccess.hidden = false;
    }

    /**
     * Reset drop zone to initial state
     */
    function resetDropZone() {
        elements.dropZone.classList.remove('has-file');
        elements.dropZoneSuccess.hidden = true;
    }

    /**
     * Escape HTML special characters
     * @param {string} str
     * @returns {string}
     */
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    /**
     * Truncate string to specified length
     * @param {string} str
     * @param {number} maxLength
     * @returns {string}
     */
    function truncate(str, maxLength) {
        if (!str) return '';
        if (str.length <= maxLength) return str;
        return str.slice(0, maxLength) + '...';
    }

    /**
     * Initialize RoughJS decorations
     * Draws hand-drawn style decorative elements
     */
    function initRoughDecorations() {
        const canvas = document.getElementById('roughCanvas');
        if (!canvas || typeof rough === 'undefined') return;

        // Set canvas size
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;

        const rc = rough.canvas(canvas);
        const ctx = canvas.getContext('2d');
        
        // Clear canvas
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Get theme colors
        const isDark = state.theme === 'dark';
        const colors = {
            blue: isDark ? 'rgba(127, 179, 213, 0.15)' : 'rgba(91, 155, 213, 0.1)',
            yellow: isDark ? 'rgba(247, 220, 111, 0.1)' : 'rgba(244, 208, 63, 0.08)',
            purple: isDark ? 'rgba(187, 143, 206, 0.1)' : 'rgba(155, 89, 182, 0.08)'
        };

        // Draw some subtle decorative shapes
        // Top right blob
        rc.circle(canvas.width - 100, 150, 200, {
            fill: colors.blue,
            fillStyle: 'solid',
            stroke: 'transparent',
            roughness: 2
        });

        // Bottom left blob
        rc.circle(80, canvas.height - 150, 180, {
            fill: colors.purple,
            fillStyle: 'solid',
            stroke: 'transparent',
            roughness: 2
        });

        // Small yellow accent
        rc.circle(canvas.width - 200, canvas.height - 100, 100, {
            fill: colors.yellow,
            fillStyle: 'solid',
            stroke: 'transparent',
            roughness: 2
        });
    }

    // Handle window resize for rough decorations
    let resizeTimeout;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(initRoughDecorations, 250);
    });

    // Initialize app when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
