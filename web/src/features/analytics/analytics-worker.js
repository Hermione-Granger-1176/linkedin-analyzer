/* LinkedIn Analyzer - Analytics Web Worker */

import { parseAnalyticsWorkerRequest } from "../../app/worker-contracts.js";
import { LinkedInCleaner } from "../cleaning/cleaner.js";
import {
    canStreamFileText,
    readCsvSource,
    readFileAsText,
    streamFileText,
} from "../upload/read.js";

import { AnalyticsEngine } from "./activity.js";

/** @typedef {import("../../app/worker-contracts.js").PlainObject} PlainObject */
/** @typedef {import("../../app/worker-contracts.js").RequestId} RequestId */
/** @typedef {import("../cleaning/cleaner.js").CleanedRow} CleanedRow */
/** @typedef {import("../cleaning/cleaner.js").ProcessResult} ProcessResult */
/** @typedef {import("./activity.js").AnalyticsBase} AnalyticsBase */
/** @typedef {import("./activity.js").AnalyticsFilterInput} AnalyticsFilterInput */
/** @typedef {import("./activity.js").AnalyticsFilters} AnalyticsFilters */
/** @typedef {import("./activity.js").AnalyticsViewPayload} AnalyticsViewPayload */
/** @typedef {import("./activity.js").HydratedAnalytics} HydratedAnalytics */
/** @typedef {"shares"|"comments"|"connections"} AnalyticsSourceType */

/** @type {CleanedRow[]|null} */
let sharesData = null;
/** @type {CleanedRow[]|null} */
let commentsData = null;
/** @type {CleanedRow[]|null} */
let connectionsData = null;
/** @type {AnalyticsBase|HydratedAnalytics|null} */
let analytics = null;
/** @type {Map<string, AnalyticsViewPayload>} */
let viewCache = new Map();
const VIEW_CACHE_LIMIT = 50;
const VIEW_CACHE_TRIM = 20;
/** @type {readonly AnalyticsSourceType[]} */
const ANALYTICS_SOURCE_TYPES = Object.freeze(["shares", "comments", "connections"]);
const WORKER_REQUEST_TYPES = new Set(["addFile", "restoreFiles", "initBase", "view", "clear"]);
// Reading the file fills this share of the progress bar, after the first 5%.
const READ_PROGRESS_START = 0.05;
const READ_PROGRESS_SPAN = 0.3;
// Post a read progress update only when it moves the bar at least this much.
const READ_PROGRESS_STEP = 0.01;

// Requests run one at a time in arrival order, because reading a file is
// asynchronous. Clear runs at once instead: it aborts the read in flight, bumps
// the epoch so requests from before it drop their results, and starts a fresh
// queue so a request after it never waits on a stale read.
let requestQueue = Promise.resolve();
let requestEpoch = 0;
/** @type {AbortController|null} */
let activeRead = null;

/**
 * Normalize raw filter values into a safe, complete filter object.
 * @param {AnalyticsFilterInput|null|undefined} filters - Raw filter values from the UI
 * @returns {AnalyticsFilters}
 */
function normalizeFilters(filters) {
    const safe = filters || {};
    return {
        timeRange: safe.timeRange || "12m",
        topic: safe.topic || "all",
        monthFocus: safe.monthFocus || null,
        day: typeof safe.day === "number" ? safe.day : null,
        hour: typeof safe.hour === "number" ? safe.hour : null,
        shareType: safe.shareType || "all",
    };
}

/**
 * Build a cache key string from normalized filters.
 * @param {AnalyticsFilterInput|null|undefined} filters - Raw or normalized filter object
 * @returns {string} Pipe-delimited cache key
 */
function getViewKey(filters) {
    const safe = normalizeFilters(filters);
    return [
        safe.timeRange,
        safe.topic,
        safe.monthFocus || "none",
        safe.day !== null ? safe.day : "none",
        safe.hour !== null ? safe.hour : "none",
        safe.shareType || "all",
    ].join("|");
}

/**
 * Recompute analytics aggregates from the current shares, comments, and
 * connections data. Clears the view cache since aggregates have changed.
 */
function computeAnalytics() {
    analytics = AnalyticsEngine.compute(sharesData, commentsData, connectionsData);
    viewCache = new Map();
}

