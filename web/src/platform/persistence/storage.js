/* IndexedDB storage with an in-memory fallback. */

const FILE_SCHEMA_VERSION = 3;
const ANALYTICS_SCHEMA_VERSION = 2;

/**
 * A stored upload with its contents, as `Storage.getFile` returns it.
 * @typedef {object} StoredFile
 * @property {string} type - File type key
 * @property {string} name - Uploaded file name
 * @property {Blob|null} blob - File contents
 * @property {number} size - Content size in bytes
 * @property {number} rowCount - Processed row count
 * @property {number} updatedAt - Last update timestamp (ms)
 * @property {number} schemaVersion - Record schema version
 */

/**
 * A stored upload without its contents, as `Storage.getAllFiles` lists it.
 * @typedef {Omit<StoredFile, "blob">} StoredFileMetadata
 */

/**
 * File data accepted by `Storage.saveFile`.
 * @typedef {object} StoredFileInput
 * @property {string} name - Uploaded file name
 * @property {Blob} [blob] - Original upload
 * @property {string} [text] - CSV text, stored as a Blob
 * @property {number} [rowCount] - Processed row count
 */

/**
 * A file record as read back from a store, written by any schema version.
 * @typedef {object} RawStoredFileRecord
 * @property {string} type - File type key
 * @property {string} name - Uploaded file name
 * @property {unknown} [blob] - Stored Blob, or its bytes where IndexedDB refused the Blob
 * @property {unknown} [text] - Legacy CSV text, from before the DB version 4 blob store
 * @property {number} [size] - Content size in bytes
 * @property {number} [rowCount] - Processed row count
 * @property {number} [updatedAt] - Last update timestamp (ms)
 * @property {number} [schemaVersion] - Record schema version
 */

/** @typedef {Record<string, unknown>} StoredAnalytics - Stored analytics or outreach data */

/**
 * The analytics-store record wrapping analytics or outreach data.
 * @typedef {object} AnalyticsRecord
 * @property {"base"|"outreach"} id - Record key
 * @property {number} updatedAt - Last update timestamp (ms)
 * @property {number} schemaVersion - Record schema version
 * @property {StoredAnalytics} data - Stored analytics or outreach data
 */

/**
 * The async operations shared by the IndexedDB and in-memory stores.
 * @typedef {object} StorageOps
 * @property {(type: string, data: StoredFileInput) => Promise<void>} saveFile - Save a file
 * @property {(type: string) => Promise<StoredFile|null>} getFile - Read one file
 * @property {() => Promise<StoredFileMetadata[]>} getAllFiles - List file metadata
 * @property {(base: StoredAnalytics) => Promise<void>} saveAnalytics - Save analytics
 * @property {() => Promise<StoredAnalytics|null>} getAnalytics - Read analytics
 * @property {(outreach: StoredAnalytics) => Promise<void>} saveOutreach - Save outreach summary
 * @property {() => Promise<StoredAnalytics|null>} getOutreach - Read outreach summary
 * @property {() => Promise<void>} clearAll - Clear everything
 */

/**
 * Wrap stored CSV contents as a File: text from a record stored before the DB
 * version 4 blob store, or the bytes a browser that refuses Blobs in IndexedDB
 * stored instead. Every reader receives the same shape whichever path wrote the
 * record.
 * @param {string|ArrayBuffer} text - Stored CSV text or bytes
 * @param {string} name - Stored file name
 * @returns {Blob}
 */
function textToBlob(text, name) {
    const options = { type: "text/csv" };
    /* v8 ignore next 3 */
    if (typeof File !== "function") {
        return new Blob([text], options);
    }
    return new File([text], name || "file.csv", options);
}

/**
 * Pick the stored file contents: the original Blob, or legacy text wrapped as one.
 * @param {unknown} blob - Stored Blob, if any
 * @param {unknown} text - Legacy stored text, if any
 * @param {string} name - Stored file name
 * @returns {Blob|null}
 */
function resolveStoredBlob(blob, text, name) {
    if (typeof Blob !== "undefined" && blob instanceof Blob) {
        return blob;
    }
    if (blob instanceof ArrayBuffer) {
        return textToBlob(blob, name);
    }
    if (typeof text === "string" && text) {
        return textToBlob(text, name);
    }
    return null;
}

/**
 * Keep the records that normalized; a filter predicate that narrows out null.
 * @template T
 * @param {T|null} value - Normalized record, or null
 * @returns {value is T}
 */
