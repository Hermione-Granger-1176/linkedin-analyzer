import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';

import { DataCache } from '../src/data-cache.js';
import { Session } from '../src/session.js';
import { Storage } from '../src/storage.js';

describe('Session', () => {
    it('cleans stale session data', async () => {
        window.localStorage.setItem('linkedin-analyzer:last-activity', String(Date.now() - 2 * 24 * 60 * 60 * 1000));
        await Storage.saveFile('shares', { name: 'Shares.csv', text: 'a,b', rowCount: 2 });
        DataCache.set('storage:files', [{ type: 'shares' }]);
        const cleaned = await Session.cleanIfStale();
        expect(cleaned).toBe(true);
    });
});