/**
 * Reset analytics and cache when no source datasets are loaded.
 */
function resetAnalyticsState() {
    analytics = null;
    viewCache = new Map();
}

/**
 * Check whether analytics currently contains any activity.
 * @returns {boolean}
 */
function hasAnalyticsData() {
    return Boolean(analytics && analytics.totals && analytics.totals.total > 0);
}

/**
 * Serialize the analytics aggregate for storage.
 * @param {AnalyticsBase|HydratedAnalytics|null} analyticsData - Analytics aggregate payload
 * @returns {AnalyticsBase|HydratedAnalytics|null}
 */
function serializeAnalytics(analyticsData) {
    if (!analyticsData) {
        /* v8 ignore next */
        return null;
    }
    // The new format is already serializable (no Date objects, no Sets in final output)
    return analyticsData;
}

/**
 * Hydrate the analytics aggregate from a stored payload.
 * @param {AnalyticsBase|null} base - Stored analytics payload
 * @returns {HydratedAnalytics|null}
 */
function hydrateAnalytics(base) {
    if (!base || !base.months) {
        return null;
    }

    // Convert activeDays arrays back to Sets for streak calculation
    const months = Object.fromEntries(
        Object.entries(base.months).map(([key, bucket]) => [
            key,
            {
                ...bucket,
                activeDays: new Set(bucket.activeDays || []),
            },
        ]),
    );

    return {
        ...base,
        months,
        activeDays: new Set(base.activeDays || []),
    };
}

/**
 * Post an error message back to the main thread.
 * `message` must be a static description (or an Error message from the parser /
 * analytics engine, which never interpolate row/cell content) so the value that
 * `analytics-ui` forwards to Sentry can never carry user data. `worker-contracts`
 * also length-caps it on receipt.
 * @param {RequestId} requestId - ID of the originating request
 * @param {string} message - Human-readable error description
 */
function postError(requestId, message) {
    self.postMessage({
        type: "error",
        requestId,
        payload: { message },
    });
}

/**
 * Convert unknown error values into a message string.
 * @param {unknown} error
 * @returns {string}
 */
function toErrorMessage(error) {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    /* v8 ignore next 3 */
    if (typeof error === "string" && error) {
        return error;
    }
    /* v8 ignore next */
    return "Worker runtime failure.";
}

/**
 * Store a view payload in the LRU cache, trimming old entries when full.
 * @param {string} key - Cache key from getViewKey
 * @param {AnalyticsViewPayload} payload - The view and insights payload to cache
 */
function cacheView(key, payload) {
    viewCache.set(key, payload);
    if (viewCache.size > VIEW_CACHE_LIMIT) {
        const keysToDelete = Array.from(viewCache.keys()).slice(0, VIEW_CACHE_TRIM);
        keysToDelete.forEach((k) => viewCache.delete(k));
    }
}

/**
 * Run a read of an uploaded file, reporting bytes read as progress.
 * Resolves null when a clear cancels the read or arrived since the request began.
 * @template T
 * @param {(options: {signal: AbortSignal, onProgress: (bytesRead: number, totalBytes: number) => void}) => Promise<T>} read - The read to run
 * @param {string|null} jobId - Upload job ID
 * @param {string} fileName - Uploaded file name
 * @param {number} epoch - Request epoch the read belongs to
 * @returns {Promise<T|null>}
 */
async function readUpload(read, jobId, fileName, epoch) {
    // A stale request must not start a read, or it would take over activeRead.
    if (epoch !== requestEpoch) {
        return null;
    }
    const controller = new AbortController();
    activeRead = controller;
    let lastPercent = READ_PROGRESS_START;
    /** @type {(bytesRead: number, totalBytes: number) => void} */
    const onProgress = (bytesRead, totalBytes) => {
        const fraction = totalBytes > 0 ? Math.min(bytesRead / totalBytes, 1) : 1;
        const percent = READ_PROGRESS_START + READ_PROGRESS_SPAN * fraction;
        if (percent - lastPercent < READ_PROGRESS_STEP && fraction < 1) {
            return;
        }
        lastPercent = percent;
        self.postMessage({
            type: "progress",
            payload: { jobId, fileName, percent, bytesRead, totalBytes },
        });
    };
    try {
        const result = await read({ signal: controller.signal, onProgress });
        // A Clear during the last read can let it finish with done; drop it.
        return controller.signal.aborted || epoch !== requestEpoch ? null : result;
    } catch (error) {
        if (controller.signal.aborted) {
            return null;
        }
        throw error;
    } finally {
        if (activeRead === controller) {
            activeRead = null;
        }
    }
}

