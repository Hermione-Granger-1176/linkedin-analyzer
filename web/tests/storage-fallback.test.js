import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('Storage fallback when IndexedDB is unavailable', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.stubGlobal('indexedDB', undefined);
    });

    it('reports isAvailable as false', async () => {
        const { Storage } = await import('../src/storage.js');
        expect(Storage.isAvailable).toBe(false);
    });

    it('getFile resolves to null before saving', async () => {
        const { Storage } = await import('../src/storage.js');
        const file = await Storage.getFile('shares');
        expect(file).toBeNull();
    });

    it('getAllFiles resolves to empty array before saving', async () => {
        const { Storage } = await import('../src/storage.js');
        const files = await Storage.getAllFiles();
        expect(files).toEqual([]);
    });

    it('getAnalytics resolves to null before saving', async () => {
        const { Storage } = await import('../src/storage.js');
        const analytics = await Storage.getAnalytics();
        expect(analytics).toBeNull();
    });

    it('saveFile persists data in memory for the session', async () => {
        const { Storage } = await import('../src/storage.js');
        await Storage.saveFile('shares', { name: 'test.csv', text: 'a,b', rowCount: 2 });
        const file = await Storage.getFile('shares');
        expect(file).toMatchObject({ type: 'shares', name: 'test.csv', text: 'a,b', rowCount: 2 });
        const all = await Storage.getAllFiles();
        expect(all).toHaveLength(1);
    });

    it('saveAnalytics persists data in memory for the session', async () => {
        const { Storage } = await import('../src/storage.js');
        await Storage.saveAnalytics({ total: 5 });
        const analytics = await Storage.getAnalytics();
        expect(analytics).toEqual({ total: 5 });
    });

    it('clearAll removes in-memory data', async () => {
        const { Storage } = await import('../src/storage.js');
        await Storage.saveFile('shares', { name: 'test.csv', text: 'a,b' });
        await Storage.saveAnalytics({ total: 5 });
        await Storage.clearAll();
        expect(await Storage.getAllFiles()).toEqual([]);
        expect(await Storage.getAnalytics()).toBeNull();
    });
});
