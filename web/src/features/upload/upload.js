/* Upload page logic */

import { preloadRouteWhenIdle } from "../../app/route-preload.js";
import { AppRouter } from "../../app/router.js";
import {
    parseAnalyticsWorkerMessage,
    parseStoredUploadFile,
    toStoredFileMetadata,
} from "../../app/worker-contracts.js";
import { RunTracker } from "../../platform/observability/run-tracker.js";
import { captureError } from "../../platform/observability/sentry.js";
import { DataCache } from "../../platform/persistence/data-cache.js";
import { Session } from "../../platform/persistence/session.js";
import { Storage } from "../../platform/persistence/storage.js";
import { FILE_TYPES } from "../../shared/constants.js";
import { MAX_FILE_BYTES } from "../../shared/limits.js";
import { toErrorMessage } from "../../shared/worker-errors.js";
import { computeWorkerTimeout } from "../../shared/worker-timeout.js";

import { isQuotaExceededError } from "./decode.js";
import { consumePendingFile, createJobId, resolveJobId } from "./jobs.js";
import { hideCatcher, playCatch, showCatcher } from "./mascot.js";
import { UploadProgress } from "./progress.js";
import {
    createEmptyFileMap,
    getTypeSpecificFileCacheKey,
    getUploadHint,
    hasAnalyticsMonths,
} from "./state.js";

/** @typedef {import("../../app/worker-contracts.js").CachedFileMetadata} CachedFileMetadata */
/** @typedef {import("../../app/worker-contracts.js").FileProcessedPayload} FileProcessedPayload */
/** @typedef {import("../../app/worker-contracts.js").PlainObject} PlainObject */
/** @typedef {import("../../platform/persistence/storage.js").StoredAnalytics} StoredAnalytics */
/** @typedef {import("./state.js").UploadFileMap} UploadFileMap */

