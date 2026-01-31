/* IndexedDB storage helpers */
/* exported Storage */

const Storage = (() => {
    'use strict';

    const DB_NAME = 'linkedin-analyzer';
    const DB_VERSION = 1;
    const FILE_STORE = 'files';
    const ANALYTICS_STORE = 'analytics';

    function openDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(FILE_STORE)) {
                    db.createObjectStore(FILE_STORE, { keyPath: 'type' });
                }
                if (!db.objectStoreNames.contains(ANALYTICS_STORE)) {
                    db.createObjectStore(ANALYTICS_STORE, { keyPath: 'id' });
                }
            };
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
    }

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

    async function getAllFiles() {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(FILE_STORE, 'readonly');
            const store = tx.objectStore(FILE_STORE);
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    async function saveAnalytics(base) {
        const payload = {
            id: 'base',
            updatedAt: Date.now(),
            data: base
        };
        return withStore(ANALYTICS_STORE, 'readwrite', (store) => store.put(payload));
    }

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
        saveFile,
        getFile,
        getAllFiles,
        saveAnalytics,
        getAnalytics,
        clearAll
    };
})();
