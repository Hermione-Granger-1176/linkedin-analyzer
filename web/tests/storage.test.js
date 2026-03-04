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
});