/**
 * Read, parse, and clean an uploaded File.
 *
 * Where the File can be streamed, each decoded chunk is parsed and cleaned as
 * it arrives, so the full text and the full row arrays are never built. The
 * page stores the original File, so no text goes back. When the streaming
 * processor cannot finish (an error, or no type found in the prefix), the File
 * is read again whole and process() runs on that text, so results and
 * messages match the whole-text path.
 * Resolves null when a clear cancels the read.
 * @param {File} file - Uploaded file
 * @param {string|null} jobId - Upload job ID
 * @param {string} fileName - Uploaded file name
 * @param {number} epoch - Request epoch the upload belongs to
 * @returns {Promise<{usedFallback: boolean, processed: ProcessResult}|null>}
 */
async function readAndProcessUpload(file, jobId, fileName, epoch) {
    if (!canStreamFileText(file)) {
        const read = await readUpload(
            (options) => readFileAsText(file, options),
            jobId,
            fileName,
            epoch,
        );
        if (!read) {
            return null;
        }
        return {
            usedFallback: read.usedFallback,
            processed: LinkedInCleaner.process(read.text, "auto"),
        };
    }

    let processor = LinkedInCleaner.createStreamProcessor();
    const read = await readUpload(
        (options) =>
            streamFileText(file, {
                ...options,
                onText: (text) => {
                    processor.push(text);
                },
                onRestart: () => {
                    processor = LinkedInCleaner.createStreamProcessor();
                },
            }),
        jobId,
        fileName,
        epoch,
    );
    if (!read) {
        return null;
    }
    const streamed = processor.finish();
    if (streamed) {
        return { usedFallback: read.usedFallback, processed: streamed };
    }
    const whole = await readUpload(
        (options) => readFileAsText(file, options),
        jobId,
        fileName,
        epoch,
    );
    if (!whole) {
        return null;
    }
    return {
        usedFallback: whole.usedFallback,
        processed: LinkedInCleaner.process(whole.text, "auto"),
    };
}

/**
 * Process an uploaded CSV file: read, parse, clean, recompute analytics, and
 * reply. The page posts the File so the read happens here, off the main
 * thread, and stores that File itself, so the reply carries no text.
 * @param {import("../../app/worker-contracts.js").AddFilePayload} payload - File and name
 * @returns {Promise<void>}
 */
async function handleAddFile(payload) {
    const { file = null, fileName = "", jobId = null } = payload || {};
    const { csvText = "" } = payload || {};
    let usedFallback = false;
    /** @type {ProcessResult} */
    let processed;
    const epoch = requestEpoch;

    self.postMessage({
        type: "progress",
        payload: { jobId, fileName, percent: READ_PROGRESS_START },
    });

    if (file) {
        let result;
        try {
            // The upload page posts the File it was handed; the contract
            // accepts any Blob, and the name only ever labels an error.
            result = await readAndProcessUpload(/** @type {File} */ (file), jobId, fileName, epoch);
        } catch (error) {
            // A failure in a read a clear has since abandoned is nobody's to see.
            if (epoch !== requestEpoch) {
                return;
            }
            self.postMessage({
                type: "fileProcessed",
                payload: {
                    error: toErrorMessage(error) || "Error reading file. Please try again.",
                    jobId,
                    fileName,
                },
            });
            return;
        }
        if (!result) {
            return;
        }
        ({ usedFallback, processed } = result);
    } else {
        processed = LinkedInCleaner.process(csvText, "auto");
    }

    if (!processed.success) {
        self.postMessage({
            type: "fileProcessed",
            payload: { error: processed.error || "Unable to process file.", jobId, fileName },
        });
        return;
    }

    self.postMessage({
        type: "progress",
        payload: { jobId, fileName, percent: 0.4 },
    });

    // A successful result always carries the type it was processed as.
    const fileType = /** @type {string} */ (processed.fileType);
    let analyticsBase = null;
    /** @type {Record<string, () => void>} */
    const updateSourceByType = {
        shares: () => {
            sharesData = processed.cleanedData;
        },
        comments: () => {
            commentsData = processed.cleanedData;
        },
        connections: () => {
            connectionsData = processed.cleanedData;
        },
    };
    const updateSource = updateSourceByType[fileType];
    if (updateSource) {
        updateSource();
        self.postMessage({
            type: "progress",
            payload: { jobId, fileName, percent: 0.55 },
        });
        computeAnalytics();
        self.postMessage({
            type: "progress",
            payload: { jobId, fileName, percent: 0.85 },
        });
        analyticsBase = serializeAnalytics(analytics);
        self.postMessage({
            type: "progress",
            payload: { jobId, fileName, percent: 0.95 },
        });
    }
    self.postMessage({
        type: "fileProcessed",
        payload: {
            fileType,
            fileName,
            jobId,
            rowCount: processed.rowCount,
            analyticsBase,
            hasData: hasAnalyticsData(),
            usedFallback,
        },
    });
}

