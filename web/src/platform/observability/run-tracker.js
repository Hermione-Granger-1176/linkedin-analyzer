/*
 * Notice processing runs that did not finish.
 *
 * A tab the browser kills cannot report anything as it dies, so each run
 * leaves a marker in localStorage and the next visit checks for leftovers. A
 * leftover marker is not proof of a crash: a reload, a closed tab, or a run
 * still going in another tab can look the same. The checks below separate
 * those cases where they can, and nothing here claims more than "did not
 * finish".
 *
 * Markers hold no file names and no contents: only the owning tab ID, the
 * start and heartbeat times, the combined size as a bucket, and whether files
 * ran one at a time or in parallel.
 */

const MARKER_PREFIX = "linkedin-analyzer:run:";
const TAB_ID_KEY = "linkedin-analyzer:tab-id";
const CHANNEL_NAME = "linkedin-analyzer:runs";
export const HEARTBEAT_MS = 5000;
// Three missed heartbeats before a run with no answering owner counts as stale.
export const STALE_MS = 3 * HEARTBEAT_MS;
// How long to wait for another tab to claim a run before treating it as orphaned.
const OWNER_REPLY_MS = 300;
const MB = 1024 * 1024;

/**
 * The localStorage marker a processing run leaves until it finishes.
 * @typedef {object} RunMarker
 * @property {string} tabId - Owning tab ID
 * @property {number} startedAt - Run start time (ms)
 * @property {number} heartbeatAt - Latest heartbeat time (ms)
 * @property {string} sizeBucket - Combined upload size bucket
 * @property {string} mode - "single" or "parallel"
 * @property {number} [leftAt] - When the page was hidden mid-run (ms)
 */

/**
 * What is reported about a run that did not finish.
 * @typedef {{ sizeBucket: string, mode: string }} UnfinishedRun
 */

/**
 * @typedef {object} RunTrackerApi
 * @property {(run: { totalBytes: number, fileCount: number }) => void} start - Start a run
 * @property {() => void} finish - Stop tracking the current run
 * @property {(onUnfinished: (run: UnfinishedRun) => void) => Promise<void>} checkPrevious - Report
 * runs from earlier visits that did not finish
 */

const SIZE_BUCKETS = Object.freeze([
    { id: "lt-10mb", max: 10 * MB },
    { id: "10-30mb", max: 30 * MB },
    { id: "30-60mb", max: 60 * MB },
    { id: "60-100mb", max: 100 * MB },
    { id: "gte-100mb", max: Infinity },
]);

/**
 * Bucket a combined upload size so markers and telemetry never hold exact sizes.
 * @param {number} bytes - Combined file size
 * @returns {string}
 */
export function sizeBucket(bytes) {
    const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
    return /** @type {{ id: string }} */ (SIZE_BUCKETS.find((bucket) => safe < bucket.max)).id;
}

/**
 * Bucket navigator.deviceMemory. Missing or invalid values return "unknown".
 * @param {unknown} deviceMemory - navigator.deviceMemory
 * @returns {string}
 */
export function memoryBucket(deviceMemory) {
    if (typeof deviceMemory !== "number" || !Number.isFinite(deviceMemory) || deviceMemory <= 0) {
        return "unknown";
    }
    if (deviceMemory <= 2) {
        return "le-2gb";
    }
    return deviceMemory <= 4 ? "4gb" : "ge-8gb";
}

/**
 * Read a JSON marker, or null when it is missing or malformed.
 * @param {Storage} storage - localStorage
 * @param {string} key - Marker key
 * @returns {RunMarker|null}
 */
function readMarker(storage, key) {
    try {
        const marker = JSON.parse(storage.getItem(key) || "null");
        return marker && typeof marker === "object" && typeof marker.heartbeatAt === "number"
            ? marker
            : null;
    } catch {
        return null;
    }
}

/**
 * @typedef {object} ActiveRun
 * @property {Record<string, unknown>} marker - Marker as stored
 * @property {number} totalBytes - Bytes of every upload in the run so far
 * @property {number} fileCount - Files in the run so far
 */

/**
 * Create a run tracker. Every browser API is injected so tests can drive it.
 * @param {object} deps
 * @param {Storage|null} deps.localStorage - Marker storage; null disables tracking
 * @param {Storage|null} deps.sessionStorage - Per-tab ID storage
 * @param {((name: string) => BroadcastChannel)|null} deps.createChannel - BroadcastChannel factory
 * @param {Window|null} deps.target - Where page lifecycle events fire
 * @param {() => number} deps.now - Clock
 * @param {() => string} deps.randomId - Unique ID source
 * @param {LockManager|null} [deps.locks] - Web Locks, which keep two tabs from reporting one run
 * @returns {RunTrackerApi}
 */