function isPresent(value) {
    return Boolean(value);
}

/**
 * Normalize a stored file record to the current schema, with its contents.
 * @param {RawStoredFileRecord|null} record - Raw stored record
 * @returns {StoredFile|null}
 */
function normalizeStoredFile(record) {
    if (!record || typeof record !== "object") {
        return null;
    }
    const schemaVersion = Number(record.schemaVersion || 1);
    if (schemaVersion > FILE_SCHEMA_VERSION) {
        return null;
    }
    const blob = resolveStoredBlob(record.blob, record.text, record.name);
    return {
        type: record.type,
        name: record.name,
        blob,
        size: blob ? blob.size : 0,
        rowCount: Number(record.rowCount || 0),
        updatedAt: Number(record.updatedAt || 0),
        schemaVersion: FILE_SCHEMA_VERSION,
    };
}

/**
 * Normalize a stored file record to metadata only (no file contents). Used by
 * the metadata reads so large exports are not loaded when listing files.
 * @param {RawStoredFileRecord|null} record - Raw stored record
 * @returns {StoredFileMetadata|null}
 */
function normalizeStoredFileMetadata(record) {
    const normalized = normalizeStoredFile(record);
    if (!normalized) {
        return null;
    }
    return {
        type: normalized.type,
        name: normalized.name,
        size: Number(/** @type {RawStoredFileRecord} */ (record).size || normalized.size || 0),
        rowCount: normalized.rowCount,
        updatedAt: normalized.updatedAt,
        schemaVersion: normalized.schemaVersion,
    };
}

/**
 * Unwrap stored analytics or outreach data, accepting records written before
 * the data was wrapped.
 * @param {AnalyticsRecord|StoredAnalytics|null} record - Raw stored record
 * @returns {StoredAnalytics|null}
 */
function normalizeStoredAnalytics(record) {
    if (!record || typeof record !== "object") {
        return null;
    }
    const schemaVersion = Number(record.schemaVersion || 1);
    if (schemaVersion > ANALYTICS_SCHEMA_VERSION) {
        return null;
    }
    if (Object.prototype.hasOwnProperty.call(record, "data")) {
        return /** @type {StoredAnalytics} */ (record.data);
    }
    return record;
}

/**
 * Build the record for an uploaded file. Callers pass the original upload as
 * `blob`; `text` is still accepted and stored as a Blob.
 * @param {string} type - File type key
 * @param {StoredFileInput} data - File data
 * @returns {StoredFile}
 */
function buildFilePayload(type, data) {
    const blob = resolveStoredBlob(data.blob, data.text, data.name);
    return {
        type,
        name: data.name,
        blob,
        size: blob ? blob.size : 0,
        rowCount: data.rowCount || 0,
        updatedAt: Date.now(),
        schemaVersion: FILE_SCHEMA_VERSION,
    };
}

/**
 * Wrap analytics data in its store record.
 * @param {StoredAnalytics} base - Analytics aggregate base
 * @returns {AnalyticsRecord}
 */
function buildAnalyticsPayload(base) {
    return {
        id: "base",
        updatedAt: Date.now(),
        schemaVersion: ANALYTICS_SCHEMA_VERSION,
        data: base,
    };
}

/**
 * Wrap the outreach summary in its store record.
 * @param {StoredAnalytics} outreach - Outreach summary
 * @returns {AnalyticsRecord}
 */
function buildOutreachPayload(outreach) {
    return {
        id: "outreach",
        updatedAt: Date.now(),
        schemaVersion: ANALYTICS_SCHEMA_VERSION,
        data: outreach,
    };
}

const BLOB_PROBE_DB = "linkedin-analyzer-blob-probe";
const BLOB_PROBE_TIMEOUT_MS = 2000;

/**
 * Probe Blob persistence in a temporary IndexedDB database.
 * Some WebKit ephemeral sessions reject Blob writes or leave them pending.
 * Use a separate database and a timeout so the probe cannot block uploads.
 * Store byte arrays for this session if the probe fails.
 * @param {{idb?: IDBFactory, timeoutMs?: number}} [options] - Overridable for tests
 * @returns {Promise<boolean>}
 */
