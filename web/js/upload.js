/* Upload page logic */

(function() {
    'use strict';

    const TRACKED_TYPES = Object.freeze(['shares', 'comments', 'messages', 'connections']);

    const elements = {
        dropZone: document.getElementById('multiDropZone'),
        fileInput: document.getElementById('multiFileInput'),
        sharesStatus: document.getElementById('sharesStatus'),
        commentsStatus: document.getElementById('commentsStatus'),
        messagesStatus: document.getElementById('messagesStatus'),
        connectionsStatus: document.getElementById('connectionsStatus'),
        uploadHint: document.getElementById('uploadHint'),
        openAnalyticsBtn: document.getElementById('openAnalyticsBtn'),
        clearAllBtn: document.getElementById('clearAllBtn'),
        fileStatusItems: {
            shares: document.querySelector('.file-status-item[data-file="shares"]'),
            comments: document.querySelector('.file-status-item[data-file="comments"]'),
            messages: document.querySelector('.file-status-item[data-file="messages"]'),
            connections: document.querySelector('.file-status-item[data-file="connections"]')
        },
        progressOverlay: document.getElementById('progressOverlay'),
        progressCanvas: document.getElementById('progressCanvas'),
        progressPercent: document.getElementById('progressPercent')
    };

    const WORKER_URL = 'js/analytics-worker.js?v=20260228-2';

    let worker = null;
    const pendingFiles = new Map();
    let activeJobs = 0;
    let progressValue = 0;
    let progressAnimationId = null;

    /** Initialize the upload page. */
    function init() {
        if (!elements.dropZone || !elements.fileInput) return;
        initWorker();
        bindEvents();
        restoreState();
    }

    /** Create the analytics Web Worker. */
    function initWorker() {
        if (typeof Worker === 'undefined') return;
        try {
            worker = new Worker(WORKER_URL);
            worker.addEventListener('message', handleWorkerMessage);
            worker.addEventListener('error', handleWorkerError);
        } catch {
            worker = null;
            setHint('This page must be opened from a local server (not file://). Start a server and reload.', true);
        }
    }

    /** Attach event listeners for drag/drop, file input, and buttons. */
    function bindEvents() {
        elements.dropZone.addEventListener('click', () => elements.fileInput.click());
        elements.dropZone.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                elements.fileInput.click();
            }
        });
        elements.fileInput.addEventListener('change', handleFileInput);
        elements.dropZone.addEventListener('dragover', handleDragOver);
        elements.dropZone.addEventListener('dragleave', handleDragLeave);
        elements.dropZone.addEventListener('drop', handleDrop);

        window.addEventListener('dragover', (event) => event.preventDefault());
        window.addEventListener('drop', (event) => event.preventDefault());

        elements.openAnalyticsBtn.addEventListener('click', () => {
            if (!elements.openAnalyticsBtn.disabled) {
                window.location.href = 'analytics.html';
            }
        });

        elements.clearAllBtn.addEventListener('click', async () => {
            await Storage.clearAll();
            if (worker) {
                worker.postMessage({ type: 'clear' });
            }
            resetProcessingState();
            updateStatus({ fileMap: createEmptyFileMap(), analyticsReady: false });
        });

        window.addEventListener('resize', () => drawProgressBar(progressValue));
    }

    /** Restore upload status from IndexedDB on page load. */
    async function restoreState() {
        const files = await Storage.getAllFiles();
        const fileMap = getFileMap(files);
        primeAnalyticsWorker(fileMap);
        const analyticsReady = await hasAnalyticsData();
        updateStatus({ fileMap, analyticsReady });
    }

    /**
     * Handle dragover to show drop zone highlight.
     * @param {DragEvent} event
     */
    function handleDragOver(event) {
        event.preventDefault();
        elements.dropZone.classList.add('drag-over');
    }

    /**
     * Handle dragleave to remove drop zone highlight.
     * @param {DragEvent} event
     */
    function handleDragLeave(event) {
        event.preventDefault();
        elements.dropZone.classList.remove('drag-over');
    }

    /**
     * Handle file drop event.
     * @param {DragEvent} event
     */
    function handleDrop(event) {
        event.preventDefault();
        elements.dropZone.classList.remove('drag-over');
        const files = Array.from(event.dataTransfer?.files || []);
        if (files.length) {
            processFiles(files);
        }
    }

    /**
     * Handle file input change event.
     * @param {Event} event
     */
    function handleFileInput(event) {
        const files = Array.from(event.target.files || []);
        if (files.length) {
            processFiles(files);
        }
        event.target.value = '';
    }

    /**
     * Read CSV files and send them to the worker for processing.
     * @param {File[]} files
     */
    function processFiles(files) {
        const csvFiles = files.filter(file => file.name.toLowerCase().endsWith('.csv'));
        if (!csvFiles.length) {
            setHint('Please upload CSV files.', true);
            return;
        }
        if (!worker) {
            setHint('Workers are unavailable. Open this page from a local server.', true);
            return;
        }

        showProgressOverlay();
        csvFiles.forEach(file => {
            activeJobs += 1;
            const jobId = createJobId(file);
            readFileAsText(file)
                .then(text => {
                    pendingFiles.set(jobId, { text, fileName: file.name });
                    worker.postMessage({
                        type: 'addFile',
                        payload: { csvText: text, fileName: file.name, jobId }
                    });
                })
                .catch(() => {
                    completeJob();
                    setHint('Error reading file. Please try again.', true);
                });
        });
    }

    /**
     * Build a unique job ID for pending file processing.
     * @param {File} file - Uploaded file
     * @returns {string}
     */
    function createJobId(file) {
        return `${file.name}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    }

    /**
     * Read a File object as UTF-8 text.
     * @param {File} file
     * @returns {Promise<string>}
     */
    function readFileAsText(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
            reader.onerror = () => reject(new Error('Error reading file'));
            reader.readAsText(file);
        });
    }

    /**
     * Handle messages from the analytics worker.
     * @param {MessageEvent} event
     */
    async function handleWorkerMessage(event) {
        const message = event.data || {};
        switch (message.type) {
            case 'restored':
                return;
            case 'fileProcessed':
                await handleFileProcessedMessage(message.payload || {});
                return;
            case 'error':
                setHint(message.payload && message.payload.message ? message.payload.message : 'Worker error.', true);
                completeJob();
                return;
            default:
                return;
        }
    }

    /**
     * Persist processed worker payload and refresh upload status.
     * @param {object} payload - Worker payload for fileProcessed
     */
    async function handleFileProcessedMessage(payload) {
        const fileType = payload.fileType;
        const fileName = payload.fileName;
        const jobId = payload.jobId || null;
        const rowCount = payload.rowCount || 0;

        if (!fileType) {
            setHint(payload.error || 'File could not be processed.', true);
            completeJob();
            return;
        }

        try {
            const pendingKey = jobId || fileName;
            const pending = pendingFiles.get(pendingKey) || null;
            if (pendingKey) {
                pendingFiles.delete(pendingKey);
            }
            const text = pending ? pending.text : '';

            await Storage.saveFile(fileType, { name: fileName, text, rowCount });
            if (payload.analyticsBase) {
                await Storage.saveAnalytics(payload.analyticsBase);
            }

            const files = await Storage.getAllFiles();
            const fileMap = getFileMap(files);
            const analyticsReady = await hasAnalyticsData();
            updateStatus({ fileMap, analyticsReady });
            setHint('File loaded successfully.', false);
        } catch {
            setHint('Error saving file data. Please try again.', true);
        } finally {
            completeJob();
        }
    }

    /** Handle worker-level errors. */
    function handleWorkerError() {
        setHint('Analytics worker error. Try refreshing.', true);
        resetProcessingState();
    }

    /**
     * Decrement active jobs and hide overlay when complete.
     */
    function completeJob() {
        activeJobs = Math.max(0, activeJobs - 1);
        checkJobs();
    }

    /**
     * Update a single file type's status indicator and label.
     * @param {HTMLElement} statusItem - The .file-status-item element
     * @param {HTMLElement} statusLabel - The status text element
     * @param {object|null} fileData - Stored file record, or null if not uploaded
     */
    function updateFileStatus(statusItem, statusLabel, fileData) {
        if (!statusItem || !statusLabel) {
            return;
        }
        if (fileData) {
            statusItem.classList.add('is-ready');
            statusLabel.textContent = `${fileData.rowCount} rows loaded`;
        } else {
            statusItem.classList.remove('is-ready');
            statusLabel.textContent = 'Not uploaded';
        }
    }

    /**
     * Update the upload page UI to reflect current file and analytics state.
     * @param {{fileMap: Object<string, object|null>, analyticsReady: boolean}} status
     */
    function updateStatus({ fileMap, analyticsReady }) {
        updateFileStatus(elements.fileStatusItems.shares, elements.sharesStatus, fileMap.shares);
        updateFileStatus(elements.fileStatusItems.comments, elements.commentsStatus, fileMap.comments);
        updateFileStatus(elements.fileStatusItems.messages, elements.messagesStatus, fileMap.messages);
        updateFileStatus(elements.fileStatusItems.connections, elements.connectionsStatus, fileMap.connections);

        const hasAny = TRACKED_TYPES.some(type => Boolean(fileMap[type]));
        const hasAnalyticsFiles = Boolean(fileMap.shares || fileMap.comments);
        elements.openAnalyticsBtn.disabled = !hasAnalyticsFiles || !analyticsReady;
        setHint(getUploadHint(hasAny, hasAnalyticsFiles, analyticsReady), false);
    }

    /**
     * Resolve current upload hint message.
     * @param {boolean} hasAny - Whether any tracked file exists
     * @param {boolean} hasAnalyticsFiles - Whether shares/comments exist
     * @param {boolean} analyticsReady - Whether analytics base is available
     * @returns {string}
     */
    function getUploadHint(hasAny, hasAnalyticsFiles, analyticsReady) {
        if (!hasAny) {
            return 'Upload at least one file to start.';
        }
        if (hasAnalyticsFiles && !analyticsReady) {
            return 'Processing analytics in the background.';
        }
        if (analyticsReady) {
            return 'Analytics are ready. Open the dashboard.';
        }
        return 'Files loaded. Open Messages tab for conversation insights.';
    }

    /**
     * Build a fixed file map for all tracked types.
     * @param {object[]} files - Stored file records
     * @returns {{shares: object|null, comments: object|null, messages: object|null, connections: object|null}}
     */
    function getFileMap(files) {
        const map = createEmptyFileMap();
        files.forEach(file => {
            if (TRACKED_TYPES.includes(file.type)) {
                map[file.type] = file;
            }
        });
        return map;
    }

    /**
     * Create an empty file map.
     * @returns {{shares: null, comments: null, messages: null, connections: null}}
     */
    function createEmptyFileMap() {
        return {
            shares: null,
            comments: null,
            messages: null,
            connections: null
        };
    }

    /**
     * Check whether analytics aggregates are available in storage.
     * @returns {Promise<boolean>}
     */
    async function hasAnalyticsData() {
        const analyticsBase = await Storage.getAnalytics();
        return Boolean(
            analyticsBase
            && analyticsBase.months
            && Object.keys(analyticsBase.months).length
        );
    }

    /**
     * Seed worker with existing shares/comments datasets for accurate recompute.
     * @param {{shares: object|null, comments: object|null}} fileMap - Stored files map
     */
    function primeAnalyticsWorker(fileMap) {
        if (!worker) {
            return;
        }

        const sharesCsv = fileMap.shares ? fileMap.shares.text : '';
        const commentsCsv = fileMap.comments ? fileMap.comments.text : '';
        if (!sharesCsv && !commentsCsv) {
            return;
        }

        worker.postMessage({
            type: 'restoreFiles',
            payload: { sharesCsv, commentsCsv }
        });
    }

    /**
     * Update the upload hint text and error state.
     * @param {string} message
     * @param {boolean} isError
     */
    function setHint(message, isError) {
        elements.uploadHint.textContent = message;
        elements.uploadHint.classList.toggle('is-error', Boolean(isError));
    }

    /** Hide progress overlay when all active jobs complete. */
    function checkJobs() {
        if (activeJobs <= 0) {
            hideProgressOverlay();
        }
    }

    /**
     * Clear queued processing state and hide the overlay.
     */
    function resetProcessingState() {
        pendingFiles.clear();
        activeJobs = 0;
        hideProgressOverlay();
    }

    /** Show the progress overlay and start animation. */
    function showProgressOverlay() {
        elements.progressOverlay.hidden = false;
        progressValue = 0;
        drawProgressBar(progressValue);
        animateProgressTo(0.85, 900);
    }

    /** Animate progress to 100% then hide the overlay. */
    function hideProgressOverlay() {
        animateProgressTo(1, 300, () => {
            elements.progressOverlay.hidden = true;
        });
    }

    /**
     * Smoothly animate progress bar to target value.
     * @param {number} target - Target progress value (0-1)
     * @param {number} duration - Animation duration in ms
     * @param {Function} [callback] - Optional callback when animation completes
     */
    function animateProgressTo(target, duration, callback) {
        if (progressAnimationId) {
            cancelAnimationFrame(progressAnimationId);
        }
        const start = performance.now();
        const startValue = progressValue;

        function step(now) {
            const elapsed = now - start;
            const t = Math.min(elapsed / duration, 1);
            const eased = 1 - Math.pow(1 - t, 3);
            progressValue = startValue + (target - startValue) * eased;
            drawProgressBar(progressValue);
            if (t < 1) {
                progressAnimationId = requestAnimationFrame(step);
            } else if (callback) {
                callback();
            }
        }

        progressAnimationId = requestAnimationFrame(step);
    }

    /**
     * Draw the progress bar on canvas at the given value (0-1).
     * @param {number} value - Progress value between 0 and 1
     */
    function drawProgressBar(value) {
        const canvas = elements.progressCanvas;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const ratio = window.devicePixelRatio || 1;
        canvas.width = rect.width * ratio;
        canvas.height = rect.height * ratio;
        const ctx = canvas.getContext('2d');
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.clearRect(0, 0, rect.width, rect.height);

        const styles = getComputedStyle(document.documentElement);
        const border = styles.getPropertyValue('--border-color').trim();
        const fill = styles.getPropertyValue('--accent-purple').trim();

        const trackX = 8;
        const trackY = rect.height / 2 - 10;
        const trackWidth = rect.width - 16;
        const trackHeight = 20;

        if (typeof rough !== 'undefined') {
            const rc = rough.canvas(canvas);
            rc.rectangle(trackX, trackY, trackWidth, trackHeight, {
                stroke: border,
                strokeWidth: 1.5,
                roughness: 1.4
            });
            const fillWidth = Math.max(4, (trackWidth - 4) * value);
            ctx.fillStyle = fill;
            ctx.globalAlpha = 0.6;
            ctx.fillRect(trackX + 2, trackY + 2, fillWidth, trackHeight - 4);
            ctx.globalAlpha = 1;
            rc.rectangle(trackX + 2, trackY + 2, fillWidth, trackHeight - 4, {
                stroke: fill,
                strokeWidth: 1.2,
                roughness: 1.2
            });
        }

        elements.progressPercent.textContent = `${Math.round(value * 100)}%`;
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