/**
 * Restore worker source datasets from the stored uploads. Each file arrives as
 * its stored Blob, read here, or as CSV text.
 * @param {{sharesCsv?: Blob|string, commentsCsv?: Blob|string, connectionsCsv?: Blob|string}} payload - Persisted analytics inputs
 * @returns {Promise<void>}
 */
async function handleRestoreFiles(payload) {
    const { sharesCsv = "", commentsCsv = "", connectionsCsv = "" } = payload || {};

    const epoch = requestEpoch;
    // A stored Blob the browser can no longer read counts as absent, like a
    // file that fails to parse, so it cannot fail the other types' restore.
    const readOrSkip = (/** @type {unknown} */ source) => readCsvSource(source).catch(() => "");
    const sourceCsvByType = {
        shares: await readOrSkip(sharesCsv),
        comments: await readOrSkip(commentsCsv),
        connections: await readOrSkip(connectionsCsv),
    };
    // Clear arrived while the stored files were read: keep what it cleared gone.
    if (epoch !== requestEpoch) {
        return;
    }
    /** @type {Record<AnalyticsSourceType, (cleanedData: CleanedRow[]) => void>} */
    const assignSourceByType = {
        shares: (cleanedData) => {
            sharesData = cleanedData;
        },
        comments: (cleanedData) => {
            commentsData = cleanedData;
        },
        connections: (cleanedData) => {
            connectionsData = cleanedData;
        },
    };

    sharesData = null;
    commentsData = null;
    connectionsData = null;

    // Whether a posting source (shares/comments) loaded with rows. Tracked here
    // rather than read back off the module fields afterwards because those are
    // assigned through the indirection above, which control-flow analysis cannot
    // follow.
    let hasPostingSource = false;
    ANALYTICS_SOURCE_TYPES.forEach((type) => {
        const csvText = sourceCsvByType[type];
        if (!csvText) {
            return;
        }

        const parsed = LinkedInCleaner.process(csvText, type);
        if (!parsed.success) {
            return;
        }
        assignSourceByType[type](parsed.cleanedData);
        if ((type === "shares" || type === "comments") && parsed.cleanedData.length > 0) {
            hasPostingSource = true;
        }
    });

    // restoreFiles only seeds the worker's source datasets so a subsequent
    // addFile recomputes analytics from the full set. The aggregate the dashboard
    // reads is always produced and persisted by handleAddFile; the only signal
    // this path emits (the "restored" hasData) is whether any posting source
    // loaded. Computing the full analytics aggregate here would be discarded
    // (never persisted or queried), so it is skipped. The stale aggregate is
    // cleared so nothing reads an out-of-date view between seed and recompute.
    resetAnalyticsState();

    self.postMessage({
        type: "restored",
        payload: {
            hasData: hasPostingSource,
        },
    });
}

/**
 * Hydrate analytics from stored data and notify the main thread.
 * @param {PlainObject|null} payload - Serialized analytics base from IndexedDB
 */
function handleInitBase(payload) {
    // The base is the one handleAddFile posted and the page stored.
    analytics = hydrateAnalytics(/** @type {AnalyticsBase|null} */ (payload));
    viewCache = new Map();
    const hasData = hasAnalyticsData();
    self.postMessage({
        type: "init",
        payload: { hasData },
    });
}