export function probeBlobStorage({ idb = indexedDB, timeoutMs = BLOB_PROBE_TIMEOUT_MS } = {}) {
    return new Promise((resolve) => {
        let settled = false;
        /** @type {IDBDatabase|null} */
        let db = null;
        const finish = (/** @type {boolean} */ supported) => {
            if (settled) {
                return;
            }
            settled = true;
            globalThis.clearTimeout(timer);
            if (db) {
                db.close();
            }
            try {
                idb.deleteDatabase(BLOB_PROBE_DB);
            } catch {
                // Ignore cleanup failure for the temporary probe database.
            }
            resolve(supported);
        };
        const timer = globalThis.setTimeout(() => finish(false), timeoutMs);
        try {
            const request = idb.open(BLOB_PROBE_DB, 1);
            request.onupgradeneeded = () => {
                request.result.createObjectStore("probe");
            };
            request.onerror = () => finish(false);
            request.onsuccess = () => {
                if (settled) {
                    // The probe already gave up; release the late connection.
                    request.result.close();
                    return;
                }
                db = request.result;
                try {
                    const tx = db.transaction("probe", "readwrite");
                    const store = tx.objectStore("probe");
                    store.put(new Blob(["probe"]), "probe");
                    const read = store.get("probe");
                    tx.onabort = () => finish(false);
                    tx.oncomplete = () => {
                        const stored = read.result;
                        if (!(stored instanceof Blob)) {
                            finish(false);
                            return;
                        }
                        stored.text().then(
                            (text) => finish(text === "probe"),
                            () => finish(false),
                        );
                    };
                } catch {
                    finish(false);
                }
            };
        } catch {
            finish(false);
        }
    });
}

