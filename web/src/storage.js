/* IndexedDB storage helpers with in-memory fallback support */

const FILE_SCHEMA_VERSION = 2;
const ANALYTICS_SCHEMA_VERSION = 2;

function normalizeStoredFile(record) {
    if (!record || typeof record !== "object") {
        return null;
    }
    const schemaVersion = Number(record.schemaVersion || 1);
    if (schemaVersion > FILE_SCHEMA_VERSION) {
        return null;
    }
    return {
        type: record.type,
        name: record.name,
        text: record.text,
        rowCount: Number(record.rowCount || 0),
        updatedAt: Number(record.updatedAt || 0),
        schemaVersion: FILE_SCHEMA_VERSION,
    };
}

function normalizeStoredAnalytics(record) {
    if (!record || typeof record !== "object") {
        return null;
    }
    const schemaVersion = Number(record.schemaVersion || 1);
    if (schemaVersion > ANALYTICS_SCHEMA_VERSION) {
        return null;
    }
    if (Object.prototype.hasOwnProperty.call(record, "data")) {
        return record.data;
    }
    return record;
}

function buildFilePayload(type, data) {
    return {
        type,
        name: data.name,
        text: data.text,
        rowCount: data.rowCount || 0,
        updatedAt: Date.now(),
        schemaVersion: FILE_SCHEMA_VERSION,
    };
}

function buildAnalyticsPayload(base) {
    return {
        id: "base",
        updatedAt: Date.now(),
        schemaVersion: ANALYTICS_SCHEMA_VERSION,
        data: base,
    };
}

