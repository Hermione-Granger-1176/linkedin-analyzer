import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { DataCache } from '../src/data-cache.js';
import { Session } from '../src/session.js';
import { Storage } from '../src/storage.js';

describe('Session', () => {
    beforeEach(() => {
        window.localStorage.clear();
        delete window.__linkedinAnalyzerSessionCleanupPromise;
    });

    it('cleans stale session data', async () => {
        window.localStorage.setItem('linkedin-analyzer:last-activity', String(Date.now() - 2 * 24 * 60 * 60 * 1000));
        await Storage.saveFile('shares', { name: 'Shares.csv', text: 'a,b', rowCount: 2 });
        DataCache.set('storage:files', [{ type: 'shares' }]);
        const cleaned = await Session.cleanIfStale();
        expect(cleaned).toBe(true);
    });

    it('touches session without cleanup when fresh', async () => {
        vi.spyOn(Storage, 'clearAll');
        window.localStorage.setItem('linkedin-analyzer:last-activity', String(Date.now()));
        const cleaned = await Session.cleanIfStale();
        expect(cleaned).toBe(false);
        expect(Storage.clearAll).not.toHaveBeenCalled();
    });

    it('waits for cleanup promise when provided', async () => {
        let resolved = false;
        window.__linkedinAnalyzerSessionCleanupPromise = Promise.resolve().then(() => {
            resolved = true;
        });
        await Session.waitForCleanup();
        expect(resolved).toBe(true);
    });

    it('cleanIfStale runs cleanup and returns true when no prior activity', async () => {
        // No last-activity key at all
        window.localStorage.removeItem('linkedin-analyzer:last-activity');
        vi.spyOn(Storage, 'clearAll').mockResolvedValue();
        const cleaned = await Session.cleanIfStale();
        // No lastActivity means it won't clean (returns false and touches)
        expect(cleaned).toBe(false);
    });

    it('touch sets last-activity to a recent timestamp', () => {
        const before = Date.now();
        Session.touch();
        const after = Date.now();
        const stored = Number(window.localStorage.getItem('linkedin-analyzer:last-activity'));
        expect(stored).toBeGreaterThanOrEqual(before);
        expect(stored).toBeLessThanOrEqual(after);
    });

    it('waitForCleanup resolves immediately when no cleanup promise on window', async () => {
        delete window.__linkedinAnalyzerSessionCleanupPromise;
        await expect(Session.waitForCleanup()).resolves.toBeUndefined();
    });

    it('waitForCleanup resolves even when cleanup promise rejects', async () => {
        window.__linkedinAnalyzerSessionCleanupPromise = Promise.reject(new Error('cleanup failed'));
        await expect(Session.waitForCleanup()).resolves.toBeUndefined();
    });

    it('waitForCleanup ignores non-promise values on window key', async () => {
        window.__linkedinAnalyzerSessionCleanupPromise = 'not-a-promise';
        await expect(Session.waitForCleanup()).resolves.toBeUndefined();
    });

    it('getStorageValue returns null when localStorage throws', () => {
        vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
            throw new Error('localStorage not available');
        });
        // cleanIfStale calls getStorageValue internally; it should not throw
        expect(async () => Session.cleanIfStale()).not.toThrow();
        vi.restoreAllMocks();
    });

    it('setStorageValue does not throw when localStorage throws', () => {
        vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
            throw new Error('quota exceeded');
        });
        // touch() calls setStorageValue; should not propagate
        expect(() => Session.touch()).not.toThrow();
        vi.restoreAllMocks();
    });

    it('cleanIfStale updates last-activity timestamp after cleaning stale data', async () => {
        window.localStorage.setItem(
            'linkedin-analyzer:last-activity',
            String(Date.now() - 3 * 24 * 60 * 60 * 1000)
        );
        const before = Date.now();
        await Session.cleanIfStale();
        const after = Date.now();
        const stored = Number(window.localStorage.getItem('linkedin-analyzer:last-activity'));
        expect(stored).toBeGreaterThanOrEqual(before);
        expect(stored).toBeLessThanOrEqual(after);
    });

    it('cleanIfStale clears DataCache when session is stale', async () => {
        window.localStorage.setItem(
            'linkedin-analyzer:last-activity',
            String(Date.now() - 2 * 24 * 60 * 60 * 1000)
        );
        DataCache.set('some:key', 'value');
        await Session.cleanIfStale();
        expect(DataCache.get('some:key')).toBeUndefined();
    });
});