export const UploadPage = (() => {
    "use strict";

    const TRACKED_TYPES_SET = new Set(FILE_TYPES);

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
    // The file types the analytics worker keeps and primes from storage.
    const ANALYTICS_SOURCE_TYPES = new Set(["shares", "comments", "connections"]);
    // The prime signature of a stored set with no analytics inputs.
    const EMPTY_PRIME_SIGNATURE = "-|-|-";
    const LARGE_FILE_WARNING_BYTES = 25 * 1024 * 1024;

    /**
     * @param {number} count - Row count
     * @returns {string} Count with its unit, e.g. "1 row"
     */
    function formatRows(count) {
        return `${count} ${count === 1 ? "row" : "rows"}`;
    }

    /** @type {Worker|null} */
    let worker = null;
    /** @type {Map<string, import("./jobs.js").PendingUpload>} */
    const pendingFiles = new Map();
    /** @type {Set<string>} */
    const activeJobs = new Set();
    /** @type {Map<string, number>} */
    const jobTimeouts = new Map();
    // Saves still writing a processed upload. Clear waits for them so a save
    // that began before it cannot write the upload back afterwards.
    const pendingSaves = new Set();
    // Saves of analytics inputs still writing. A batch's analytics wait for
    // them, so an aggregate is never stored over an input storage lacks.
    /** @type {Set<Promise<void>>} */
    const analyticsInputSaves = new Set();
    // True once an analytics input in the running batch failed to save.
    let analyticsInputFailed = false;
    // Bumped by Clear, so a save that began before it skips its analytics,
    // cache and status continuations.
    let clearGeneration = 0;
    // The Clear in progress, so new uploads wait for it rather than racing it.
    /** @type {Promise<void>|null} */
    let clearInFlight = null;
    let initialized = false;
    /** @type {string|null} */
    let lastPrimedSignature = null;
    // True when the last prime failed to reach the worker, so it does not hold
    // the whole stored set and a later upload must not record it as primed.
    let primeFailed = false;
    /** @type {Promise<void>|null} */
    let restorePromise = null;
    let restoredOnce = false;
    /** @type {number|null} */
    let primeTimerId = null;
    /** @type {number|null} */
    let primeIdleId = null;
    /** @type {{signature: string}|null} */
    let pendingPrimePayload = null;
    /** @type {Promise<void>|null} */
    let primeInFlight = null;
    let storagePersistenceRequested = false;
    // Restart throttle: at most MAX_WORKER_RESTARTS within WORKER_RESTART_WINDOW_MS.
    const MAX_WORKER_RESTARTS = 3;
    const WORKER_RESTART_WINDOW_MS = 10000;
    /** @type {number[]} */
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
        // Repeat the warning if storage works at load but fails mid-session
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
        // init() runs once. Keep the flag check if a caller invokes this function again.
        /* v8 ignore next 3 */
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
        primeFailed = false;
        initWorker();
        // Re-prime the new worker from cached files so analytics stay accurate after a crash.
        if (!worker) {
            return;
        }
        const cachedFiles = /** @type {CachedFileMetadata[]|undefined} */ (
            DataCache.get("storage:files")
        );
        if (cachedFiles) {
            scheduleAnalyticsWorkerPrime(getFileMap(cachedFiles), { priority: "idle" });
        }
    }

    /** Create the analytics Web Worker. */
    function initWorker() {
        if (typeof Worker === "undefined") {
            return;
        }
        try {
            worker = new Worker(new URL("../analytics/analytics-worker.js", import.meta.url), {
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
        const { dropZone, fileInput, openAnalyticsBtn, clearAllBtn } = elements;
        // Match init()'s contract: only dropZone/fileInput are required for uploads.
        // The optional buttons are guarded individually below so a missing button
        // never disables drag/drop or the file input. init() already returns before
        // calling bindEvents when either is missing, so this mirror is unreachable here.
        /* v8 ignore next 3 */
        if (!dropZone || !fileInput) {
            return;
        }
        dropZone.addEventListener("click", () => fileInput.click());
        dropZone.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                fileInput.click();
            }
        });
        fileInput.addEventListener("change", handleFileInput);
        dropZone.addEventListener("dragover", handleDragOver);
        dropZone.addEventListener("dragleave", handleDragLeave);
        dropZone.addEventListener("drop", handleDrop);

        window.addEventListener("dragover", (event) => event.preventDefault());
        window.addEventListener("drop", (event) => event.preventDefault());

        if (openAnalyticsBtn) {
            openAnalyticsBtn.addEventListener("click", () => {
                if (openAnalyticsBtn.disabled) {
                    return;
                }

                AppRouter.navigate("analytics", undefined, { replaceHistory: false });
            });
        }

        if (clearAllBtn) {
            clearAllBtn.addEventListener("click", () => {
                if (!clearInFlight) {
                    clearInFlight = clearAllData().finally(() => {
                        clearInFlight = null;
                    });
                }
            });
        }

        window.addEventListener("resize", () => UploadProgress.redraw());
        window.addEventListener("online", updateOfflineBanner);
        window.addEventListener("offline", updateOfflineBanner);
    }

    /**
     * Restore upload status from IndexedDB and refresh the file cache on load.
     * Does not prime the worker. That is deferred to the first upload (see
     * processFiles); the dashboard reads the persisted analyticsBase directly.
     * @returns {Promise<void>}
     */
    async function restoreState() {
        if (restorePromise) {
            await restorePromise;
            return;
        }

        restorePromise = (async () => {
            const generation = clearGeneration;
            await Session.waitForCleanup();
            updateOfflineBanner();
            const files = await Storage.getAllFiles();
            // A Clear during the read leaves these files describing a wiped store.
            if (generation !== clearGeneration) {
                return;
            }
            const fileMap = getFileMap(files);
            DataCache.set("storage:files", files.map(toStoredFileMetadata));
            // Intentionally do NOT prime the worker on load: the dashboard reads
            // the persisted analyticsBase directly and never needs the worker's
            // raw shares/comments. Only a fresh upload (which recomputes the base)
            // does, so priming is deferred to processFiles(), saving a redundant
            // re-parse of shares+comments on every page load.
            const analyticsReady = await hasAnalyticsData();
            if (generation !== clearGeneration) {
                return;
            }
            updateStatus({ fileMap, analyticsReady });
            // If a stale 24h session was wiped, tell the user once rather than
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
        const files = /** @type {CachedFileMetadata[]|undefined} */ (
            DataCache.get("storage:files")
        );
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
        elements.dropZone?.classList.add("drag-over");
        showCatcher();
    }

    /**
     * Handle dragleave to remove drop zone highlight.
     * @param {DragEvent} event - Dragleave event
     */
    function handleDragLeave(event) {
        event.preventDefault();
        elements.dropZone?.classList.remove("drag-over");
        hideCatcher();
    }

    /**
     * Handle file drop event.
     * @param {DragEvent} event - Drop event
     */
    function handleDrop(event) {
        event.preventDefault();
        elements.dropZone?.classList.remove("drag-over");
        const files = Array.from(event.dataTransfer?.files || []);
        if (!files.length) {
            hideCatcher();
            return;
        }
        // The catch plays for any drop that landed, valid or not: Pip is
        // reacting to the file arriving, not to what processing makes of it.
        playCatch();
        processFiles(files);
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
            const warningMb = Math.round(LARGE_FILE_WARNING_BYTES / (1024 * 1024));
            setHint(
                `Some files are large (${warningMb}MB+). Processing can take up to a minute and may not finish on a phone with little memory.`,
                false,
            );
        }
        if (!worker) {
            setHint("Workers are unavailable. Open this page from a local server.", true);
            return;
        }
        const incomingBytes = acceptedFiles.reduce((sum, file) => sum + file.size, 0);
        warnIfStorageLow(incomingBytes);

        // Files dropped during a Clear are processed after it, so the wipe
        // cannot take them with it.
        if (clearInFlight) {
            await clearInFlight;
        }
        const generation = clearGeneration;
        if (activeJobs.size === 0) {
            UploadProgress.show(() => activeJobs.size > 0);
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
            // The worker may be missing stored files, so this upload cannot mark them primed.
            primeFailed = true;
        }
        // Files dropped before a Clear that ran during the priming await went
        // with it; Clear has already reset the overlay and the jobs.
        if (generation !== clearGeneration) {
            return;
        }
        // Start or join the tracked run only now, in the same task that adds
        // the jobs: earlier jobs finishing during the priming await would
        // otherwise finish the run these files just joined.
        RunTracker.start({ totalBytes: incomingBytes, fileCount: acceptedFiles.length });
        acceptedFiles.forEach((file) => {
            const jobId = createJobId(file);
            activeJobs.add(jobId);
            // The worker reads the File itself. Posting a File clones a
            // reference to its bytes, so the page never holds the text; the
            // page keeps the File to store once the worker accepts it.
            pendingFiles.set(jobId, { fileName: file.name, file });
            try {
                // Checked above. A restart during the prime await can null it,
                // and the throw lands in the catch below, as before.
                /** @type {Worker} */ (worker).postMessage({
                    type: "addFile",
                    payload: {
                        file,
                        fileName: file.name,
                        jobId,
                        totalSize: file.size,
                    },
                });
            } catch (error) {
                captureError(error, {
                    module: "upload",
                    operation: "post-file",
                    fileName: file.name,
                    fileSize: file.size,
                });
                completeJob(jobId, file.name);
                setHint(toErrorMessage(error, "Error reading file. Please try again."), true);
            }
        });
        armRunningJobTimeout();
    }

    /**
     * Wipe stored uploads and analytics.
     *
     * Everything that could still start a save is stopped first: the pending
     * jobs are dropped, so a reply that lands meanwhile finds nothing to save,
     * and the worker is cleared. Only then does Clear wait out the saves already
     * writing, so none of them can write an upload back after the wipe.
     * @returns {Promise<void>}
     */
    async function clearAllData() {
        clearGeneration += 1;
        resetProcessingState();
        clearPrimeSchedule();
        pendingPrimePayload = null;
        lastPrimedSignature = null;
        primeFailed = false;
        if (worker) {
            worker.postMessage({ type: "clear" });
        }
        try {
            await Promise.allSettled(pendingSaves);
            await Storage.clearAll();
            DataCache.clear();
            DataCache.notify({ type: "storageCleared" });
            updateStatus({ fileMap: createEmptyFileMap(), analyticsReady: false });
        } catch (error) {
            captureError(error, {
                module: "upload",
                operation: "clear-all",
            });
            setHint("Unable to clear stored data. Please try again.", true);
        }
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
                // resetting every in-flight upload. Only a worker-level `error`
                // event (handleWorkerError) wipes all processing state.
                completeJob(payload.jobId || null, payload.fileName || "");
                return;
            }
            // parseAnalyticsWorkerMessage only yields the known message types above,
            // so the switch default is an unreachable exhaustiveness guard.
            /* v8 ignore next 2 */
            default:
                return;
        }
    }

    /**
     * Persist processed worker payload and refresh upload status.
     * @param {FileProcessedPayload} payload - Worker payload for fileProcessed
     */
    async function handleFileProcessedMessage(payload) {
        const fileType = payload.fileType;
        const fileName = payload.fileName;
        const jobId = payload.jobId || null;
        const rowCount = payload.rowCount || 0;
        const pending = consumePendingFile(pendingFiles, jobId, fileName);
        // A restart while this reply is saved replaces the worker it describes.
        const replyWorker = worker;
        // The worker has moved on to the next queued file.
        armRunningJobTimeout();

        if (!fileType) {
            const generation = clearGeneration;
            // A reply with no pending job outlived a Clear, so its analytics
            // describe data that is gone.
            if (pending) {
                await persistAnalyticsOnly(payload.analyticsBase);
            }
            // Set after the save, whose status update would replace it.
            if (generation === clearGeneration) {
                setHint(payload.error || "File could not be processed.", true);
            }
            completeJob(jobId, fileName);
            return;
        }

        if (!pending) {
            completeJob(jobId, fileName);
            return;
        }

        const generation = clearGeneration;
        const save = persistProcessedFile(
            fileType,
            fileName,
            pending.file,
            rowCount,
            payload.analyticsBase,
            generation,
        );
        pendingSaves.add(save);
        try {
            const analyticsStored = await save;
            if (generation !== clearGeneration) {
                return;
            }
            // Only analytics that reached storage are published, so the screens
            // never show an aggregate that counts an upload storage lacks.
            await syncCacheAfterProcessedFile(
                fileType,
                analyticsStored ? payload.analyticsBase : null,
                generation,
            );

            const files = await getStoredFilesSnapshot();
            const fileMap = getFileMap(files);
            const analyticsReady = await hasAnalyticsData();
            if (generation !== clearGeneration) {
                return;
            }
            updateStatus({ fileMap, analyticsReady });
            setHint(
                payload.usedFallback
                    ? "File loaded, but some characters weren't valid UTF-8 and were decoded with a Windows-1252 fallback. Double-check accented names."
                    : "File loaded successfully.",
                false,
            );
            if (ANALYTICS_SOURCE_TYPES.has(fileType) && !primeFailed && worker === replyWorker) {
                // The worker that processed this file already holds it along
                // with the rest of the stored set, so record that set as primed
                // instead of having the worker read and parse it all again.
                lastPrimedSignature = getPrimeSignature(fileMap);
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
            pendingSaves.delete(save);
            completeJob(jobId, fileName);
        }
    }

    /**
     * Handle incremental worker progress updates.
     * @param {{jobId?: string|null, percent?: number}} payload - Progress payload
     */
    function handleProgressMessage(payload) {
        // parseAnalyticsWorkerMessage normally returns a numeric percent. Keep the
        // guard for malformed payloads.
        /* v8 ignore next 3 */
        if (!payload || typeof payload.percent !== "number") {
            return;
        }
        if (activeJobs.size === 0) {
            return;
        }
        UploadProgress.reportPercent(payload.percent);
    }

    /**
     * Persist the original upload and its analytics in IndexedDB.
     * @param {string} fileType - Processed file type
     * @param {string} fileName - Uploaded file name
     * @param {Blob} blob - The uploaded File
     * @param {number} rowCount - Processed row count
     * @param {PlainObject|null|undefined} analyticsBase - Optional analytics aggregate base
     * @param {number} generation - Clear generation the upload was processed under
     * @returns {Promise<boolean>} Whether the analytics were stored with it
     */
    async function persistProcessedFile(
        fileType,
        fileName,
        blob,
        rowCount,
        analyticsBase,
        generation,
    ) {
        const fileSave = Storage.saveFile(fileType, { name: fileName, blob, rowCount });
        if (ANALYTICS_SOURCE_TYPES.has(fileType)) {
            trackAnalyticsInputSave(fileSave);
        }
        try {
            await fileSave;
        } catch (error) {
            // A batch's analytics ride on its last reply. When that file is not
            // an analytics input, they still describe the files that are stored.
            if (
                analyticsBase &&
                !ANALYTICS_SOURCE_TYPES.has(fileType) &&
                generation === clearGeneration
            ) {
                await persistAnalyticsOnly(analyticsBase);
            }
            throw error;
        }
        if (!analyticsBase || generation !== clearGeneration) {
            return false;
        }
        if (!(await analyticsInputsStored()) || generation !== clearGeneration) {
            return false;
        }
        await Storage.saveAnalytics(analyticsBase);
        return true;
    }

    /**
     * Track the save of an analytics input, so the batch's analytics wait for
     * it. A failed save leaves the worker holding an input storage lacks, so
     * the worker is primed again from storage before the next upload.
     * @param {Promise<unknown>} save - Storage.saveFile promise
     */
    function trackAnalyticsInputSave(save) {
        const settled = save.then(
            () => {},
            () => {
                analyticsInputFailed = true;
                lastPrimedSignature = null;
                primeFailed = true;
            },
        );
        analyticsInputSaves.add(settled);
        settled.then(() => analyticsInputSaves.delete(settled));
    }

    /**
     * Wait for the analytics inputs still saving.
     * @returns {Promise<boolean>} Whether every input in the batch was stored
     */
    async function analyticsInputsStored() {
        await Promise.all(analyticsInputSaves);
        return !analyticsInputFailed;
    }

    /**
     * Store analytics that arrived on a reply whose file is not stored. The
     * worker computes a batch's analytics on its last reply, which can be a
     * rejected file, so the files accepted before it still reach the dashboard.
     * @param {PlainObject|null|undefined} analyticsBase - Analytics aggregate base
     * @returns {Promise<void>}
     */
    async function persistAnalyticsOnly(analyticsBase) {
        if (!analyticsBase) {
            return;
        }
        const generation = clearGeneration;
        // An input the aggregate counts did not reach storage, so the stored
        // analytics stay as they were rather than describe it.
        if (!(await analyticsInputsStored()) || generation !== clearGeneration) {
            return;
        }
        const save = Storage.saveAnalytics(analyticsBase);
        // Clear waits for this save, so it cannot write analytics back after the wipe.
        pendingSaves.add(save);
        try {
            await save;
            if (generation !== clearGeneration) {
                return;
            }
            DataCache.invalidate("insights:");
            DataCache.set("storage:analyticsBase", analyticsBase);
            DataCache.notify({ type: "analyticsChanged" });
            const files = await getStoredFilesSnapshot();
            if (generation !== clearGeneration) {
                return;
            }
            updateStatus({ fileMap: getFileMap(files), analyticsReady: true });
        } catch (error) {
            captureError(error, { module: "upload", operation: "persist-analytics" });
        } finally {
            pendingSaves.delete(save);
        }
    }

    /**
     * Sync in-memory caches and notify listeners after file persistence.
     * @param {string} fileType - Processed file type
     * @param {PlainObject|null|undefined} analyticsBase - Optional analytics aggregate base
     * @param {number} generation - Clear generation the upload was processed under
     * @returns {Promise<void>}
     */
    async function syncCacheAfterProcessedFile(fileType, analyticsBase, generation) {
        DataCache.invalidate("storage:");
        DataCache.invalidate("clean:");
        DataCache.invalidate("messages:");
        // The Insights screen publishes what is on screen for the PDF export to
        // reuse. That snapshot describes the previous upload, and the export
        // prefers it over recomputing, so it has to go with the rest.
        DataCache.invalidate("insights:");

        const files = await Storage.getAllFiles();
        // A Clear during the read would have these stale files cached after it.
        if (generation !== clearGeneration) {
            return;
        }
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
     * @param {CachedFileMetadata[]} files - Stored files snapshot
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
     * Read files from cache when available, otherwise from storage.
     * @returns {Promise<CachedFileMetadata[]>}
     */
    async function getStoredFilesSnapshot() {
        const files = /** @type {CachedFileMetadata[]|undefined} */ (
            DataCache.get("storage:files")
        );
        if (files) {
            return files;
        }
        return Storage.getAllFiles();
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
        const resolvedJobId = resolveJobId(activeJobs, pendingFiles, jobId, fileName);

        if (!resolvedJobId) {
            checkJobs();
            return;
        }

        pendingFiles.delete(resolvedJobId);
        clearJobTimeout(resolvedJobId);
        activeJobs.delete(resolvedJobId);
        armRunningJobTimeout();
        checkJobs();
    }

    /**
     * Time the job the worker is running. The worker takes jobs one at a time
     * in the order they were posted, so only the oldest unanswered job is
     * running; the ones behind it are timed from when they start, and a small
     * file is not cut off while a large one ahead of it uses its allowance.
     */
    function armRunningJobTimeout() {
        const running = pendingFiles.entries().next();
        if (running.done || jobTimeouts.has(running.value[0])) {
            return;
        }
        const [jobId, entry] = running.value;
        scheduleJobTimeout(jobId, entry.file);
    }

    /**
     * Update a single file type's status indicator and label.
     * @param {HTMLElement|null} statusItem - The .file-status-item element
     * @param {HTMLElement|null} statusLabel - The status text element
     * @param {{rowCount: number}|null|undefined} fileData - Stored file record, or null if
     * not uploaded
     */
    function updateFileStatus(statusItem, statusLabel, fileData) {
        if (!statusItem || !statusLabel) {
            return;
        }
        if (fileData) {
            statusItem.classList.add("is-ready");
            statusLabel.textContent = `${formatRows(fileData.rowCount)} loaded`;
        } else {
            statusItem.classList.remove("is-ready");
            statusLabel.textContent = "Not uploaded";
        }
    }

    /**
     * Update the upload page UI to reflect current file and analytics state.
     * @param {{fileMap: UploadFileMap, analyticsReady: boolean}} status
     */
    function updateStatus({ fileMap, analyticsReady }) {
        STATUS_ITEMS.forEach(({ type, item, label }) => {
            updateFileStatus(/** @type {HTMLElement|null} */ (item), label, fileMap[type]);
        });

        const hasAny = FILE_TYPES.some((type) => Boolean(fileMap[type]));
        const hasAnalyticsFiles = Boolean(fileMap.shares || fileMap.comments);
        if (elements.openAnalyticsBtn) {
            elements.openAnalyticsBtn.disabled = !hasAnalyticsFiles || !analyticsReady;
        }
        if (hasAnalyticsFiles && analyticsReady) {
            // Analytics is where the button leads, so fetch it before the click.
            preloadRouteWhenIdle("analytics");
        }
        setHint(getUploadHint(hasAny, hasAnalyticsFiles, analyticsReady), false);
    }

    /**
     * Build a fixed file map for all tracked types.
     * @param {readonly unknown[]} files - Stored file records
     * @returns {UploadFileMap}
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
     * Check whether analytics aggregates are available in storage.
     * @returns {Promise<boolean>}
     */
    async function hasAnalyticsData() {
        let analyticsBase = /** @type {StoredAnalytics|null} */ (
            DataCache.get("storage:analyticsBase") || null
        );
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
        const analyticsBase = /** @type {StoredAnalytics|null} */ (
            DataCache.get("storage:analyticsBase") || null
        );
        if (!analyticsBase) {
            return null;
        }
        return hasAnalyticsMonths(analyticsBase);
    }

    /**
     * Prime the worker with stored shares/comments before an upload so a new
     * analytics file recomputes from the full set (a no-op via signature dedup
     * when already primed). Reads the cached file snapshot, falling back to
     * storage when the cache isn't populated yet. `restoreState()` is fired but
     * not awaited in init(), so a fast upload can race ahead of it; loading here
     * guarantees the prior shares/comments are seeded before the new addFile.
     * @returns {Promise<void>}
     */
    async function primeWorkerFromStoredFiles() {
        let cachedFiles = /** @type {CachedFileMetadata[]|undefined} */ (
            DataCache.get("storage:files")
        );
        if (!cachedFiles) {
            const files = await Storage.getAllFiles();
            cachedFiles = files.map(toStoredFileMetadata);
            DataCache.set("storage:files", cachedFiles);
        }
        // Await the prime so its restoreFiles is posted (after loading the text
        // from storage) before processFiles posts any addFile, preserving the
        // "recompute from the full set" guarantee now that priming is async.
        await scheduleAnalyticsWorkerPrime(getFileMap(cachedFiles), { priority: "immediate" });
    }

    /**
     * Identify the stored analytics inputs by presence, update time, and row
     * count, so an unchanged set is not primed twice.
     * @param {UploadFileMap} fileMap - Stored files map
     * @returns {string|null} Signature, or null when no analytics input is stored
     */
    function getPrimeSignature(fileMap) {
        const sharesFile = fileMap.shares || null;
        const commentsFile = fileMap.comments || null;
        const connectionsFile = fileMap.connections || null;
        if (!sharesFile && !commentsFile && !connectionsFile) {
            return null;
        }
        /**
         * @param {import("./state.js").StoredUploadFile|null} file - Stored file, or null
         * @returns {string} The file's stamp, or "-" when it is missing
         */
        const stamp = (file) => (file ? `${file.updatedAt || 0}:${file.rowCount || 0}` : "-");
        // Connections feeds the network-growth correlation, so a connections-only
        // change must still invalidate the signature and force a re-prime.
        return `${stamp(sharesFile)}|${stamp(commentsFile)}|${stamp(connectionsFile)}`;
    }

    /**
     * Seed worker with existing shares/comments datasets for accurate recompute.
     * Decides whether to prime from file metadata (presence + a row/updatedAt
     * signature); the CSV text itself is loaded from storage only when the prime
     * actually fires (see primeAnalyticsWorkerNow). Uses idle scheduling unless
     * priority is immediate, in which case it returns the prime promise so callers
     * can await the restoreFiles being posted.
     * @param {UploadFileMap} fileMap - Stored files map
     * @param {{priority?: 'idle'|'immediate'}} [options] - Scheduling options
     * @returns {Promise<void>|void}
     */
    function scheduleAnalyticsWorkerPrime(fileMap, options) {
        // Upload flows normally create the worker before priming. Keep the guard
        // for a worker teardown race.
        /* v8 ignore next 3 */
        if (!worker) {
            return undefined;
        }

        // After a failed prime or save the worker may hold inputs storage lacks,
        // so even an empty stored set is primed, which clears them.
        const signature =
            getPrimeSignature(fileMap) || (primeFailed ? EMPTY_PRIME_SIGNATURE : null);
        // Connections alone are worth priming: the worker retains the dataset so
        // the first later shares/comments upload picks up the already-stored
        // connections for the network-growth correlation without a re-upload.
        if (!signature) {
            lastPrimedSignature = null;
            pendingPrimePayload = null;
            clearPrimeSchedule();
            return undefined;
        }

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
        // Both guards fire only on a torn-down worker or a payload cleared by a
        // racing restart between scheduling and firing, neither staged in units.
        /* v8 ignore next 3 */
        if (!worker || !pendingPrimePayload) {
            return Promise.resolve();
        }
        const { signature } = pendingPrimePayload;
        pendingPrimePayload = null;
        const generation = clearGeneration;

        const previous = primeInFlight || Promise.resolve();
        const run = previous.then(() => postPrimeToWorker(signature, generation));
        const trackedRun = run.finally(() => {
            if (primeInFlight === trackedRun) {
                primeInFlight = null;
            }
        });
        primeInFlight = trackedRun;
        return primeInFlight;
    }

    /**
     * Load the stored shares/comments uploads and post them to the worker,
     * which reads them. Blobs are fetched here (not held in the file cache),
     * and posting one passes a reference rather than the file's contents. Best-effort: a load failure is logged and skipped. Runs
     * inside the `primeInFlight` chain so posts stay ordered.
     * @param {string} signature - Payload signature recorded once posted
     * @param {number} generation - Clear generation the prime was requested under
     * @returns {Promise<void>}
     */
    async function postPrimeToWorker(signature, generation) {
        // Entry guard for a worker torn down before the chained post runs; the
        // caller only reaches here with a live worker in unit flows.
        /* v8 ignore next 3 */
        if (!worker) {
            return;
        }
        let sharesCsv = null;
        let commentsCsv = null;
        let connectionsCsv = null;
        try {
            // Connections feeds the posting-vs-network-growth correlation, so it
            // primes alongside shares/comments even though it is not a posting source.
            const [sharesFile, commentsFile, connectionsFile] = await Promise.all([
                Storage.getFile("shares"),
                Storage.getFile("comments"),
                Storage.getFile("connections"),
            ]);
            sharesCsv = sharesFile ? sharesFile.blob : null;
            commentsCsv = commentsFile ? commentsFile.blob : null;
            connectionsCsv = connectionsFile ? connectionsFile.blob : null;
        } catch (error) {
            // Leave lastPrimedSignature unchanged so a later prime can retry.
            captureError(error, { module: "upload", operation: "prime-load-text" });
            primeFailed = true;
            return;
        }
        // Posting files read before a Clear would restore them into the worker
        // after the clear it was sent.
        if (generation !== clearGeneration) {
            return;
        }

        // Async storage reads can outlive worker teardown. Recheck before posting.
        /* v8 ignore next 3 */
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
            primeFailed = true;
            return;
        }
        lastPrimedSignature = signature;
        primeFailed = false;
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
        // The upload shell always renders #uploadHint; the guard mirrors the
        // optional-element contract for embedders that omit it.
        /* v8 ignore next 3 */
        if (!elements.uploadHint) {
            return;
        }
        elements.uploadHint.textContent = message;
        elements.uploadHint.classList.toggle("is-error", Boolean(isError));
    }

    /** Hide progress overlay when all active jobs complete. */
    function checkJobs() {
        if (activeJobs.size === 0) {
            analyticsInputFailed = false;
            UploadProgress.hide();
            RunTracker.finish();
        }
    }

    /**
     * Clear queued processing state and immediately hide the overlay.
     */
    function resetProcessingState() {
        pendingFiles.clear();
        clearAllJobTimeouts();
        activeJobs.clear();
        analyticsInputFailed = false;
        UploadProgress.hide();
        RunTracker.finish();
    }

    /**
     * Start a timeout watchdog for a worker job. A large file gets more time, so
     * a slow device is not cut off partway through a file within the limits.
     * @param {string} jobId - Worker job id
     * @param {File} file - Uploaded file
     */
    function scheduleJobTimeout(jobId, file) {
        clearJobTimeout(jobId);
        const fileName = file.name;
        const budget = Math.max(JOB_TIMEOUT_MS, computeWorkerTimeout(file));
        const timeoutId = window.setTimeout(() => {
            // completeJob() clears this timer when a job settles, including error paths.
            // resetProcessingState() clears all job timers during teardown.
            /* v8 ignore next 3 */
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
        }, budget);

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

    return {
        init,
        onRouteChange,
    };
})();