export const Storage = (() => {
    "use strict";

    const DB_NAME = "linkedin-analyzer";
    const DB_VERSION = 2;
    const FILE_STORE = "files";
    const ANALYTICS_STORE = "analytics";

    /**
     * Build the in-memory store used both when IndexedDB is unavailable at load
     * time and as a runtime fallback if it later fails.
     * @returns {object} An object exposing the same async ops as the IDB store
     */
    function createMemoryStore() {
        const memFiles = new Map();
        let memAnalytics = null;
        return {
            saveFile: (type, data) => {
                memFiles.set(type, buildFilePayload(type, data));
                return Promise.resolve();
            },
            getFile: (type) => Promise.resolve(normalizeStoredFile(memFiles.get(type) || null)),
            getAllFiles: () =>
                Promise.resolve([...memFiles.values()].map(normalizeStoredFile).filter(Boolean)),
            saveAnalytics: (base) => {
                memAnalytics = buildAnalyticsPayload(base);
                return Promise.resolve();
            },
            getAnalytics: () => Promise.resolve(normalizeStoredAnalytics(memAnalytics)),
            clearAll: () => {
                memFiles.clear();
                memAnalytics = null;
                return Promise.resolve();
            },
        };
    }

    const memory = createMemoryStore();

    const idbAvailable = (() => {
        try {
            return typeof indexedDB !== "undefined" && indexedDB !== null;
        } catch {
            /* v8 ignore next */
            return false;
        }
    })();

    // Runtime persistence state. `persistent` starts true when IndexedDB looked
    // available; it flips to false the first time `openDB()` fails (private mode,
    // corruption) so every later op transparently uses the in-memory store.
    let persistent = idbAvailable;
    let dbPromise = null;
    const persistenceLostListeners = [];

    /**
     * Register a callback fired once when persistence degrades to memory at
     * runtime. Lets the UI surface a "won't persist" hint.
     * @param {(error: unknown) => void} listener
     */
    function onPersistenceLost(listener) {
        if (typeof listener === "function") {
            persistenceLostListeners.push(listener);
        }
    }

    /**
     * Switch to the in-memory store after an unrecoverable open failure and
     * notify listeners. Idempotent: only the first degrade notifies.
     * @param {unknown} error - The originating IndexedDB error
     */
    function degradeToMemory(error) {
        if (!persistent) {
            return;
        }
        persistent = false;
        dbPromise = null;
        for (const listener of persistenceLostListeners) {
            try {
                listener(error);
            } catch {
                /* v8 ignore next */
                // A faulty listener must not break the storage operation.
            }
        }
    }

    /**
     * Build an actionable Error for an IndexedDB failure event. Abort and blocked
     * events frequently carry a null `error`, so always return a descriptive Error
     * and attach the original (when present) as the cause for telemetry.
     * @param {DOMException|null} error - The native IndexedDB error, if any
     * @param {string} message - Human-readable description of the failure
     * @returns {Error} An Error suitable for rejecting the operation's promise
     */
    function idbFailure(error, message) {
        return new Error(message, { cause: error });
    }

    /**
     * Open the IndexedDB database, creating object stores on first run. The
     * resolved connection is memoized so every operation shares one connection;
     * an external version change closes it and drops the memo so the next call
     * reopens cleanly.
     * @returns {Promise<IDBDatabase>} The opened database instance
     */
    function openDB() {
        if (dbPromise) {
            return dbPromise;
        }
        dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = (event) => {
                const db = /** @type {IDBOpenDBRequest} */ (event.target).result;
                /* v8 ignore next 3 */
                if (!db.objectStoreNames.contains(FILE_STORE)) {
                    db.createObjectStore(FILE_STORE, { keyPath: "type" });
                }
                /* v8 ignore next 3 */
                if (!db.objectStoreNames.contains(ANALYTICS_STORE)) {
                    db.createObjectStore(ANALYTICS_STORE, { keyPath: "id" });
                }
            };
            request.onerror = () => reject(request.error);
            /* v8 ignore next */
            request.onblocked = () =>
                reject(idbFailure(request.error, "IndexedDB open blocked by another connection"));
            request.onsuccess = () => {
                const db = request.result;
                db.onversionchange = () => {
                    db.close();
                    dbPromise = null;
                };
                resolve(db);
            };
        });
        dbPromise.catch(() => {
            // Drop the rejected memo so a later attempt can reopen; the failing op
            // also degrades to the in-memory store via degradeToMemory().
            dbPromise = null;
        });
        return dbPromise;
    }

    /**
     * Run a storage operation, preferring IndexedDB but falling back to the
     * in-memory store (degrading permanently) when the database cannot be opened.
     * @param {() => Promise<*>} memoryOp - The in-memory implementation
     * @param {(db: IDBDatabase) => Promise<*>} idbOp - The IndexedDB implementation
     * @returns {Promise<*>}
     */
    async function runOp(memoryOp, idbOp) {
        if (!persistent) {
            return memoryOp();
        }
        let db;
        try {
            db = await openDB();
        } catch (error) {
            degradeToMemory(error);
            return memoryOp();
        }
        return idbOp(db);
    }

    /**
     * Execute a callback within an IndexedDB transaction on the shared connection.
     * @param {IDBDatabase} db - The shared database connection
     * @param {string} storeName - Name of the object store
     * @param {IDBTransactionMode} mode - Transaction mode ('readonly' or 'readwrite')
     * @param {function(IDBObjectStore): void} callback - Performs the write on the store
     * @returns {Promise<void>} Resolves when the transaction completes
     */
    function withStore(db, storeName, mode, callback) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, mode);
            const store = tx.objectStore(storeName);
            callback(store);
            const rejectFailure = () => reject(idbFailure(tx.error, "IndexedDB transaction failed"));
            // Resolve void on completion so the IndexedDB path matches the memory
            // fallback and the documented Promise<void> contract (rather than
            // leaking the IDBRequest returned by store.put).
            tx.oncomplete = () => resolve();
            tx.onerror = rejectFailure;
            tx.onabort = rejectFailure;
        });
    }

    /**
     * Save an uploaded CSV file record.
     * @param {string} type - File type key
     * @param {{name: string, text: string, rowCount: number}} data - File data to persist
     * @returns {Promise<void>}
     */
    function saveFile(type, data) {
        return runOp(
            () => memory.saveFile(type, data),
            (db) =>
                withStore(db, FILE_STORE, "readwrite", (store) =>
                    store.put(buildFilePayload(type, data)),
                ),
        );
    }

    /**
     * Retrieve a single file record by type.
     * @param {string} type - File type key
     * @returns {Promise<object|null>} The stored file record, or null if not found
     */
    function getFile(type) {
        return runOp(
            () => memory.getFile(type),
            (db) =>
                new Promise((resolve, reject) => {
                    const tx = db.transaction(FILE_STORE, "readonly");
                    const request = tx.objectStore(FILE_STORE).get(type);
                    request.onsuccess = () => resolve(normalizeStoredFile(request.result || null));
                    request.onerror = () => reject(request.error);
                }),
        );
    }

    /**
     * Retrieve all stored file records.
     * @returns {Promise<object[]>} Array of all stored file records
     */
    function getAllFiles() {
        return runOp(
            () => memory.getAllFiles(),
            (db) =>
                new Promise((resolve, reject) => {
                    const tx = db.transaction(FILE_STORE, "readonly");
                    const request = tx.objectStore(FILE_STORE).getAll();
                    /* v8 ignore next */
                    request.onsuccess = () =>
                        resolve((request.result || []).map(normalizeStoredFile).filter(Boolean));
                    request.onerror = () => reject(request.error);
                }),
        );
    }

    /**
     * Save pre-computed analytics aggregates.
     * @param {object} base - Serialized analytics data from the worker
     * @returns {Promise<void>}
     */
    function saveAnalytics(base) {
        return runOp(
            () => memory.saveAnalytics(base),
            (db) =>
                withStore(db, ANALYTICS_STORE, "readwrite", (store) =>
                    store.put(buildAnalyticsPayload(base)),
                ),
        );
    }

    /**
     * Retrieve stored analytics aggregates.
     * @returns {Promise<object|null>} The analytics data, or null if not stored
     */
    function getAnalytics() {
        return runOp(
            () => memory.getAnalytics(),
            (db) =>
                new Promise((resolve, reject) => {
                    const tx = db.transaction(ANALYTICS_STORE, "readonly");
                    const request = tx.objectStore(ANALYTICS_STORE).get("base");
                    request.onsuccess = () =>
                        resolve(normalizeStoredAnalytics(request.result || null));
                    request.onerror = () => reject(request.error);
                }),
        );
    }

    /**
     * Clear all stored files and analytics data.
     * @returns {Promise<void>}
     */
    function clearAll() {
        return runOp(
            () => memory.clearAll(),
            (db) =>
                new Promise((resolve, reject) => {
                    const tx = db.transaction([FILE_STORE, ANALYTICS_STORE], "readwrite");
                    tx.objectStore(FILE_STORE).clear();
                    tx.objectStore(ANALYTICS_STORE).clear();
                    const rejectFailure = () =>
                        reject(idbFailure(tx.error, "IndexedDB transaction failed"));
                    tx.oncomplete = () => resolve();
                    tx.onerror = rejectFailure;
                    tx.onabort = rejectFailure;
                }),
        );
    }

    return {
        isAvailable: idbAvailable,
        onPersistenceLost,
        saveFile,
        getFile,
        getAllFiles,
        saveAnalytics,
        getAnalytics,
        clearAll,
    };
})();
