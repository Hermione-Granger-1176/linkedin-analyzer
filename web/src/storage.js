/* IndexedDB storage helpers */

export const Storage = (() => {
    'use strict';

    const isAvailable = (() => {
        try {
            return typeof indexedDB !== 'undefined' && indexedDB !== null;
        } catch {
            /* v8 ignore next */
            return false;
        }
    })();

    if (!isAvailable) {
        const memFiles = new Map();
        let memAnalytics = null;
        return {
            isAvailable: false,
            saveFile: (type, data) => { memFiles.set(type, { type, name: data.name, text: data.text, rowCount: data.rowCount || 0, updatedAt: Date.now() }); return Promise.resolve(); },
            getFile: (type) => Promise.resolve(memFiles.get(type) || null),
            getAllFiles: () => Promise.resolve([...memFiles.values()]),
            saveAnalytics: (base) => { memAnalytics = base; return Promise.resolve(); },
            getAnalytics: () => Promise.resolve(memAnalytics),
            clearAll: () => { memFiles.clear(); memAnalytics = null; return Promise.resolve(); }
        };
    }

    const DB_NAME = 'linkedin-analyzer';
    const DB_VERSION = 1;
    const FILE_STORE = 'files';
    const ANALYTICS_STORE = 'analytics';

    /**
     * Open the IndexedDB database, creating object stores on first run.
     * @returns {Promise<IDBDatabase>} The opened database instance
     */
    function openDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = (event) => {
                const db = /** @type {IDBOpenDBRequest} */ (event.target).result;
                /* v8 ignore next 3 */
                if (!db.objectStoreNames.contains(FILE_STORE)) {
                    db.createObjectStore(FILE_STORE, { keyPath: 'type' });
                }
                /* v8 ignore next 3 */
                if (!db.objectStoreNames.contains(ANALYTICS_STORE)) {
                    db.createObjectStore(ANALYTICS_STORE, { keyPath: 'id' });
                }
            };
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
    }

    /**
     * Execute a callback within an IndexedDB transaction.
     * @param {string} storeName - Name of the object store
     * @param {IDBTransactionMode} mode - Transaction mode ('readonly' or 'readwrite')
     * @param {function(IDBObjectStore): *} callback - Function receiving the store
     * @returns {Promise<*>} Resolves with the callback's return value on transaction complete
     */
    async function withStore(storeName, mode, callback) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, mode);
            const store = tx.objectStore(storeName);
            const result = callback(store);
            tx.oncomplete = () => resolve(result);
            tx.onerror = () => reject(tx.error);
        });
    }

    /**
     * Save an uploaded CSV file record to IndexedDB.
     * @param {string} type - File type key
     * @param {{name: string, text: string, rowCount: number}} data - File data to persist
     * @returns {Promise<void>}
     */
    async function saveFile(type, data) {
        const payload = {
            type,
            name: data.name,
            text: data.text,
            rowCount: data.rowCount || 0,
            updatedAt: Date.now()
        };
        return withStore(FILE_STORE, 'readwrite', (store) => store.put(payload));
    }

    /**
     * Retrieve a single file record by type.
     * @param {string} type - File type key
     * @returns {Promise<object|null>} The stored file record, or null if not found
     */
    async function getFile(type) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(FILE_STORE, 'readonly');
            const store = tx.objectStore(FILE_STORE);
            const request = store.get(type);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Retrieve all stored file records.
     * @returns {Promise<object[]>} Array of all stored file records
     */
    async function getAllFiles() {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(FILE_STORE, 'readonly');
            const store = tx.objectStore(FILE_STORE);
            const request = store.getAll();
            /* v8 ignore next */
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Save pre-computed analytics aggregates to IndexedDB.
     * @param {object} base - Serialized analytics data from the worker
     * @returns {Promise<void>}
     */
    async function saveAnalytics(base) {
        const payload = {
            id: 'base',
            updatedAt: Date.now(),
            data: base
        };
        return withStore(ANALYTICS_STORE, 'readwrite', (store) => store.put(payload));
    }

    /**
     * Retrieve stored analytics aggregates.
     * @returns {Promise<object|null>} The analytics data, or null if not stored
     */
    async function getAnalytics() {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(ANALYTICS_STORE, 'readonly');
            const store = tx.objectStore(ANALYTICS_STORE);
            const request = store.get('base');
            request.onsuccess = () => resolve(request.result ? request.result.data : null);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Clear all stored files and analytics data.
     * @returns {Promise<void>}
     */
    async function clearAll() {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction([FILE_STORE, ANALYTICS_STORE], 'readwrite');
            tx.objectStore(FILE_STORE).clear();
            tx.objectStore(ANALYTICS_STORE).clear();
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    return {
        isAvailable: true,
        saveFile,
        getFile,
        getAllFiles,
        saveAnalytics,
        getAnalytics,
        clearAll
    };
})();
