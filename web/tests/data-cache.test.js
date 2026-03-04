import { describe, expect, it, vi } from 'vitest';

import { DataCache } from '../src/data-cache.js';

describe('DataCache', () => {
    it('stores and retrieves values', () => {
        DataCache.set('alpha', 1);
        expect(DataCache.get('alpha')).toBe(1);
    });

    it('invalidates keys by prefix', () => {
        DataCache.set('storage:one', 1);
        DataCache.set('storage:two', 2);
        DataCache.set('other:one', 3);
        DataCache.invalidate('storage:');
        expect(DataCache.get('storage:one')).toBeUndefined();
        expect(DataCache.get('storage:two')).toBeUndefined();
        expect(DataCache.get('other:one')).toBe(3);
    });

    it('notifies subscribers', () => {
        const listener = vi.fn();
        const unsubscribe = DataCache.subscribe(listener);
        DataCache.notify({ type: 'filesChanged' });
        expect(listener).toHaveBeenCalledOnce();
        unsubscribe();
    });
});
