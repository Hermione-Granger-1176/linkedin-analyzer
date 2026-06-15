/* Upload page logic */

import rough from "roughjs/bundled/rough.esm.js";

import { MAX_CSV_CHARS, SESSION_CLEANUP_PROMISE_KEY } from "./constants.js";
import { DataCache } from "./data-cache.js";
import { AppRouter } from "./router.js";
import { captureError } from "./sentry.js";
import { Session } from "./session.js";
import { Storage } from "./storage.js";
import {
    parseAnalyticsWorkerMessage,
    parseStoredUploadFile,
    toStoredFileMetadata,
} from "./worker-contracts.js";

export const UploadPage = (() => {
    "use strict";

    const TRACKED_TYPES = Object.freeze(["shares", "comments", "messages", "connections"]);
    const TRACKED_TYPES_SET = new Set(TRACKED_TYPES);
    const UPLOAD_HINT_BY_STATE = Object.freeze({
        "0-0-0": "Upload at least one file to start.",
        "0-0-1": "Upload at least one file to start.",
        "0-1-0": "Upload at least one file to start.",
        "0-1-1": "Upload at least one file to start.",
        "1-1-0": "Processing analytics in the background.",
        "1-1-1": "Analytics are ready. Open the dashboard.",
        "1-0-0": "Files loaded. Open Messages tab for conversation insights.",
        "1-0-1": "Files loaded. Open Messages tab for conversation insights.",
    });

    const elements = {
        dropZone: document.getElementById("multiDropZone"),
        fileInput: document.getElementById("multiFileInput"),
        sharesStatus: document.getElementById("sharesStatus"),
        commentsStatus: document.getElementById("commentsStatus"),
        messagesStatus: document.getElementById("messagesStatus"),
        connectionsStatus: document.getElementById("connectionsStatus"),
        uploadHint: document.getElementById("uploadHint"),
        openAnalyticsBtn: /** @type {HTMLButtonElement|null} */ (
            document.getElementById("openAnalyticsBtn")
        ),
        clearAllBtn: document.getElementById("clearAllBtn"),
        fileStatusItems: {
            shares: document.querySelector('.file-status-item[data-file="shares"]'),
            comments: document.querySelector('.file-status-item[data-file="comments"]'),
            messages: document.querySelector('.file-status-item[data-file="messages"]'),
            connections: document.querySelector('.file-status-item[data-file="connections"]'),
        },
        progressOverlay: document.getElementById("progressOverlay"),
        progressCanvas: /** @type {HTMLCanvasElement|null} */ (
            document.getElementById("progressCanvas")
        ),
        progressPercent: document.getElementById("progressPercent"),
        offlineBanner: document.getElementById("offlineBanner"),
    };

    const STATUS_ITEMS = Object.freeze([
        { type: "shares", item: elements.fileStatusItems.shares, label: elements.sharesStatus },
        {
            type: "comments",
            item: elements.fileStatusItems.comments,
            label: elements.commentsStatus,
        },
        {
            type: "messages",
            item: elements.fileStatusItems.messages,
            label: elements.messagesStatus,
        },
        {
            type: "connections",
            item: elements.fileStatusItems.connections,
            label: elements.connectionsStatus,
        },
    ]);

    const JOB_TIMEOUT_MS = 45000;
    const LARGE_FILE_WARNING_BYTES = 25 * 1024 * 1024;
    const MAX_FILE_BYTES = 80 * 1024 * 1024;
    const FILE_READ_TIMEOUT_MS = 30000;
    const STREAMING_READ_THRESHOLD_BYTES = 5 * 1024 * 1024;

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
    let primeInFlight = null;
    let lastProgressPercent = 0;
    let storagePersistenceRequested = false;
    // Restart throttle: at most MAX_WORKER_RESTARTS within WORKER_RESTART_WINDOW_MS.
    const MAX_WORKER_RESTARTS = 3;
    const WORKER_RESTART_WINDOW_MS = 10000;
    let workerRestartTimes = [];

    /** Initialize the upload page. */
    function init() {
        if (initialized) {
            return;
        }
        if (!elements.dropZone || !elements.fileInput) {
            return;
        }
        initialized = true;

        if (!Storage.isAvailable && elements.uploadHint) {
            elements.uploadHint.textContent =
                "Browser storage is unavailable. Uploads will not persist across sessions.";
        }
        // Surface the same warning if storage works at load but fails mid-session
        // (private mode, corruption) and Storage transparently degrades to memory.
        Storage.onPersistenceLost(() => {
            setHint("Browser storage stopped working. Uploads won't persist across sessions.", false);
        });

        initWorker();
        bindEvents();
        requestPersistentStorage();
        restoreState();
    }

    /** Request persistent browser storage when supported. */
    function requestPersistentStorage() {
        if (storagePersistenceRequested) {
            return;
        }
        storagePersistenceRequested = true;

        if (!navigator.storage || typeof navigator.storage.persist !== "function") {
            return;
        }

        navigator.storage
            .persist()
            .then((isPersisted) => {
                DataCache.set("storage:persisted", Boolean(isPersisted));
            })
            .catch((error) => {
                captureError(error, {
                    module: "upload",
                    operation: "storage-persist-request",
                });
            });
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

    /** Remove listeners from and terminate the current worker, if any. */
    function teardownWorker() {
        if (worker) {
            worker.removeEventListener("message", handleWorkerMessage);
            worker.removeEventListener("error", handleWorkerError);
            worker.removeEventListener("messageerror", handleWorkerError);
            worker.terminate();
            worker = null;
        }
    }

    /** Tear down the current worker and spin up a fresh one so later uploads recover. */
    function restartWorker() {
        teardownWorker();
        // A fresh worker has no in-memory primed state, so clear the prime tracking
        // (otherwise an unchanged signature would skip re-priming and leave analytics stale).
        clearPrimeSchedule();
        pendingPrimePayload = null;
        lastPrimedSignature = null;
        initWorker();
        // Re-prime the new worker from cached files so analytics stay accurate after a crash.
        if (worker) {
            const cachedFiles = DataCache.get("storage:files");
            if (cachedFiles) {
                scheduleAnalyticsWorkerPrime(getFileMap(cachedFiles), { priority: "idle" });
            }
        }
    }

    /** Create the analytics Web Worker. */
    function initWorker() {
        if (typeof Worker === "undefined") {
            return;
        }
        try {
            worker = new Worker(new URL("./analytics-worker.js", import.meta.url), {
                type: "module",
            });
            worker.addEventListener("message", handleWorkerMessage);
            worker.addEventListener("error", handleWorkerError);
            worker.addEventListener("messageerror", handleWorkerError);
        } catch (error) {
            worker = null;
            captureError(error, {
                module: "upload",
                operation: "init-worker",
            });
            setHint(
                "This page must be opened from a local server (not file://). Start a server and reload.",
                true,
            );
        }
    }

    /** Attach event listeners for drag/drop, file input, and buttons. */
    function bindEvents() {
        elements.dropZone.addEventListener("click", () => elements.fileInput.click());
        elements.dropZone.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                elements.fileInput.click();
            }
        });
        elements.fileInput.addEventListener("change", handleFileInput);
        elements.dropZone.addEventListener("dragover", handleDragOver);
        elements.dropZone.addEventListener("dragleave", handleDragLeave);
        elements.dropZone.addEventListener("drop", handleDrop);

        window.addEventListener("dragover", (event) => event.preventDefault());
        window.addEventListener("drop", (event) => event.preventDefault());

        elements.openAnalyticsBtn.addEventListener("click", () => {
            if (elements.openAnalyticsBtn.disabled) {
                return;
            }

            AppRouter.navigate("analytics", undefined, { replaceHistory: false });
        });

        elements.clearAllBtn.addEventListener("click", async () => {
            try {
                await Storage.clearAll();
                clearPrimeSchedule();
                pendingPrimePayload = null;
                if (worker) {
                    worker.postMessage({ type: "clear" });
                }
                DataCache.clear();
                DataCache.notify({ type: "storageCleared" });
                lastPrimedSignature = null;
                resetProcessingState();
                updateStatus({ fileMap: createEmptyFileMap(), analyticsReady: false });
            } catch (error) {
                captureError(error, {
                    module: "upload",
                    operation: "clear-all",
                });
                setHint("Unable to clear stored data. Please try again.", true);
            }
        });

        window.addEventListener("resize", () => drawProgressBar(progressValue));
        window.addEventListener("online", updateOfflineBanner);
        window.addEventListener("offline", updateOfflineBanner);
    }

    /**
     * Restore upload status from IndexedDB and refresh the file cache on load.
     * Does not prime the worker — that is deferred to the first upload (see
     * processFiles); the dashboard reads the persisted analyticsBase directly.
     * @returns {Promise<void>}
     */
    async function restoreState() {
        if (restorePromise) {
            await restorePromise;
            return;
        }

        restorePromise = (async () => {
            await waitForSessionCleanup();
            updateOfflineBanner();
            const files = await Storage.getAllFiles();
            const fileMap = getFileMap(files);
            DataCache.set("storage:files", files.map(toStoredFileMetadata));
            // Intentionally do NOT prime the worker on load: the dashboard reads
            // the persisted analyticsBase directly and never needs the worker's
            // raw shares/comments. Only a fresh upload (which recomputes the base)
            // does, so priming is deferred to processFiles() — saving a redundant
            // re-parse of shares+comments on every page load.
            const analyticsReady = await hasAnalyticsData();
            updateStatus({ fileMap, analyticsReady });
            // If a stale 24h session was just wiped, tell the user once rather than
            // letting their previously-uploaded files silently disappear.
            if (Session.consumeExpiryNotice()) {
                setHint(
                    "Your saved data expired after 24 hours and was cleared for privacy. Re-upload to continue.",
                    false,
                );
            }
        })();

        try {
            await restorePromise;
        } catch (error) {
            captureError(error, {
                module: "upload",
                operation: "restore-state",
            });
            setHint("Unable to restore saved files. Please re-upload.", true);
        } finally {
            restorePromise = null;
            restoredOnce = true;
        }

        return;
    }

    /**
     * Wait for non-blocking session cleanup to finish when present.
     * @returns {Promise<void>}
     */
    async function waitForSessionCleanup() {
        const cleanupPromise = window[SESSION_CLEANUP_PROMISE_KEY];
        if (!cleanupPromise || typeof cleanupPromise.then !== "function") {
            return;
        }
        try {
            await cleanupPromise;
        } catch (error) {
            captureError(error, {
                module: "upload",
                operation: "wait-session-cleanup",
            });
            return;
        }
    }

    /** Update offline banner visibility based on navigator state. */
    function updateOfflineBanner() {
        if (!elements.offlineBanner) {
            return;
        }
        const isOffline = typeof navigator !== "undefined" && navigator.onLine === false;
        elements.offlineBanner.hidden = !isOffline;
    }

    /** Sync upload status from cache when available, otherwise restore from storage. */
    function syncStatusFromCache() {
        const files = DataCache.get("storage:files");
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
        elements.dropZone.classList.add("drag-over");
    }

    /**
     * Handle dragleave to remove drop zone highlight.
     * @param {DragEvent} event - Dragleave event
     */
    function handleDragLeave(event) {
        event.preventDefault();
        elements.dropZone.classList.remove("drag-over");
    }

    /**
     * Handle file drop event.
     * @param {DragEvent} event - Drop event
     */
    function handleDrop(event) {
        event.preventDefault();
        elements.dropZone.classList.remove("drag-over");
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
        const input = /** @type {HTMLInputElement} */ (event.target);
        const files = Array.from(input.files || []);
        if (files.length) {
            processFiles(files);
        }
        input.value = "";
    }

    /**
     * Read CSV files and send them to the worker for processing.
     * @param {File[]} files - Selected files
     * @returns {Promise<void>}
     */
    async function processFiles(files) {
        const csvFiles = files.filter((file) => file.name.toLowerCase().endsWith(".csv"));
        if (!csvFiles.length) {
            setHint("Please upload CSV files.", true);
            return;
        }

        const tooLargeFiles = csvFiles.filter((file) => file.size > MAX_FILE_BYTES);
        if (tooLargeFiles.length) {
            const maxMb = Math.round(MAX_FILE_BYTES / (1024 * 1024));
            setHint(`Some files exceed ${maxMb}MB and were skipped.`, true);
        }

        const acceptedFiles = csvFiles.filter((file) => file.size <= MAX_FILE_BYTES);
        if (!acceptedFiles.length) {
            return;
        }

        const oversizeFiles = acceptedFiles.filter((file) => file.size > LARGE_FILE_WARNING_BYTES);
        if (oversizeFiles.length) {
            setHint("Some files are large (25MB+). Processing may take longer than usual.", false);
        }
        if (!worker) {
            setHint("Workers are unavailable. Open this page from a local server.", true);
            return;
        }
        const incomingBytes = acceptedFiles.reduce((sum, file) => sum + file.size, 0);
        warnIfStorageLow(incomingBytes);

        if (activeJobs.size === 0) {
            showProgressOverlay();
        }
        // Seed the worker with any already-stored shares/comments before sending
        // the new file(s), so an added shares/comments file recomputes analytics
        // from the full set rather than from the new file alone. Awaiting here
        // guarantees the restoreFiles is queued before the addFile messages below
        // (worker messages are FIFO), even when an upload races ahead of the
        // not-yet-awaited restoreState() on load.
        try {
            await primeWorkerFromStoredFiles();
        } catch (error) {
            // Priming is best-effort; a storage read failure must not block the upload.
            captureError(error, { module: "upload", operation: "prime-before-upload" });
        }
        acceptedFiles.forEach((file) => {
            const jobId = createJobId(file);
            activeJobs.add(jobId);
            scheduleJobTimeout(jobId, file.name);
            readFileAsText(file)
                .then(({ text, usedFallback }) => {
                    pendingFiles.set(jobId, { text, fileName: file.name, usedFallback });
                    worker.postMessage({
                        type: "addFile",
                        payload: {
                            csvText: text,
                            fileName: file.name,
                            jobId,
                            totalSize: file.size,
                        },
                    });
                })
                .catch((error) => {
                    captureError(error, {
                        module: "upload",
                        operation: "read-file",
                        fileName: file.name,
                        fileSize: file.size,
                    });
                    completeJob(jobId, file.name);
                    setHint(
                        error && error.message
                            ? error.message
                            : "Error reading file. Please try again.",
                        true,
                    );
                });
        });
    }

    /**
     * Estimate storage and warn if space may be too low for the incoming files.
     * @param {number} [incomingBytes] - Total size of the files about to be stored
     */
    function warnIfStorageLow(incomingBytes = 0) {
        if (!navigator.storage || typeof navigator.storage.estimate !== "function") {
            return;
        }
        navigator.storage
            .estimate()
            .then((estimate) => {
                if (
                    !estimate ||
                    typeof estimate.quota !== "number" ||
                    typeof estimate.usage !== "number"
                ) {
                    return;
                }
                const remaining = estimate.quota - estimate.usage;
                // Scale the threshold to the incoming data (IndexedDB transiently
                // holds the text twice during a put), but keep a 20MB floor so a
                // nearly-full quota still warns even for small uploads.
                const threshold = Math.max(incomingBytes * 2, 20 * 1024 * 1024);
                if (remaining < threshold) {
                    setHint(
                        "Storage is running low. Consider clearing data after exporting.",
                        false,
                    );
                }
            })
            .catch(() => {
                captureError(new Error("Failed to estimate browser storage quota."), {
                    module: "upload",
                    operation: "storage-estimate",
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
     * Read a File object as text, decoding as UTF-8 and falling back to
     * windows-1252 for non-UTF-8 exports (mirrors the CLI's latin-1 fallback).
     * @param {File} file - Uploaded file
     * @returns {Promise<{text: string, usedFallback: boolean}>}
     */
    function readFileAsText(file) {
        if (file.size > MAX_FILE_BYTES) {
            const maxMb = Math.round(MAX_FILE_BYTES / (1024 * 1024));
            return Promise.reject(new Error(`"${file.name}" exceeds the ${maxMb}MB upload limit.`));
        }

        const useStreamingRead =
            file.size >= STREAMING_READ_THRESHOLD_BYTES &&
            typeof file.stream === "function" &&
            typeof TextDecoder !== "undefined" &&
            typeof ReadableStream !== "undefined";

        if (useStreamingRead) {
            return readFileAsTextStream(file);
        }

        return readFileAsTextWithReader(file);
    }

    /**
     * Decode raw file bytes to text. Validates UTF-8 strictly (fatal) and only
     * falls back to windows-1252 on a genuine decode error — mirroring the CLI's
     * latin-1 retry and avoiding false positives on files that legitimately
     * contain U+FFFD. Enforces the character limit after decoding.
     * @param {Uint8Array} bytes - Raw file bytes
     * @param {string} fileName - Original file name, used in error messages
     * @returns {{text: string, usedFallback: boolean}}
     */
    function decodeBytes(bytes, fileName) {
        if (typeof TextDecoder === "undefined") {
            // The streaming path already routes around a missing TextDecoder; the
            // FileReader path lands here, so fail with a clear, user-facing error
            // instead of a bare ReferenceError from `new TextDecoder(...)`.
            throw new Error(
                `Cannot read "${fileName}": your browser is missing required text-decoding support. Please use a newer browser.`,
            );
        }
        let text;
        let usedFallback = false;
        try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
            text = new TextDecoder("windows-1252").decode(bytes);
            usedFallback = true;
        }
        if (text.length > MAX_CSV_CHARS) {
            const maxMb = Math.round(MAX_CSV_CHARS / (1024 * 1024));
            throw new Error(`"${fileName}" exceeds the ${maxMb}MB text limit.`);
        }
        return { text, usedFallback };
    }

    /**
     * Read a File as text via FileReader, decoding the raw bytes so UTF-8
     * validity is checked directly rather than inferred from the output.
     * @param {File} file - Uploaded file
     * @returns {Promise<{text: string, usedFallback: boolean}>}
     */
    function readFileAsTextWithReader(file) {
        return readBytesWithReader(file).then((bytes) => decodeBytes(bytes, file.name));
    }

    /**
     * Read a File's raw bytes via FileReader, with timeout and error guards.
     * @param {File} file - Uploaded file
     * @returns {Promise<Uint8Array>}
     */
    function readBytesWithReader(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            let settled = false;
            const timeoutId = window.setTimeout(() => {
                try {
                    reader.abort();
                } catch {
                    /* v8 ignore next */
                    // Ignore abort failures and continue timeout handling.
                }
                finish(() => reject(new Error(`Reading ${file.name} timed out.`)));
            }, FILE_READ_TIMEOUT_MS);

            const finish = (callback) => {
                if (settled) {
                    return;
                }
                settled = true;
                window.clearTimeout(timeoutId);
                callback();
            };

            reader.onload = () => {
                /* v8 ignore next */
                if (settled) {
                    return;
                }
                // Duck-type for an ArrayBuffer (avoids cross-realm instanceof
                // pitfalls): a successful read yields a byte buffer, so anything
                // without a numeric byteLength is an unexpected/failed read and is
                // surfaced as an error rather than a silently empty file.
                const buffer = /** @type {ArrayBuffer} */ (reader.result);
                if (!buffer || typeof buffer.byteLength !== "number") {
                    finish(() => reject(new Error("Error reading file")));
                    return;
                }
                finish(() => resolve(new Uint8Array(buffer)));
            };
            reader.onerror = () => {
                finish(() => reject(new Error("Error reading file")));
            };
            reader.readAsArrayBuffer(file);
        });
    }

    /**
     * Read file text via stream chunks for large uploads, decoding as UTF-8 and
     * falling back to windows-1252 when the bytes are not valid UTF-8.
     * @param {File} file - Uploaded file
     * @returns {Promise<{text: string, usedFallback: boolean}>}
     */
    async function readFileAsTextStream(file) {
        const reader = file.stream().getReader();
        const chunks = [];
        let totalBytes = 0;
        let timedOut = false;

        const timeoutId = window.setTimeout(() => {
            timedOut = true;
            /* v8 ignore next */
            reader.cancel().catch(() => {
                // Ignore cancellation failures after timeout.
            });
        }, FILE_READ_TIMEOUT_MS);

        try {
            for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
                if (timedOut) {
                    throw new Error(`Reading ${file.name} timed out.`);
                }

                chunks.push(chunk.value);
                totalBytes += chunk.value.byteLength;
            }

            if (timedOut) {
                throw new Error(`Reading ${file.name} timed out.`);
            }
        } finally {
            window.clearTimeout(timeoutId);
        }

        // Both read paths share decodeBytes: strict UTF-8 validation with a
        // windows-1252 fallback and the character-count limit applied after
        // decoding. Peak memory stays bounded by the upstream MAX_FILE_BYTES cap.
        return decodeBytes(concatChunks(chunks, totalBytes), file.name);
    }

    /**
     * Concatenate decoded stream chunks into a single byte array.
     * @param {Uint8Array[]} chunks - Collected stream chunks
     * @param {number} totalBytes - Sum of all chunk byte lengths
     * @returns {Uint8Array}
     */
    function concatChunks(chunks, totalBytes) {
        const bytes = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return bytes;
    }

    /**
     * Handle messages from the analytics worker.
     * @param {MessageEvent} event - Worker message event
     */
    async function handleWorkerMessage(event) {
        const parsed = parseAnalyticsWorkerMessage(event.data || {});
        if (!parsed.valid) {
            captureError(new Error(parsed.error || "Invalid analytics worker payload."), {
                module: "upload",
                operation: "worker-message-parse",
            });
            setHint("Unexpected worker response. Please retry the upload.", true);
            return;
        }

        const message = parsed.value;
        switch (message.type) {
            case "restored":
                return;
            case "fileProcessed":
                await handleFileProcessedMessage(message.payload || {});
                return;
            case "progress":
                handleProgressMessage(message.payload || {});
                return;
            case "error": {
                const payload = message.payload || {};
                const errorMessage = payload.message || "Worker error.";
                setHint(errorMessage, true);
                captureError(new Error(errorMessage), {
                    module: "upload",
                    operation: "worker-error-payload",
                    jobId: payload.jobId || null,
                    fileName: payload.fileName || null,
                });
                // A payload-level error reports a single failed job. Complete just
                // that job (falling back to the first active one) instead of
                // resetting every in-flight upload — only a worker-level `error`
                // event (handleWorkerError) wipes all processing state.
                completeJob(payload.jobId || null, payload.fileName || "");
                return;
            }
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
            setHint(payload.error || "File could not be processed.", true);
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
            setHint(
                pending.usedFallback
                    ? "File loaded, but some characters weren't valid UTF-8 and were decoded with a fallback — double-check accented names."
                    : "File loaded successfully.",
                false,
            );
            if (fileType === "shares" || fileType === "comments") {
                scheduleAnalyticsWorkerPrime(fileMap, { priority: "immediate" });
            }
        } catch (error) {
            captureError(error, {
                module: "upload",
                operation: "persist-processed-file",
                fileType,
                fileName,
            });
            if (isQuotaExceededError(error)) {
                setHint(
                    "Storage is full. Clear saved data or free up space, then try again.",
                    true,
                );
            } else {
                setHint("Error saving file data. Please try again.", true);
            }
        } finally {
            completeJob(jobId, fileName);
        }
    }

    /**
     * Detect a storage quota error, walking the `cause` chain since Storage wraps
     * the native DOMException inside a descriptive Error.
     * @param {unknown} error - The caught error
     * @returns {boolean}
     */
    function isQuotaExceededError(error) {
        let current = error;
        for (let depth = 0; current && depth < 10; depth += 1) {
            const candidate = /** @type {{name?: string, code?: number, cause?: unknown}} */ (
                current
            );
            if (
                candidate.name === "QuotaExceededError" ||
                candidate.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
                candidate.code === 22
            ) {
                return true;
            }
            current = candidate.cause;
        }
        return false;
    }

    /**
     * Handle incremental worker progress updates.
     * @param {{jobId?: string|null, percent?: number}} payload - Progress payload
     */
    function handleProgressMessage(payload) {
        if (!payload || typeof payload.percent !== "number") {
            return;
        }
        if (activeJobs.size === 0) {
            return;
        }
        const normalized = Math.max(0, Math.min(1, payload.percent));
        const capped = Math.min(0.98, Math.max(progressValue, normalized * 0.98));
        progressValue = capped;
        if (Math.abs(normalized - lastProgressPercent) >= 0.02) {
            lastProgressPercent = normalized;
        }
        drawProgressBar(progressValue);
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
        DataCache.invalidate("storage:");
        DataCache.invalidate("clean:");
        DataCache.invalidate("messages:");

        const files = await Storage.getAllFiles();
        DataCache.set("storage:files", files.map(toStoredFileMetadata));
        syncTypeSpecificFileCache(fileType, files);

        if (analyticsBase) {
            DataCache.set("storage:analyticsBase", analyticsBase);
        }

        DataCache.notify({ type: "filesChanged", fileType });
        if (analyticsBase) {
            DataCache.notify({ type: "analyticsChanged" });
        }
    }

    /**
     * Sync type-specific file cache entries.
     * @param {string} fileType - Processed file type
     * @param {object[]} files - Stored files snapshot
     */
    function syncTypeSpecificFileCache(fileType, files) {
        const key = getTypeSpecificFileCacheKey(fileType);
        if (!key) {
            return;
        }

        const match = files.find((file) => file.type === fileType) || null;
        if (!match) {
            return;
        }

        // Cache metadata only; the messages/connections text is loaded on demand.
        DataCache.set(key, toStoredFileMetadata(match));
    }

    /**
     * Resolve per-file cache key for messages/connections datasets.
     * @param {string} fileType - Processed file type
     * @returns {string|null}
     */
    function getTypeSpecificFileCacheKey(fileType) {
        switch (fileType) {
            case "messages":
                return "storage:file:messages";
            case "connections":
                return "storage:file:connections";
            default:
                return null;
        }
    }

    /**
     * Read files from cache when available, otherwise from storage.
     * @returns {Promise<object[]>}
     */
    async function getStoredFilesSnapshot() {
        const files = DataCache.get("storage:files");
        if (files) {
            return files;
        }
        return Storage.getAllFiles();
    }

    /**
     * Consume a pending upload entry for a processed worker job.
     * @param {string|null} jobId - Worker job ID
     * @param {string} fileName - Original file name
     * @returns {{text: string, fileName: string, usedFallback?: boolean}|null}
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

    /**
     * Handle worker-level errors.
     * @param {ErrorEvent|MessageEvent} event - Worker error or messageerror event
     */
    function handleWorkerError(event) {
        const workerError =
            event && "error" in event && event.error
                ? event.error
                : new Error(`Analytics worker ${event && event.type ? event.type : "error"} event`);
        captureError(workerError, {
            module: "upload",
            operation: "worker-error-event",
        });
        resetProcessingState();

        // Throttle restarts: a worker that fails on startup (e.g. a script load error)
        // would otherwise restart-and-fail in a tight loop. Give up after too many
        // failures in a short window and ask the user to reload instead.
        const now = Date.now();
        workerRestartTimes = workerRestartTimes.filter(
            (time) => now - time < WORKER_RESTART_WINDOW_MS,
        );
        if (workerRestartTimes.length >= MAX_WORKER_RESTARTS) {
            teardownWorker();
            setHint("Analytics worker keeps failing. Please reload the page to retry.", true);
            return;
        }
        workerRestartTimes.push(now);

        setHint("Analytics worker error. Please retry the upload.", true);
        restartWorker();
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
        const normalizedJobId = typeof jobId === "string" && jobId ? jobId : null;
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
        const normalizedFileName = String(fileName || "");
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
            statusItem.classList.add("is-ready");
            statusLabel.textContent = `${fileData.rowCount} rows loaded`;
        } else {
            statusItem.classList.remove("is-ready");
            statusLabel.textContent = "Not uploaded";
        }
    }

    /**
     * Update the upload page UI to reflect current file and analytics state.
     * @param {{fileMap: {[key: string]: object|null}, analyticsReady: boolean}} status
     */
    function updateStatus({ fileMap, analyticsReady }) {
        STATUS_ITEMS.forEach(({ type, item, label }) => {
            updateFileStatus(/** @type {HTMLElement} */ (item), label, fileMap[type]);
        });

        const hasAny = TRACKED_TYPES.some((type) => Boolean(fileMap[type]));
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
        return (
            UPLOAD_HINT_BY_STATE[stateKey] ||
            "Files loaded. Open Messages tab for conversation insights."
        );
    }

    /**
     * Build a fixed file map for all tracked types.
     * @param {object[]} files - Stored file records
     * @returns {{shares: object|null, comments: object|null, messages: object|null, connections: object|null}}
     */
    function getFileMap(files) {
        const map = createEmptyFileMap();
        files.forEach((file) => {
            const parsed = parseStoredUploadFile(file);
            if (!parsed.valid) {
                captureError(new Error(parsed.error || "Invalid stored upload file record."), {
                    module: "upload",
                    operation: "parse-stored-file-map",
                });
                return;
            }

            const normalized = parsed.value;
            if (TRACKED_TYPES_SET.has(normalized.type)) {
                map[normalized.type] = normalized;
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
            connections: null,
        };
    }

    /**
     * Check whether analytics aggregates are available in storage.
     * @returns {Promise<boolean>}
     */
    async function hasAnalyticsData() {
        let analyticsBase = DataCache.get("storage:analyticsBase") || null;
        if (!analyticsBase) {
            analyticsBase = await Storage.getAnalytics();
            DataCache.set("storage:analyticsBase", analyticsBase);
        }
        return hasAnalyticsMonths(analyticsBase);
    }

    /**
     * Read analytics-ready state from cache only.
     * @returns {boolean|null}
     */
    function getAnalyticsReadyFromCache() {
        const analyticsBase = DataCache.get("storage:analyticsBase") || null;
        if (!analyticsBase) {
            return null;
        }
        return hasAnalyticsMonths(analyticsBase);
    }

    /**
     * Check whether analytics base contains at least one month bucket.
     * @param {object|null} analyticsBase - Analytics aggregate base
     * @returns {boolean}
     */
    function hasAnalyticsMonths(analyticsBase) {
        return Boolean(
            analyticsBase && analyticsBase.months && Object.keys(analyticsBase.months).length,
        );
    }

    /**
     * Prime the worker with stored shares/comments before an upload so a new
     * analytics file recomputes from the full set (a no-op via signature dedup
     * when already primed). Reads the cached file snapshot, falling back to
     * storage when the cache isn't populated yet — `restoreState()` is fired but
     * not awaited in init(), so a fast upload can race ahead of it; loading here
     * guarantees the prior shares/comments are seeded before the new addFile.
     * @returns {Promise<void>}
     */
    async function primeWorkerFromStoredFiles() {
        let cachedFiles = DataCache.get("storage:files");
        if (!cachedFiles) {
            const files = await Storage.getAllFiles();
            cachedFiles = files.map(toStoredFileMetadata);
            DataCache.set("storage:files", cachedFiles);
        }
        // Await the prime so its restoreFiles is posted (after loading the text
        // from storage) before processFiles posts any addFile — preserving the
        // "recompute from the full set" guarantee now that priming is async.
        await scheduleAnalyticsWorkerPrime(getFileMap(cachedFiles), { priority: "immediate" });
    }

    /**
     * Seed worker with existing shares/comments datasets for accurate recompute.
     * Decides whether to prime from file metadata (presence + a row/updatedAt
     * signature); the CSV text itself is loaded from storage only when the prime
     * actually fires (see primeAnalyticsWorkerNow). Uses idle scheduling unless
     * priority is immediate, in which case it returns the prime promise so callers
     * can await the restoreFiles being posted.
     * @param {{shares: object|null, comments: object|null, connections?: object|null}} fileMap - Stored files map
     * @param {{priority?: 'idle'|'immediate'}} [options] - Scheduling options
     * @returns {Promise<void>|void}
     */
    function scheduleAnalyticsWorkerPrime(fileMap, options) {
        if (!worker) {
            return undefined;
        }

        const sharesFile = fileMap.shares || null;
        const commentsFile = fileMap.comments || null;
        if (!sharesFile && !commentsFile) {
            lastPrimedSignature = null;
            pendingPrimePayload = null;
            clearPrimeSchedule();
            return undefined;
        }

        const connectionsFile = fileMap.connections || null;
        const sharesStamp = sharesFile
            ? `${sharesFile.updatedAt || 0}:${sharesFile.rowCount || 0}`
            : "-";
        const commentsStamp = commentsFile
            ? `${commentsFile.updatedAt || 0}:${commentsFile.rowCount || 0}`
            : "-";
        // Connections feeds the network-growth correlation, so a connections-only
        // change must still invalidate the signature and force a re-prime.
        const connectionsStamp = connectionsFile
            ? `${connectionsFile.updatedAt || 0}:${connectionsFile.rowCount || 0}`
            : "-";
        const signature = `${sharesStamp}|${commentsStamp}|${connectionsStamp}`;
        if (signature === lastPrimedSignature) {
            pendingPrimePayload = null;
            clearPrimeSchedule();
            return undefined;
        }

        pendingPrimePayload = { signature };
        const priority = options && options.priority ? options.priority : "idle";
        if (priority === "immediate") {
            clearPrimeSchedule();
            return primeAnalyticsWorkerNow();
        }

        // Cancel any in-flight idle/timeout prime before scheduling a fresh one so a
        // repeated idle request can never leak a timer (the sole idle caller,
        // restartWorker, already clears, but this keeps scheduling self-contained).
        clearPrimeSchedule();

        if (typeof requestIdleCallback === "function") {
            primeIdleId = requestIdleCallback(
                () => {
                    primeIdleId = null;
                    primeAnalyticsWorkerNow();
                },
                { timeout: 1500 },
            );
            return undefined;
        }

        primeTimerId = window.setTimeout(() => {
            primeTimerId = null;
            primeAnalyticsWorkerNow();
        }, 250);
        return undefined;
    }

    /**
     * Capture the pending prime payload and queue its restoreFiles post. The
     * async load + post is serialized through `primeInFlight` so concurrent
     * primes (e.g. restartWorker's idle prime racing a pre-upload immediate
     * prime) still emit their restoreFiles in invocation order. Without this a
     * slow earlier prime could post after a later prime's addFile and revert the
     * worker to the stored set, breaking the documented FIFO ordering. Callers
     * await the returned promise to know the post (and any prior one) has run.
     * @returns {Promise<void>}
     */
    function primeAnalyticsWorkerNow() {
        if (!worker || !pendingPrimePayload) {
            return Promise.resolve();
        }
        const { signature } = pendingPrimePayload;
        pendingPrimePayload = null;

        const previous = primeInFlight || Promise.resolve();
        const run = previous.then(() => postPrimeToWorker(signature));
        primeInFlight = run.finally(() => {
            if (primeInFlight === run) {
                primeInFlight = null;
            }
        });
        return primeInFlight;
    }

    /**
     * Load the captured shares/comments text from storage and post it to the
     * worker. Text is fetched here (not held in the file cache) so large exports
     * stay in IndexedDB. Best-effort: a load failure is logged and skipped. Runs
     * inside the `primeInFlight` chain so posts stay ordered.
     * @param {string} signature - Payload signature recorded once posted
     * @returns {Promise<void>}
     */
    async function postPrimeToWorker(signature) {
        if (!worker) {
            return;
        }
        let sharesCsv = "";
        let commentsCsv = "";
        let connectionsCsv = "";
        try {
            // Connections feeds the posting-vs-network-growth correlation, so it
            // primes alongside shares/comments even though it is not a posting source.
            const [sharesFile, commentsFile, connectionsFile] = await Promise.all([
                Storage.getFile("shares"),
                Storage.getFile("comments"),
                Storage.getFile("connections"),
            ]);
            sharesCsv = sharesFile && sharesFile.text ? sharesFile.text : "";
            commentsCsv = commentsFile && commentsFile.text ? commentsFile.text : "";
            connectionsCsv = connectionsFile && connectionsFile.text ? connectionsFile.text : "";
        } catch (error) {
            // Leave lastPrimedSignature unchanged so a later prime can retry.
            captureError(error, { module: "upload", operation: "prime-load-text" });
            return;
        }

        // The worker may have been torn down (clear/restart) during the async load.
        if (!worker) {
            return;
        }
        try {
            worker.postMessage({
                type: "restoreFiles",
                payload: { sharesCsv, commentsCsv, connectionsCsv },
            });
        } catch (error) {
            // postMessage can throw synchronously (DataCloneError / invalid
            // state). Priming is best-effort, so swallow it (don't reject the
            // serialized chain and stall the awaiting upload) and leave
            // lastPrimedSignature unchanged so a later prime can retry.
            captureError(error, { module: "upload", operation: "prime-post-message" });
            return;
        }
        lastPrimedSignature = signature;
    }

    /** Clear all queued analytics prime timers and idle callbacks. */
    function clearPrimeSchedule() {
        if (primeTimerId) {
            window.clearTimeout(primeTimerId);
            primeTimerId = null;
        }
        if (primeIdleId && typeof cancelIdleCallback === "function") {
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
        elements.uploadHint.classList.toggle("is-error", Boolean(isError));
    }

    /** Hide progress overlay when all active jobs complete. */
    function checkJobs() {
        if (activeJobs.size === 0) {
            hideProgressOverlay();
        }
    }

    /**
     * Clear queued processing state and immediately hide the overlay.
     */
    function resetProcessingState() {
        pendingFiles.clear();
        clearAllJobTimeouts();
        activeJobs.clear();
        lastProgressPercent = 0;
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

            // The shared worker is wedged on this job; terminating and restarting
            // it stops the runaway parse from pinning the CPU and lets later
            // uploads still be processed. resetProcessingState() first so the
            // restart starts from a clean slate.
            resetProcessingState();
            restartWorker();
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
        jobTimeouts.forEach((timeoutId) => {
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
        lastProgressPercent = 0;
        drawProgressBar(progressValue);
        animateProgressTo(
            0.72,
            650,
            () => {
                if (sessionId !== progressSessionId || activeJobs.size <= 0) {
                    return;
                }
                startProgressCrawl(sessionId);
            },
            sessionId,
        );
    }

    /** Animate progress to 100% then hide the overlay. */
    function hideProgressOverlay() {
        if (elements.progressOverlay.hidden) {
            return;
        }
        const sessionId = progressSessionId;
        animateProgressTo(
            1,
            320,
            () => {
                if (sessionId !== progressSessionId) {
                    return;
                }
                elements.progressOverlay.hidden = true;
            },
            sessionId,
        );
    }

    /**
     * Smoothly animate progress bar to target value.
     * @param {number} target - Target progress value (0-1)
     * @param {number} duration - Animation duration in ms
     * @param {(() => void) | null} [callback] - Optional callback when animation completes
     * @param {number} [sessionId] - Progress animation session token
     */
    function animateProgressTo(target, duration, callback, sessionId) {
        stopProgressAnimation();
        const start = performance.now();
        const startValue = progressValue;
        const animationSession = sessionId || progressSessionId;

        function step(now) {
            /* v8 ignore next 4 */
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
                queueMicrotask(callback);
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
            /* v8 ignore next 4 */
            if (sessionId !== progressSessionId) {
                progressAnimationId = null;
                return;
            }

            /* v8 ignore next */
            if (activeJobs.size === 0) {
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
                const unitsPerSecond = 0.007 + 0.06 * normalizedRemaining;
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
        /* v8 ignore next */
        if (!canvas) {
            return;
        }
        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) {
            return;
        }
        const ratio = window.devicePixelRatio || 1;
        canvas.width = rect.width * ratio;
        canvas.height = rect.height * ratio;
        const ctx = canvas.getContext("2d");
        /* v8 ignore next */
        if (!ctx) {
            return;
        }
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.clearRect(0, 0, rect.width, rect.height);

        /* v8 ignore next 3 */
        if (typeof document === "undefined" || !document.documentElement) {
            return;
        }
        const styles = getComputedStyle(document.documentElement);
        const border = styles.getPropertyValue("--border-color").trim();
        const fill = styles.getPropertyValue("--accent-purple").trim();

        const trackX = 8;
        const trackY = rect.height / 2 - 14;
        const trackWidth = rect.width - 16;
        const trackHeight = 28;

        if (rough) {
            const rc = rough.canvas(canvas);
            rc.rectangle(trackX, trackY, trackWidth, trackHeight, {
                stroke: border,
                strokeWidth: 1.5,
                roughness: 1.4,
            });
            const fillWidth = Math.max(4, (trackWidth - 4) * value);
            ctx.fillStyle = fill;
            ctx.globalAlpha = 0.6;
            ctx.fillRect(trackX + 2, trackY + 2, fillWidth, trackHeight - 4);
            ctx.globalAlpha = 1;
            rc.rectangle(trackX + 2, trackY + 2, fillWidth, trackHeight - 4, {
                stroke: fill,
                strokeWidth: 1.2,
                roughness: 1.2,
            });
        }

        elements.progressPercent.textContent = `${Math.round(value * 100)}%`;
    }

    return {
        init,
        onRouteChange,
    };
})();
