import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';

import { Storage } from '../src/storage.js';

describe('Storage', () => {
    it('saves and retrieves files', async () => {
        await Storage.saveFile('shares', { name: 'Shares.csv', text: 'a,b', rowCount: 2 });
        const file = await Storage.getFile('shares');
        expect(file.name).toBe('Shares.csv');
        expect(file.text).toBe('a,b');
        const files = await Storage.getAllFiles();
        expect(files.length).toBe(1);
    });

    it('saves and retrieves analytics', async () => {
        await Storage.saveAnalytics({ months: { '2024-01': { total: 1 } } });
        const analytics = await Storage.getAnalytics();
        expect(analytics.months['2024-01'].total).toBe(1);
    });

    it('clears data', async () => {
        await Storage.saveFile('comments', { name: 'Comments.csv', text: 'a,b', rowCount: 1 });
        await Storage.clearAll();
        const files = await Storage.getAllFiles();
        expect(files.length).toBe(0);
    });

    it('getAnalytics returns null when no analytics stored', async () => {
        await Storage.clearAll();
        const analytics = await Storage.getAnalytics();
        expect(analytics).toBeNull();
    });

    it('getFile returns null for a type that has not been saved', async () => {
        await Storage.clearAll();
        const file = await Storage.getFile('connections');
        expect(file).toBeNull();
    });

    it('getAllFiles returns empty array after clearAll', async () => {
        await Storage.saveFile('shares', { name: 'Shares.csv', text: 'a,b', rowCount: 1 });
        await Storage.clearAll();
        const files = await Storage.getAllFiles();
        expect(files).toEqual([]);
    });

    it('getAllFiles returns multiple file records', async () => {
        await Storage.clearAll();
        await Storage.saveFile('shares', { name: 'Shares.csv', text: 'a,b', rowCount: 2 });
        await Storage.saveFile('connections', { name: 'Connections.csv', text: 'x,y', rowCount: 5 });
        const files = await Storage.getAllFiles();
        expect(files.length).toBe(2);
        const types = files.map(f => f.type).sort();
        expect(types).toEqual(['connections', 'shares']);
    });

    it('saveFile stores rowCount as 0 when not provided', async () => {
        await Storage.clearAll();
        await Storage.saveFile('shares', { name: 'Shares.csv', text: 'a,b' });
        const file = await Storage.getFile('shares');
        expect(file.rowCount).toBe(0);
    });

    it('saveFile overwrites existing record with same type', async () => {
        await Storage.clearAll();
        await Storage.saveFile('shares', { name: 'OldShares.csv', text: 'old', rowCount: 1 });
        await Storage.saveFile('shares', { name: 'NewShares.csv', text: 'new', rowCount: 99 });
        const file = await Storage.getFile('shares');
        expect(file.name).toBe('NewShares.csv');
        expect(file.rowCount).toBe(99);
    });

    it('saveAnalytics overwrites previous analytics record', async () => {
        await Storage.clearAll();
        await Storage.saveAnalytics({ months: { '2024-01': { total: 5 } } });
        await Storage.saveAnalytics({ months: { '2024-06': { total: 10 } } });
        const analytics = await Storage.getAnalytics();
        expect(analytics.months['2024-06'].total).toBe(10);
        expect(analytics.months['2024-01']).toBeUndefined();
    });

    it('saveFile stores updatedAt timestamp', async () => {
        await Storage.clearAll();
        const before = Date.now();
        await Storage.saveFile('shares', { name: 'Shares.csv', text: 'a,b', rowCount: 1 });
        const after = Date.now();
        const file = await Storage.getFile('shares');
        expect(file.updatedAt).toBeGreaterThanOrEqual(before);
        expect(file.updatedAt).toBeLessThanOrEqual(after);
    });
});
