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
 * Bucket navigator.deviceMemory. Only Chromium browsers expose it; anything
 * else reads as unknown, never as low.
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
 * Create a run tracker. Every browser API is injected so tests can drive it.
 * @param {object} deps
 * @param {Storage|null} deps.localStorage - Marker storage; null disables tracking
 * @param {Storage|null} deps.sessionStorage - Per-tab ID storage
 * @param {((name: string) => BroadcastChannel)|null} deps.createChannel - BroadcastChannel factory
 * @param {Window|null} deps.target - Where pagehide and pageshow fire
 * @param {() => number} deps.now - Clock
 * @param {() => string} deps.randomId - Unique ID source
 * @returns {RunTrackerApi}
 */
export function createRunTracker({
    localStorage,
    sessionStorage,
    createChannel,
    target,
    now,
    randomId,
}) {
    if (!localStorage) {
        return { start() {}, finish() {}, checkPrevious: async () => {} };
    }
    const markers = localStorage;
    let tabId = "";
    let activeKey = "";
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
            // Storage full or blocked: the run simply goes untracked.
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
    /** @param {Partial<RunMarker>} changes - Fields to change; undefined removes one */
    const update = (changes) => {
        const marker = activeKey ? readMarker(markers, activeKey) : null;
        if (marker) {
            /** @type {Partial<RunMarker>} */
            const next = { ...marker, ...changes };
            /** @type {Array<keyof RunMarker>} */ (Object.keys(changes)).forEach((key) => {
                if (changes[key] === undefined) {
                    delete next[key];
                }
            });
            write(activeKey, next);
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

    const onPageHide = () => update({ leftAt: now() });
    // A page restored from the back/forward cache is still running its run.
    const onPageShow = (/** @type {PageTransitionEvent} */ event) => {
        if (event && event.persisted) {
            update({ leftAt: undefined, heartbeatAt: now() });
        }
    };

    /**
     * Start tracking a processing run, or refresh the current one when another
     * upload joins it before it finishes.
     * @param {{ totalBytes: number, fileCount: number }} run - Combined size and file count
     */
    function start({ totalBytes, fileCount }) {
        const mode = fileCount > 1 ? "parallel" : "single";
        if (activeKey) {
            update({ sizeBucket: sizeBucket(totalBytes), mode, heartbeatAt: now() });
            return;
        }
        activeKey = `${MARKER_PREFIX}${randomId()}`;
        const startedAt = now();
        write(activeKey, {
            tabId: getTabId(),
            startedAt,
            heartbeatAt: startedAt,
            sizeBucket: sizeBucket(totalBytes),
            mode,
        });
        getChannel();
        heartbeatTimer = setInterval(() => update({ heartbeatAt: now() }), HEARTBEAT_MS);
        if (target) {
            target.addEventListener("pagehide", onPageHide);
            target.addEventListener("pageshow", onPageShow);
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
        if (target) {
            target.removeEventListener("pagehide", onPageHide);
            target.removeEventListener("pageshow", onPageShow);
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
        const marker = readMarker(markers, key);
        if (!marker || marker.leftAt) {
            remove(key);
            return;
        }
        if (await ownedElsewhere(key)) {
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
        remove(key);
        onUnfinished({ sizeBucket: marker.sizeBucket, mode: marker.mode });
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
});
