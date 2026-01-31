/* Upload page logic */

(function() {
    'use strict';

    const elements = {
        dropZone: document.getElementById('multiDropZone'),
        fileInput: document.getElementById('multiFileInput'),
        sharesStatus: document.getElementById('sharesStatus'),
        commentsStatus: document.getElementById('commentsStatus'),
        uploadHint: document.getElementById('uploadHint'),
        openAnalyticsBtn: document.getElementById('openAnalyticsBtn'),
        clearAllBtn: document.getElementById('clearAllBtn'),
        fileStatusItems: {
            shares: document.querySelector('.file-status-item[data-file="shares"]'),
            comments: document.querySelector('.file-status-item[data-file="comments"]')
        },
        progressOverlay: document.getElementById('progressOverlay'),
        progressCanvas: document.getElementById('progressCanvas'),
        progressPercent: document.getElementById('progressPercent')
    };

    const WORKER_URL = 'js/analytics-worker.js?v=20260131-1';

    let worker = null;
    const pendingFiles = new Map();
    let activeJobs = 0;
    let progressValue = 0;
    let progressAnimationId = null;

    function init() {
        if (!elements.dropZone || !elements.fileInput) return;
        initWorker();
        bindEvents();
        restoreState();
    }

    function initWorker() {
        if (typeof Worker === 'undefined') return;
        try {
            worker = new Worker(WORKER_URL);
            worker.addEventListener('message', handleWorkerMessage);
            worker.addEventListener('error', handleWorkerError);
        } catch (error) {
            worker = null;
            setHint('This page must be opened from a local server (not file://). Start a server and reload.', true);
        }
    }

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
            updateStatus({ shares: null, comments: null, analyticsReady: false });
        });

        window.addEventListener('resize', () => drawProgressBar(progressValue));
    }

    async function restoreState() {
        const files = await Storage.getAllFiles();
        const analyticsBase = await Storage.getAnalytics();
        const shares = files.find(file => file.type === 'shares');
        const comments = files.find(file => file.type === 'comments');
        const analyticsReady = Boolean(analyticsBase && analyticsBase.events && analyticsBase.events.length);
        updateStatus({ shares, comments, analyticsReady });
    }

    function handleDragOver(event) {
        event.preventDefault();
        elements.dropZone.classList.add('drag-over');
    }

    function handleDragLeave(event) {
        event.preventDefault();
        elements.dropZone.classList.remove('drag-over');
    }

    function handleDrop(event) {
        event.preventDefault();
        elements.dropZone.classList.remove('drag-over');
        const files = Array.from(event.dataTransfer?.files || []);
        if (files.length) {
            processFiles(files);
        }
    }

    function handleFileInput(event) {
        const files = Array.from(event.target.files || []);
        if (files.length) {
            processFiles(files);
        }
        event.target.value = '';
    }

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
            readFileAsText(file)
                .then(text => {
                    pendingFiles.set(file.name, text);
                    worker.postMessage({
                        type: 'addFile',
                        payload: { csvText: text, fileName: file.name }
                    });
                })
                .catch(() => {
                    activeJobs -= 1;
                    setHint('Error reading file. Please try again.', true);
                    checkJobs();
                });
        });
    }

    function readFileAsText(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
            reader.onerror = () => reject(new Error('Error reading file'));
            reader.readAsText(file);
        });
    }

    async function handleWorkerMessage(event) {
        const message = event.data || {};
        if (message.type === 'fileProcessed') {
            const payload = message.payload || {};
            const fileType = payload.fileType;
            const fileName = payload.fileName;
            const rowCount = payload.rowCount || 0;

            if (!fileType) {
                setHint(payload.error || 'File could not be processed.', true);
                activeJobs -= 1;
                checkJobs();
                return;
            }

            const text = pendingFiles.get(fileName) || '';
            pendingFiles.delete(fileName);
            await Storage.saveFile(fileType, { name: fileName, text, rowCount });

            if (payload.analyticsBase) {
                await Storage.saveAnalytics(payload.analyticsBase);
            }

            const files = await Storage.getAllFiles();
            const shares = files.find(file => file.type === 'shares');
            const comments = files.find(file => file.type === 'comments');
            updateStatus({
                shares,
                comments,
                analyticsReady: Boolean(payload.hasData)
            });

            setHint('File loaded successfully.', false);
            activeJobs -= 1;
            checkJobs();
        }

        if (message.type === 'error') {
            setHint(message.payload && message.payload.message ? message.payload.message : 'Worker error.', true);
            activeJobs -= 1;
            checkJobs();
        }
    }

    function handleWorkerError() {
        setHint('Analytics worker error. Try refreshing.', true);
        activeJobs = 0;
        hideProgressOverlay();
    }

    function updateStatus({ shares, comments, analyticsReady }) {
        if (shares) {
            elements.fileStatusItems.shares.classList.add('is-ready');
            elements.sharesStatus.textContent = `${shares.rowCount} rows loaded`;
        } else {
            elements.fileStatusItems.shares.classList.remove('is-ready');
            elements.sharesStatus.textContent = 'Not uploaded';
        }

        if (comments) {
            elements.fileStatusItems.comments.classList.add('is-ready');
            elements.commentsStatus.textContent = `${comments.rowCount} rows loaded`;
        } else {
            elements.fileStatusItems.comments.classList.remove('is-ready');
            elements.commentsStatus.textContent = 'Not uploaded';
        }

        const hasAny = Boolean(shares || comments);
        elements.openAnalyticsBtn.disabled = !hasAny || !analyticsReady;
        if (!hasAny) {
            setHint('Upload at least one file to start.', false);
        } else if (!analyticsReady) {
            setHint('Processing analytics in the background.', false);
        } else {
            setHint('Analytics are ready. Open the dashboard.', false);
        }
    }

    function setHint(message, isError) {
        elements.uploadHint.textContent = message;
        elements.uploadHint.classList.toggle('is-error', Boolean(isError));
    }

    function checkJobs() {
        if (activeJobs <= 0) {
            hideProgressOverlay();
        }
    }

    function showProgressOverlay() {
        elements.progressOverlay.hidden = false;
        progressValue = 0;
        drawProgressBar(progressValue);
        animateProgressTo(0.85, 900);
    }

    function hideProgressOverlay() {
        animateProgressTo(1, 300, () => {
            elements.progressOverlay.hidden = true;
        });
    }

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
