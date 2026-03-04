/* Upload page logic */
/* exported UploadPage */

const UploadPage = (() => {
    'use strict';

    const TRACKED_TYPES = Object.freeze(['shares', 'comments', 'messages', 'connections']);
    const TRACKED_TYPES_SET = new Set(TRACKED_TYPES);
    const UPLOAD_HINT_BY_STATE = Object.freeze({
        '0-0-0': 'Upload at least one file to start.',
        '0-0-1': 'Upload at least one file to start.',
        '0-1-0': 'Upload at least one file to start.',
        '0-1-1': 'Upload at least one file to start.',
        '1-1-0': 'Processing analytics in the background.',
        '1-1-1': 'Analytics are ready. Open the dashboard.',
        '1-0-0': 'Files loaded. Open Messages tab for conversation insights.',
        '1-0-1': 'Files loaded. Open Messages tab for conversation insights.'
    });

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

    const STATUS_ITEMS = Object.freeze([
        { type: 'shares', item: elements.fileStatusItems.shares, label: elements.sharesStatus },
        { type: 'comments', item: elements.fileStatusItems.comments, label: elements.commentsStatus },
        { type: 'messages', item: elements.fileStatusItems.messages, label: elements.messagesStatus },
        { type: 'connections', item: elements.fileStatusItems.connections, label: elements.connectionsStatus }
    ]);

    const WORKER_URL = 'js/analytics-worker.js';
    const JOB_TIMEOUT_MS = 45000;
    const SESSION_CLEANUP_PROMISE_KEY = '__linkedinAnalyzerSessionCleanupPromise';

    let worker = null;
    const pendingFiles = new Map();
    const activeJobs = new Set();
    const jobTimeouts = new Map();
    let progressValue = 0;
    let progressAnimationId = null;
    let progressSessionId = 0;
    let initialized = false;
    let lastPrimedSignature = null;
    let restorePromise = null;
    let restoredOnce = false;
    let primeTimerId = null;
    let primeIdleId = null;
    let pendingPrimePayload = null;

    /** Initialize the upload page. */
    function init() {
        if (initialized) {
            return;
        }
        if (!elements.dropZone || !elements.fileInput) {
            return;
        }
        initialized = true;
        initWorker();
        bindEvents();
        restoreState();
    }

    /** Refresh upload state when route becomes active. */
    function onRouteChange() {
        if (!initialized) {
            init();
            return;
        }
        if (restoredOnce) {
            syncStatusFromCache();
            return;
        }
        restoreState();
    }

    /** Create the analytics Web Worker. */
    function initWorker() {
        if (typeof Worker === 'undefined') {
            return;
        }
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
            if (elements.openAnalyticsBtn.disabled) {
                return;
            }

            if (typeof AppRouter !== 'undefined') {
                AppRouter.navigate('analytics', undefined, { replaceHistory: false });
                return;
            }

            window.location.hash = '#analytics';
        });

        elements.clearAllBtn.addEventListener('click', async () => {
            await Storage.clearAll();
            clearPrimeSchedule();
            pendingPrimePayload = null;
            if (worker) {
                worker.postMessage({ type: 'clear' });
            }
            if (typeof DataCache !== 'undefined') {
                DataCache.clear();
                DataCache.notify({ type: 'storageCleared' });
            }
            lastPrimedSignature = null;
            resetProcessingState();
            updateStatus({ fileMap: createEmptyFileMap(), analyticsReady: false });
        });

        window.addEventListener('resize', () => drawProgressBar(progressValue));
    }

    /** Restore upload status from IndexedDB and prime cache/worker on load. */
    async function restoreState() {
        if (restorePromise) {
            return restorePromise;
        }

        restorePromise = (async () => {
            await waitForSessionCleanup();
            const files = await Storage.getAllFiles();
            if (typeof DataCache !== 'undefined') {
                DataCache.set('storage:files', files);
            }
            const fileMap = getFileMap(files);
            scheduleAnalyticsWorkerPrime(fileMap, { priority: 'idle' });
            const analyticsReady = await hasAnalyticsData();
            updateStatus({ fileMap, analyticsReady });
        })();

        try {
            await restorePromise;
        } finally {
            restorePromise = null;
            restoredOnce = true;
        }
    }

    /**
     * Wait for non-blocking session cleanup to finish when present.
     * @returns {Promise<void>}
     */
    async function waitForSessionCleanup() {
        const cleanupPromise = window[SESSION_CLEANUP_PROMISE_KEY];
        if (!cleanupPromise || typeof cleanupPromise.then !== 'function') {
            return;
        }
        try {
            await cleanupPromise;
        } catch {
            return;
        }
    }

    /** Sync upload status from cache when available, otherwise restore from storage. */
    function syncStatusFromCache() {
        if (typeof DataCache === 'undefined') {
            restoreState();
            return;
        }

        const files = DataCache.get('storage:files');
        const analyticsReady = getAnalyticsReadyFromCache();

        if (!files || analyticsReady === null) {
            restoreState();
            return;
        }

        updateStatus({ fileMap: getFileMap(files), analyticsReady });
    }

    /**
     * Handle dragover to show drop zone highlight.
     * @param {DragEvent} event - Dragover event
     */
    function handleDragOver(event) {
        event.preventDefault();
        elements.dropZone.classList.add('drag-over');
    }

    /**
     * Handle dragleave to remove drop zone highlight.
     * @param {DragEvent} event - Dragleave event
     */
    function handleDragLeave(event) {
        event.preventDefault();
        elements.dropZone.classList.remove('drag-over');
    }

    /**
     * Handle file drop event.
     * @param {DragEvent} event - Drop event
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
     * @param {Event} event - File input change event
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
     * @param {File[]} files - Selected files
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

        if (activeJobs.size <= 0) {
            showProgressOverlay();
        }
        csvFiles.forEach(file => {
            const jobId = createJobId(file);
            activeJobs.add(jobId);
            scheduleJobTimeout(jobId, file.name);
            readFileAsText(file)
                .then(text => {
                    pendingFiles.set(jobId, { text, fileName: file.name });
                    worker.postMessage({
                        type: 'addFile',
                        payload: { csvText: text, fileName: file.name, jobId }
                    });
                })
                .catch(() => {
                    completeJob(jobId, file.name);
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
     * @param {File} file - Uploaded file
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
     * @param {MessageEvent} event - Worker message event
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
                if (!message.payload || (!message.payload.jobId && !message.payload.fileName)) {
                    resetProcessingState();
                    return;
                }
                completeJob(
                    message.payload && message.payload.jobId ? message.payload.jobId : null,
                    message.payload && message.payload.fileName ? message.payload.fileName : ''
                );
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
        const pending = consumePendingFile(jobId, fileName);

        if (!fileType) {
            setHint(payload.error || 'File could not be processed.', true);
            completeJob(jobId, fileName);
            return;
        }

        if (!pending) {
            completeJob(jobId, fileName);
            return;
        }

        try {
            const text = pending.text;

            await persistProcessedFile(fileType, fileName, text, rowCount, payload.analyticsBase);
            await syncCacheAfterProcessedFile(fileType, payload.analyticsBase);

            const files = await getStoredFilesSnapshot();
            const fileMap = getFileMap(files);
            const analyticsReady = await hasAnalyticsData();
            updateStatus({ fileMap, analyticsReady });
            setHint('File loaded successfully.', false);
            if (fileType === 'shares' || fileType === 'comments') {
                scheduleAnalyticsWorkerPrime(fileMap, { priority: 'immediate' });
            }
        } catch {
            setHint('Error saving file data. Please try again.', true);
        } finally {
            completeJob(jobId, fileName);
        }
    }

    /**
     * Persist processed file payload in IndexedDB.
     * @param {string} fileType - Processed file type
     * @param {string} fileName - Uploaded file name
     * @param {string} text - Raw CSV text
     * @param {number} rowCount - Processed row count
     * @param {object|undefined} analyticsBase - Optional analytics aggregate base
     * @returns {Promise<void>}
     */
    async function persistProcessedFile(fileType, fileName, text, rowCount, analyticsBase) {
        await Storage.saveFile(fileType, { name: fileName, text, rowCount });
        if (!analyticsBase) {
            return;
        }
        await Storage.saveAnalytics(analyticsBase);
    }

    /**
     * Sync in-memory caches and notify listeners after file persistence.
     * @param {string} fileType - Processed file type
     * @param {object|undefined} analyticsBase - Optional analytics aggregate base
     * @returns {Promise<void>}
     */
    async function syncCacheAfterProcessedFile(fileType, analyticsBase) {
        if (typeof DataCache === 'undefined') {
            return;
        }

        DataCache.invalidate('storage:');
        DataCache.invalidate('clean:');
        DataCache.invalidate('messages:');

        const files = await Storage.getAllFiles();
        DataCache.set('storage:files', files);
        syncTypeSpecificFileCache(fileType, files);

        if (analyticsBase) {
            DataCache.set('storage:analyticsBase', analyticsBase);
        }

        DataCache.notify({ type: 'filesChanged', fileType });
        if (analyticsBase) {
            DataCache.notify({ type: 'analyticsChanged' });
        }
    }

    /**
     * Sync type-specific file cache entries.
     * @param {string} fileType - Processed file type
     * @param {object[]} files - Stored files snapshot
     */
    function syncTypeSpecificFileCache(fileType, files) {
        if (typeof DataCache === 'undefined') {
            return;
        }

        const key = getTypeSpecificFileCacheKey(fileType);
        if (!key) {
            return;
        }

        const match = files.find(file => file.type === fileType) || null;
        if (!match) {
            return;
        }

        DataCache.set(key, match);
    }

    /**
     * Resolve per-file cache key for messages/connections datasets.
     * @param {string} fileType - Processed file type
     * @returns {string|null}
     */
    function getTypeSpecificFileCacheKey(fileType) {
        switch (fileType) {
            case 'messages':
                return 'storage:file:messages';
            case 'connections':
                return 'storage:file:connections';
            default:
                return null;
        }
    }

    /**
     * Read files from cache when available, otherwise from storage.
     * @returns {Promise<object[]>}
     */
    async function getStoredFilesSnapshot() {
        if (typeof DataCache !== 'undefined') {
            const files = DataCache.get('storage:files');
            if (files) {
                return files;
            }
        }
        return Storage.getAllFiles();
    }

    /**
     * Consume a pending upload entry for a processed worker job.
     * @param {string|null} jobId - Worker job ID
     * @param {string} fileName - Original file name
     * @returns {{text: string, fileName: string}|null}
     */
    function consumePendingFile(jobId, fileName) {
        if (jobId && pendingFiles.has(jobId)) {
            const pending = pendingFiles.get(jobId) || null;
            pendingFiles.delete(jobId);
            return pending;
        }

        if (!fileName) {
            return null;
        }

        for (const [key, pending] of pendingFiles.entries()) {
            if (pending.fileName === fileName) {
                pendingFiles.delete(key);
                return pending;
            }
        }
        return null;
    }

    /** Handle worker-level errors. */
    function handleWorkerError() {
        setHint('Analytics worker error. Try refreshing.', true);
        resetProcessingState();
    }

    /**
     * Mark a processing job complete and hide overlay when done.
     * @param {string|null} jobId - Worker job ID
     * @param {string} fileName - Uploaded file name fallback
     */
    function completeJob(jobId, fileName) {
        const resolvedJobId = resolveJobId(jobId, fileName);

        if (!resolvedJobId) {
            checkJobs();
            return;
        }

        pendingFiles.delete(resolvedJobId);
        clearJobTimeout(resolvedJobId);
        activeJobs.delete(resolvedJobId);
        checkJobs();
    }

    /**
     * Resolve a job ID from explicit ID, file name, or active queue fallback.
     * @param {string|null} jobId - Worker job ID
     * @param {string} fileName - Uploaded file name fallback
     * @returns {string|null}
     */
    function resolveJobId(jobId, fileName) {
        const normalizedJobId = typeof jobId === 'string' && jobId ? jobId : null;
        if (normalizedJobId) {
            return normalizedJobId;
        }

        const pendingJobId = resolvePendingJobIdByFileName(fileName);
        if (pendingJobId) {
            return pendingJobId;
        }

        return getFirstActiveJobId();
    }

    /**
     * Resolve pending job ID by uploaded file name.
     * @param {string} fileName - Uploaded file name
     * @returns {string|null}
     */
    function resolvePendingJobIdByFileName(fileName) {
        const normalizedFileName = String(fileName || '');
        if (!normalizedFileName) {
            return null;
        }

        for (const [key, pending] of pendingFiles.entries()) {
            if (pending && pending.fileName === normalizedFileName) {
                return key;
            }
        }

        return null;
    }

    /**
     * Resolve first active job ID as final fallback.
     * @returns {string|null}
     */
    function getFirstActiveJobId() {
        const iterator = activeJobs.values().next();
        return iterator.done ? null : iterator.value;
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
        STATUS_ITEMS.forEach(({ type, item, label }) => {
            updateFileStatus(item, label, fileMap[type]);
        });

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
        const stateKey = `${hasAny ? 1 : 0}-${hasAnalyticsFiles ? 1 : 0}-${analyticsReady ? 1 : 0}`;
        return UPLOAD_HINT_BY_STATE[stateKey] || 'Files loaded. Open Messages tab for conversation insights.';
    }

    /**
     * Build a fixed file map for all tracked types.
     * @param {object[]} files - Stored file records
     * @returns {{shares: object|null, comments: object|null, messages: object|null, connections: object|null}}
     */
    function getFileMap(files) {
        const map = createEmptyFileMap();
        files.forEach(file => {
            if (TRACKED_TYPES_SET.has(file.type)) {
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
        let analyticsBase = null;
        if (typeof DataCache !== 'undefined') {
            analyticsBase = DataCache.get('storage:analyticsBase') || null;
        }
        if (!analyticsBase) {
            analyticsBase = await Storage.getAnalytics();
            if (typeof DataCache !== 'undefined') {
                DataCache.set('storage:analyticsBase', analyticsBase);
            }
        }
        return Boolean(
            analyticsBase
            && analyticsBase.months
            && Object.keys(analyticsBase.months).length
        );
    }

    /** Read analytics-ready state from cache only. */
    function getAnalyticsReadyFromCache() {
        if (typeof DataCache === 'undefined') {
            return null;
        }
        const analyticsBase = DataCache.get('storage:analyticsBase') || null;
        if (!analyticsBase) {
            return null;
        }
        return Boolean(
            analyticsBase
            && analyticsBase.months
            && Object.keys(analyticsBase.months).length
        );
    }

    /**
     * Seed worker with existing shares/comments datasets for accurate recompute.
     * Uses idle scheduling unless priority is immediate.
     * @param {{shares: object|null, comments: object|null}} fileMap - Stored files map
     * @param {{priority?: 'idle'|'immediate'}} [options] - Scheduling options
     */
    function scheduleAnalyticsWorkerPrime(fileMap, options) {
        if (!worker) {
            return;
        }

        const sharesCsv = fileMap.shares ? fileMap.shares.text : '';
        const commentsCsv = fileMap.comments ? fileMap.comments.text : '';
        if (!sharesCsv && !commentsCsv) {
            lastPrimedSignature = null;
            pendingPrimePayload = null;
            clearPrimeSchedule();
            return;
        }

        const signature = `${sharesCsv.length}:${commentsCsv.length}`;
        if (signature === lastPrimedSignature) {
            pendingPrimePayload = null;
            clearPrimeSchedule();
            return;
        }

        pendingPrimePayload = { sharesCsv, commentsCsv, signature };
        const priority = options && options.priority ? options.priority : 'idle';
        if (priority === 'immediate') {
            clearPrimeSchedule();
            primeAnalyticsWorkerNow();
            return;
        }

        if (primeTimerId || primeIdleId) {
            return;
        }

        if (typeof requestIdleCallback === 'function') {
            primeIdleId = requestIdleCallback(() => {
                primeIdleId = null;
                primeAnalyticsWorkerNow();
            }, { timeout: 1500 });
            return;
        }

        primeTimerId = window.setTimeout(() => {
            primeTimerId = null;
            primeAnalyticsWorkerNow();
        }, 250);
    }

    /** Prime analytics worker immediately with pending payload when available. */
    function primeAnalyticsWorkerNow() {
        if (!worker || !pendingPrimePayload) {
            return;
        }
        const payload = pendingPrimePayload;
        pendingPrimePayload = null;
        lastPrimedSignature = payload.signature;

        worker.postMessage({
            type: 'restoreFiles',
            payload: { sharesCsv: payload.sharesCsv, commentsCsv: payload.commentsCsv }
        });
    }

    /** Clear all queued analytics prime timers and idle callbacks. */
    function clearPrimeSchedule() {
        if (primeTimerId) {
            window.clearTimeout(primeTimerId);
            primeTimerId = null;
        }
        if (primeIdleId && typeof cancelIdleCallback === 'function') {
            cancelIdleCallback(primeIdleId);
        }
        primeIdleId = null;
    }

    /**
     * Update the upload hint text and error state.
     * @param {string} message - Hint text
     * @param {boolean} isError - Whether the hint is an error
     */
    function setHint(message, isError) {
        elements.uploadHint.textContent = message;
        elements.uploadHint.classList.toggle('is-error', Boolean(isError));
    }

    /** Hide progress overlay when all active jobs complete. */
    function checkJobs() {
        if (activeJobs.size <= 0) {
            hideProgressOverlay();
        }
    }

    /**
     * Clear queued processing state and hide the overlay.
     */
    function resetProcessingState() {
        pendingFiles.clear();
        clearAllJobTimeouts();
        activeJobs.clear();
        hideProgressOverlay();
    }

    /**
     * Start a timeout watchdog for a worker job.
     * @param {string} jobId - Worker job id
     * @param {string} fileName - Uploaded file name
     */
    function scheduleJobTimeout(jobId, fileName) {
        clearJobTimeout(jobId);
        const timeoutId = window.setTimeout(() => {
            if (!activeJobs.has(jobId)) {
                return;
            }

            completeJob(jobId, fileName);
            setHint(`Processing took too long for ${fileName}. Please retry this file.`, true);
        }, JOB_TIMEOUT_MS);

        jobTimeouts.set(jobId, timeoutId);
    }

    /**
     * Clear watchdog timeout for a completed job.
     * @param {string|null} jobId - Worker job id
     */
    function clearJobTimeout(jobId) {
        if (!jobId || !jobTimeouts.has(jobId)) {
            return;
        }

        const timeoutId = jobTimeouts.get(jobId);
        if (timeoutId) {
            window.clearTimeout(timeoutId);
        }
        jobTimeouts.delete(jobId);
    }

    /** Clear all active job timeout watchdogs. */
    function clearAllJobTimeouts() {
        jobTimeouts.forEach(timeoutId => {
            window.clearTimeout(timeoutId);
        });
        jobTimeouts.clear();
    }

    /** Show the progress overlay and start animation. */
    function showProgressOverlay() {
        progressSessionId += 1;
        const sessionId = progressSessionId;
        elements.progressOverlay.hidden = false;
        progressValue = 0;
        drawProgressBar(progressValue);
        animateProgressTo(0.72, 650, () => {
            if (sessionId !== progressSessionId || activeJobs.size <= 0) {
                return;
            }
            startProgressCrawl(sessionId);
        }, sessionId);
    }

    /** Animate progress to 100% then hide the overlay. */
    function hideProgressOverlay() {
        if (elements.progressOverlay.hidden) {
            return;
        }
        const sessionId = progressSessionId;
        animateProgressTo(1, 320, () => {
            if (sessionId !== progressSessionId) {
                return;
            }
            elements.progressOverlay.hidden = true;
        }, sessionId);
    }

    /**
     * Smoothly animate progress bar to target value.
     * @param {number} target - Target progress value (0-1)
     * @param {number} duration - Animation duration in ms
     * @param {Function} [callback] - Optional callback when animation completes
     * @param {number} [sessionId] - Progress animation session token
     */
    function animateProgressTo(target, duration, callback, sessionId) {
        stopProgressAnimation();
        const start = performance.now();
        const startValue = progressValue;
        const animationSession = sessionId || progressSessionId;

        function step(now) {
            if (animationSession !== progressSessionId) {
                progressAnimationId = null;
                return;
            }
            const elapsed = now - start;
            const t = Math.min(elapsed / duration, 1);
            const eased = 1 - Math.pow(1 - t, 3);
            progressValue = startValue + (target - startValue) * eased;
            drawProgressBar(progressValue);
            if (t < 1) {
                progressAnimationId = requestAnimationFrame(step);
                return;
            }

            progressAnimationId = null;
            if (callback) {
                callback();
            }
        }

        progressAnimationId = requestAnimationFrame(step);
    }

    /** Stop any in-flight progress animation frame loop. */
    function stopProgressAnimation() {
        if (!progressAnimationId) {
            return;
        }
        cancelAnimationFrame(progressAnimationId);
        progressAnimationId = null;
    }

    /**
     * Slowly crawl progress toward completion while jobs are active.
     * @param {number} sessionId - Progress animation session token
     */
    function startProgressCrawl(sessionId) {
        stopProgressAnimation();
        const crawlCap = 0.985;
        let previousTime = 0;

        function crawl(now) {
            if (sessionId !== progressSessionId) {
                progressAnimationId = null;
                return;
            }

            if (activeJobs.size <= 0) {
                progressAnimationId = null;
                return;
            }

            if (!previousTime) {
                previousTime = now;
            }

            const deltaMs = Math.max(0, now - previousTime);
            previousTime = now;
            const remaining = Math.max(0, crawlCap - progressValue);

            if (remaining > 0.0005) {
                const normalizedRemaining = Math.min(1, remaining / 0.265);
                const unitsPerSecond = 0.007 + (0.06 * normalizedRemaining);
                const increment = (unitsPerSecond * deltaMs) / 1000;
                progressValue = Math.min(crawlCap, progressValue + increment);
                drawProgressBar(progressValue);
            }

            progressAnimationId = requestAnimationFrame(crawl);
        }

        progressAnimationId = requestAnimationFrame(crawl);
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
        const trackY = rect.height / 2 - 14;
        const trackWidth = rect.width - 16;
        const trackHeight = 28;

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

    return {
        init,
        onRouteChange
    };
})();