/**
 * Build a filtered analytics view and post it back, using cache when available.
 * @param {import("../../app/worker-contracts.js").RequestId} requestId - Caller-assigned request identifier for deduplication
 * @param {PlainObject} filters - Filter parameters from the UI
 */
function handleView(requestId, filters) {
    if (!analytics) {
        postError(requestId, "Analytics not ready.");
        return;
    }

    const safeFilters = normalizeFilters(/** @type {AnalyticsFilterInput} */ (filters || {}));
    const key = getViewKey(safeFilters);

    if (viewCache.has(key)) {
        const cachedPayload = /** @type {AnalyticsViewPayload} */ (viewCache.get(key));
        viewCache.delete(key);
        viewCache.set(key, cachedPayload);
        self.postMessage({
            type: "view",
            requestId,
            payload: cachedPayload,
        });
        return;
    }

    const view = AnalyticsEngine.buildView(analytics, safeFilters);

    if (!view) {
        postError(requestId, "Unable to build analytics view.");
        return;
    }

    const insights = AnalyticsEngine.generateInsights(view);
    const payload = {
        view: { ...view, key },
        insights,
    };

    cacheView(key, payload);
    self.postMessage({
        type: "view",
        requestId,
        payload,
    });
}

/**
 * Reset all worker state, clearing stored data and caches.
 */
function handleClear() {
    sharesData = null;
    commentsData = null;
    connectionsData = null;
    resetAnalyticsState();
    self.postMessage({ type: "cleared" });
}

/**
 * Cancel the read in flight and skip every request queued before now.
 */
function cancelPendingRequests() {
    requestEpoch += 1;
    // Stale reads may still be settling; they drop their results by epoch,
    // so nothing after the clear has to wait for them.
    requestQueue = Promise.resolve();
    if (activeRead) {
        activeRead.abort();
    }
}

/**
 * Run a request after the ones before it, unless a clear arrives first.
 * @param {() => unknown} run - Request handler
 * @param {RequestId} requestId - ID reported with a failure
 * @returns {Promise<void>}
 */
function enqueueRequest(run, requestId) {
    const epoch = requestEpoch;
    requestQueue = requestQueue.then(async () => {
        if (epoch !== requestEpoch) {
            return;
        }
        try {
            await run();
        } catch (error) {
            postError(requestId || 0, toErrorMessage(error));
        }
    });
    return requestQueue;
}

/**
 * Dispatch one raw worker message.
 * @param {MessageEvent} event - Worker message event
 * @returns {Promise<void>|undefined}
 */
function handleMessage(event) {
    const rawMessage = event.data || {};
    const type = rawMessage && typeof rawMessage.type === "string" ? rawMessage.type : "";
    if (!WORKER_REQUEST_TYPES.has(type)) {
        return undefined;
    }

    const parsed = parseAnalyticsWorkerRequest(rawMessage);
    /* v8 ignore next 4 */
    if (!parsed.valid) {
        postError(0, parsed.error || "Invalid analytics worker message.");
        return undefined;
    }

    const message = parsed.value;
    if (message.type === "clear") {
        cancelPendingRequests();
        handleClear();
        return undefined;
    }
    // Each case reads its own payload so the request type narrows it. Only a
    // view request carries an id; a failure in the others reports id zero.
    switch (message.type) {
        case "addFile": {
            const { payload } = message;
            return enqueueRequest(() => handleAddFile(payload), 0);
        }
        case "restoreFiles": {
            const { payload } = message;
            return enqueueRequest(() => handleRestoreFiles(payload), 0);
        }
        case "initBase": {
            const { payload } = message;
            return enqueueRequest(() => handleInitBase(payload), 0);
        }
        default: {
            const { requestId, filters } = message;
            return enqueueRequest(() => handleView(requestId, filters), requestId);
        }
    }
}

self.addEventListener("message", handleMessage);

self.addEventListener("error", (event) => {
    /* v8 ignore next */
    postError(0, toErrorMessage(event && event.error ? event.error : event && event.message));
});

self.addEventListener("unhandledrejection", (event) => {
    postError(0, toErrorMessage(event && event.reason));
});

export {
    normalizeFilters,
    getViewKey,
    handleAddFile,
    handleRestoreFiles,
    handleInitBase,
    handleView,
    handleClear,
};