export function createRunTracker({
    localStorage,
    sessionStorage,
    createChannel,
    target,
    now,
    randomId,
    locks = null,
}) {
    if (!localStorage) {
        return { start() {}, finish() {}, checkPrevious: async () => {} };
    }
    const markers = localStorage;
    let tabId = "";
    let activeKey = "";
    /** @type {ActiveRun|null} */
    let active = null;
    // Lifecycle listeners and the heartbeat exist only while a run is active.
    const current = () => /** @type {ActiveRun} */ (active);
    /** @type {ReturnType<typeof setInterval>|undefined} */
    let heartbeatTimer;
    /** @type {BroadcastChannel|null} */
    let channel = null;

    /**
     * @param {string} key - Marker key
     * @param {Partial<RunMarker>} marker - Marker to store
     */
    const write = (key, marker) => {
        try {
            markers.setItem(key, JSON.stringify(marker));
        } catch {
            // Full or blocked storage prevents tracking this run.
        }
    };
    /** @param {string} key - Marker key */
    const remove = (key) => {
        try {
            markers.removeItem(key);
        } catch {
            // Ignore blocked storage.
        }
    };
    // The marker lives in memory and every write stores all of it, so a marker
    // another tab removed while this one was hidden or frozen comes back.
    const save = () => {
        if (active) {
            write(activeKey, active.marker);
        }
    };

    const getTabId = () => {
        if (tabId) {
            return tabId;
        }
        try {
            tabId = (sessionStorage && sessionStorage.getItem(TAB_ID_KEY)) || "";
            if (!tabId) {
                tabId = randomId();
                if (sessionStorage) {
                    sessionStorage.setItem(TAB_ID_KEY, tabId);
                }
            }
        } catch {
            tabId = tabId || randomId();
        }
        return tabId;
    };

    const getChannel = () => {
        if (!channel && createChannel) {
            try {
                const created = createChannel(CHANNEL_NAME);
                channel = created;
                created.addEventListener("message", (event) => {
                    const data = event.data || {};
                    if (data.type === "who-owns" && activeKey && data.key === activeKey) {
                        created.postMessage({ type: "owns", key: data.key });
                    }
                });
            } catch {
                channel = null;
            }
        }
        return channel;
    };

    /**
     * Ask other open tabs whether one of them owns a run.
     * @param {string} key - Marker key
     * @returns {Promise<boolean>}
     */
    const ownedElsewhere = (key) => {
        if (!createChannel) {
            return Promise.resolve(false);
        }
        return new Promise((resolve) => {
            // A tab never hears its own posts, so ask on a second channel object.
            /** @type {BroadcastChannel} */
            let asker;
            try {
                asker = createChannel(CHANNEL_NAME);
            } catch {
                resolve(false);
                return;
            }
            const settle = (/** @type {boolean} */ owned) => {
                asker.close();
                resolve(owned);
            };
            const timer = setTimeout(() => settle(false), OWNER_REPLY_MS);
            asker.addEventListener("message", (event) => {
                const data = event.data || {};
                if (data.type === "owns" && data.key === key) {
                    clearTimeout(timer);
                    settle(true);
                }
            });
            asker.postMessage({ type: "who-owns", key });
        });
    };

    const onPageHide = () => {
        current().marker.leftAt = now();
        save();
    };
    // A page restored from the back/forward cache, or a frozen tab that
    // resumes, is still running its run.
    /** @param {Event & { persisted?: boolean }} event */
    const onPageShow = (event) => {
        if (event.type === "resume" || event.persisted) {
            delete current().marker.leftAt;
            current().marker.heartbeatAt = now();
            save();
        }
    };
    /** @type {Array<[string, (event: Event) => void]>} */
    const lifecycleEvents = [
        ["pagehide", onPageHide],
        // A frozen tab cannot answer an ownership check, so it counts as left.
    // freeze and resume fire on the document without bubbling, so the
    // listeners use capture to hear them from the window.
        ["freeze", onPageHide],
        ["pageshow", onPageShow],
        ["resume", onPageShow],
    ];

    /**
     * Start tracking a processing run, or add to the current one when another
     * upload joins it before it finishes.
     * @param {{ totalBytes: number, fileCount: number }} run - Size and file count of this upload
     */
    function start({ totalBytes, fileCount }) {
        if (active) {
            active.totalBytes += totalBytes;
            active.fileCount += fileCount;
            active.marker.sizeBucket = sizeBucket(active.totalBytes);
            active.marker.mode = active.fileCount > 1 ? "parallel" : "single";
            active.marker.heartbeatAt = now();
            save();
            return;
        }
        activeKey = `${MARKER_PREFIX}${randomId()}`;
        const startedAt = now();
        active = {
            totalBytes,
            fileCount,
            marker: {
                tabId: getTabId(),
                startedAt,
                heartbeatAt: startedAt,
                sizeBucket: sizeBucket(totalBytes),
                mode: fileCount > 1 ? "parallel" : "single",
            },
        };
        save();
        getChannel();
        heartbeatTimer = setInterval(() => {
            current().marker.heartbeatAt = now();
            save();
        }, HEARTBEAT_MS);
        if (target) {
            lifecycleEvents.forEach(([type, listener]) => target.addEventListener(type, listener, true));
        }
    }

    /** Stop tracking: the run finished or failed with a normal error. */
    function finish() {
        if (!activeKey) {
            return;
        }
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
        remove(activeKey);
        activeKey = "";
        active = null;
        if (target) {
            lifecycleEvents.forEach(([type, listener]) => target.removeEventListener(type, listener, true));
        }
    }

    /**
     * Find runs from earlier visits that did not finish, removing their markers.
     * A run with a recent heartbeat and no answering owner is checked again
     * once it would turn stale, so a crash followed by a quick reopen still
     * reports.
     * @param {(run: UnfinishedRun) => void} onUnfinished - Called once per unfinished run
     * @returns {Promise<void>}
     */
    async function checkPrevious(onUnfinished) {
        let keys = [];
        try {
            keys = Object.keys(markers).filter(
                (key) => key.startsWith(MARKER_PREFIX) && key !== activeKey,
            );
        } catch {
            return;
        }
        await Promise.all(keys.map((key) => checkMarker(key, onUnfinished)));
    }

    /**
     * Check one leftover marker, reporting it once it is stale and unowned.
     * @param {string} key - Marker key
     * @param {(run: UnfinishedRun) => void} onUnfinished - Called if the run did not finish
     * @returns {Promise<void>}
     */
    async function checkMarker(key, onUnfinished) {
        const seen = readMarker(markers, key);
        if (!seen || seen.leftAt) {
            remove(key);
            return;
        }
        if (await ownedElsewhere(key)) {
            return;
        }
        // The owner may have finished or left while the question was out.
        const marker = readMarker(markers, key);
        if (!marker || marker.leftAt) {
            remove(key);
            return;
        }
        const age = now() - marker.heartbeatAt;
        if (age < STALE_MS) {
            setTimeout(() => {
                const latest = readMarker(markers, key);
                if (latest && latest.heartbeatAt === marker.heartbeatAt) {
                    checkMarker(key, onUnfinished);
                }
            }, STALE_MS - age);
            return;
        }
        await exclusively(key, () => {
            // Another tab may have reported and removed it, or the run moved on.
            const latest = readMarker(markers, key);
            if (!latest || latest.leftAt || latest.heartbeatAt !== marker.heartbeatAt) {
                return;
            }
            remove(key);
            onUnfinished({ sizeBucket: latest.sizeBucket, mode: latest.mode });
        });
    }

    /**
     * Run the final check and report for one marker in one tab at a time, so
     * two tabs that open together cannot both report it. Without Web Locks the
     * report runs unguarded.
     * @param {string} key - Marker key
     * @param {() => void} report - Final check and report
     * @returns {Promise<void>}
     */
    async function exclusively(key, report) {
        if (!locks) {
            report();
            return;
        }
        try {
            await locks.request(`${key}:report`, { ifAvailable: true }, (lock) => {
                if (lock) {
                    report();
                }
            });
        } catch {
            report();
        }
    }

    return { start, finish, checkPrevious };
}

/**
 * Read a storage object, or null when the browser blocks it.
 * @param {"localStorage"|"sessionStorage"} name - Storage name
 * @returns {Storage|null}
 */
function safeStorage(name) {
    try {
        return window[name];
    } catch {
        return null;
    }
}

export const RunTracker = createRunTracker({
    localStorage: safeStorage("localStorage"),
    sessionStorage: safeStorage("sessionStorage"),
    createChannel:
        typeof BroadcastChannel === "function" ? (name) => new BroadcastChannel(name) : null,
    target: typeof window === "undefined" ? null : window,
    now: () => Date.now(),
    randomId: () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    locks: typeof navigator !== "undefined" && navigator.locks ? navigator.locks : null,
});