export const Storage = (() => {
    "use strict";

    const DB_NAME = "linkedin-analyzer";
    const DB_VERSION = 4;
    const FILE_STORE = "files";
    // Version 3 stored decoded text here. Version 4 stores the original upload
    // in FILE_BLOB_STORE and reads this store only for records written before.
    const FILE_TEXT_STORE = "fileTexts";
    const FILE_BLOB_STORE = "fileBlobs";
    const ANALYTICS_STORE = "analytics";

    /**
     * Build the in-memory store used when IndexedDB is unavailable at load time
     * or when opening the database later fails.
     * @returns {StorageOps} An object exposing the same async ops as the IDB store
     */
    function createMemoryStore() {
        /** @type {Map<string, StoredFile>} */
        const memFiles = new Map();
        /** @type {AnalyticsRecord|null} */
        let memAnalytics = null;
        /** @type {AnalyticsRecord|null} */
        let memOutreach = null;
        return {
            saveFile: (type, data) => {
                memFiles.set(type, buildFilePayload(type, data));
                return Promise.resolve();
            },
            getFile: (type) => Promise.resolve(normalizeStoredFile(memFiles.get(type) || null)),
            getAllFiles: () =>
                Promise.resolve(
                    [...memFiles.values()].map(normalizeStoredFileMetadata).filter(isPresent),
                ),
            saveAnalytics: (base) => {
                memAnalytics = buildAnalyticsPayload(base);
                return Promise.resolve();
            },
            getAnalytics: () => Promise.resolve(normalizeStoredAnalytics(memAnalytics)),
            saveOutreach: (outreach) => {
                memOutreach = buildOutreachPayload(outreach);
                return Promise.resolve();
            },
            getOutreach: () => Promise.resolve(normalizeStoredAnalytics(memOutreach)),
            clearAll: () => {
                memFiles.clear();
                memAnalytics = null;
                memOutreach = null;
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
    /** @type {Promise<IDBDatabase>|null} */
    let dbPromise = null;
    /** @type {Array<(error: unknown) => void>} */
    const persistenceLostListeners = [];

    /**
     * Register a callback fired once when persistence degrades to memory at
     * runtime. Lets the UI show a "won't persist" hint.
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
     * Move inline CSV text from existing (pre-v3) file records into the dedicated
     * text store and strip it from the metadata store, so metadata reads no longer
     * load text. Runs inside the versionchange transaction, so it is atomic with
     * the rest of the upgrade. An interrupted upgrade rolls back and retries.
     * @param {IDBTransaction|null} tx - The active versionchange transaction
     */
    function migrateInlineTextToTextStore(tx) {
        /* v8 ignore next 3 */
        if (!tx) {
            return;
        }
        const fileStore = tx.objectStore(FILE_STORE);
        const textStore = tx.objectStore(FILE_TEXT_STORE);
        fileStore.openCursor().onsuccess = (event) => {
            const cursor = /** @type {IDBRequest<IDBCursorWithValue>} */ (event.target).result;
            if (!cursor) {
                return;
            }
            const record = cursor.value;
            if (record && typeof record.text === "string") {
                textStore.put({ type: record.type, text: record.text });
                const metadata = { ...record };
                delete metadata.text;
                cursor.update(metadata);
            }
            cursor.continue();
        };
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
                const target = /** @type {IDBOpenDBRequest} */ (event.target);
                const db = target.result;
                if (!db.objectStoreNames.contains(FILE_STORE)) {
                    db.createObjectStore(FILE_STORE, { keyPath: "type" });
                }
                /* v8 ignore next 3 */
                if (!db.objectStoreNames.contains(ANALYTICS_STORE)) {
                    db.createObjectStore(ANALYTICS_STORE, { keyPath: "id" });
                }
                if (!db.objectStoreNames.contains(FILE_TEXT_STORE)) {
                    db.createObjectStore(FILE_TEXT_STORE, { keyPath: "type" });
                    migrateInlineTextToTextStore(target.transaction);
                }
                // Existing text records stay where they are and are read as
                // Blobs; the next upload of each type replaces its text record.
                if (!db.objectStoreNames.contains(FILE_BLOB_STORE)) {
                    db.createObjectStore(FILE_BLOB_STORE, { keyPath: "type" });
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
     * @template T
     * @param {() => Promise<T>} memoryOp - The in-memory implementation
     * @param {(db: IDBDatabase) => Promise<T>} idbOp - The IndexedDB implementation
     * @returns {Promise<T>}
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
     * Save an uploaded file and its metadata.
     * Prefer Blob persistence so the browser can manage the file's backing storage.
     * @param {string} type - File type key
     * @param {StoredFileInput & {rowCount: number}} data - File data to persist
     * @returns {Promise<void>}
     */
    function saveFile(type, data) {
        // Writes of one type land in call order. The byte fallback awaits each
        // file's read before writing, so a later save could otherwise finish
        // first and be overwritten by an earlier one.
        const previous = fileWrites.get(type) || Promise.resolve();
        const write = previous.then(
            () => writeFile(type, data),
            () => writeFile(type, data),
        );
        fileWrites.set(type, write);
        const release = () => {
            if (fileWrites.get(type) === write) {
                fileWrites.delete(type);
            }
        };
        write.then(release, release);
        return write;
    }

    /** @type {Map<string, Promise<void>>} */
    const fileWrites = new Map();

    /**
     * Write one uploaded CSV file record.
     * @param {string} type - File type key
     * @param {StoredFileInput & {rowCount: number}} data - File data to persist
     * @returns {Promise<void>}
     */
    function writeFile(type, data) {
        return runOp(
            () => memory.saveFile(type, data),
            async (db) => {
                const { blob, ...metadata } = buildFilePayload(type, data);
                if (blob && !(await canStoreBlobs())) {
                    await putFileRecord(db, metadata, await blob.arrayBuffer());
                    return;
                }
                try {
                    await putFileRecord(db, metadata, blob);
                } catch (error) {
                    // If the Blob write fails, retry with its bytes.
                    if (!blob) {
                        throw error;
                    }
                    await putFileRecord(db, metadata, await blob.arrayBuffer());
                }
            },
        );
    }

    /** @type {Promise<boolean>|null} */
    let blobSupport = null;

    /**
     * Whether this session can store Blobs in IndexedDB, probed once.
     * @returns {Promise<boolean>}
     */
    function canStoreBlobs() {
        if (!blobSupport) {
            blobSupport = probeBlobStorage();
        }
        return blobSupport;
    }

    /**
     * Write a file's metadata and contents in one transaction.
     * @param {IDBDatabase} db - The shared database connection
     * @param {{type: string}} metadata - File metadata
     * @param {Blob|ArrayBuffer|null} contents - The upload, or its bytes
     * @returns {Promise<void>}
     */
    function putFileRecord(db, metadata, contents) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction([FILE_STORE, FILE_BLOB_STORE, FILE_TEXT_STORE], "readwrite");
            const rejectFailure = () =>
                reject(idbFailure(tx.error, "IndexedDB transaction failed"));
            tx.oncomplete = () => resolve();
            tx.onerror = rejectFailure;
            tx.onabort = rejectFailure;
            try {
                tx.objectStore(FILE_STORE).put(metadata);
                tx.objectStore(FILE_BLOB_STORE).put({ type: metadata.type, blob: contents });
                tx.objectStore(FILE_TEXT_STORE).delete(metadata.type);
            } catch (error) {
                // A put that throws leaves the transaction open; abort it so
                // the metadata is not committed without its contents.
                try {
                    tx.abort();
                } catch {
                    // Already finished; the rejection below still reports it.
                }
                reject(error);
            }
        });
    }

    /**
     * Retrieve a single file record by type, with its contents as `blob`.
     * @param {string} type - File type key
     * @returns {Promise<StoredFile|null>} The stored file record, or null if not found
     */
    function getFile(type) {
        return runOp(
            () => memory.getFile(type),
            (db) =>
                new Promise((resolve, reject) => {
                    const tx = db.transaction(
                        [FILE_STORE, FILE_BLOB_STORE, FILE_TEXT_STORE],
                        "readonly",
                    );
                    const metaRequest = tx.objectStore(FILE_STORE).get(type);
                    const blobRequest = tx.objectStore(FILE_BLOB_STORE).get(type);
                    const textRequest = tx.objectStore(FILE_TEXT_STORE).get(type);
                    tx.oncomplete = () => {
                        const metadata = metaRequest.result || null;
                        if (!metadata) {
                            resolve(null);
                            return;
                        }
                        // Prefer the stored Blob; fall back to a version 3 text
                        // record, then to inline text on a record older than that.
                        const blobRecord = blobRequest.result || null;
                        const textRecord = textRequest.result || null;
                        const text =
                            textRecord && typeof textRecord.text === "string"
                                ? textRecord.text
                                : metadata.text;
                        resolve(
                            normalizeStoredFile({
                                ...metadata,
                                blob: blobRecord ? blobRecord.blob : null,
                                text,
                            }),
                        );
                    };
                    // tx.error is null on explicit aborts/quota, so wrap it in a
                    // descriptive Error (matching the other transaction paths) so
                    // callers and telemetry always get an actionable Error.
                    const rejectFailure = () =>
                        reject(idbFailure(tx.error, "IndexedDB transaction failed"));
                    tx.onerror = rejectFailure;
                    tx.onabort = rejectFailure;
                }),
        );
    }

    /**
     * Retrieve metadata records (no CSV text) for all stored files.
     * @returns {Promise<StoredFileMetadata[]>} Array of stored file metadata records
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
                        resolve(
                            (request.result || [])
                                .map(normalizeStoredFileMetadata)
                                .filter(isPresent),
                        );
                    request.onerror = () => reject(request.error);
                }),
        );
    }

    /**
     * Save pre-computed analytics aggregates.
     * @param {StoredAnalytics} base - Serialized analytics data from the worker
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
     * @returns {Promise<StoredAnalytics|null>} The analytics data, or null if not stored
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
     * Persist the lifetime outreach-funnel summary so the Insights page can show
     * it without loading the message export. The payload is a small numeric
     * object, shares the analytics store, and is keyed separately from "base".
     * @param {StoredAnalytics} outreach - Outreach summary from the messages worker
     * @returns {Promise<void>}
     */
    function saveOutreach(outreach) {
        return runOp(
            () => memory.saveOutreach(outreach),
            (db) =>
                withStore(db, ANALYTICS_STORE, "readwrite", (store) =>
                    store.put(buildOutreachPayload(outreach)),
                ),
        );
    }

    /**
     * Retrieve the stored outreach-funnel summary.
     * @returns {Promise<StoredAnalytics|null>} The outreach summary, or null if not stored
     */
    function getOutreach() {
        return runOp(
            () => memory.getOutreach(),
            (db) =>
                new Promise((resolve, reject) => {
                    const tx = db.transaction(ANALYTICS_STORE, "readonly");
                    const request = tx.objectStore(ANALYTICS_STORE).get("outreach");
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
                /** @type {Promise<void>} */ (
                    new Promise((resolve, reject) => {
                        const tx = db.transaction(
                            [FILE_STORE, FILE_BLOB_STORE, FILE_TEXT_STORE, ANALYTICS_STORE],
                            "readwrite",
                        );
                        tx.objectStore(FILE_STORE).clear();
                        tx.objectStore(FILE_BLOB_STORE).clear();
                        tx.objectStore(FILE_TEXT_STORE).clear();
                        tx.objectStore(ANALYTICS_STORE).clear();
                        const rejectFailure = () =>
                            reject(idbFailure(tx.error, "IndexedDB transaction failed"));
                        tx.oncomplete = () => resolve();
                        tx.onerror = rejectFailure;
                        tx.onabort = rejectFailure;
                    })
                ),
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
        saveOutreach,
        getOutreach,
        clearAll,
    };
})();
