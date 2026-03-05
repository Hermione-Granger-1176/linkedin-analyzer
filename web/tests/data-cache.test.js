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

    it('get returns undefined for missing key', () => {
        expect(DataCache.get('definitely-not-set-xyz-123')).toBeUndefined();
    });

    it('has returns false for missing key and true after set', () => {
        expect(DataCache.has('new-key-abc')).toBe(false);
        DataCache.set('new-key-abc', 42);
        expect(DataCache.has('new-key-abc')).toBe(true);
    });

    it('delete removes a single key', () => {
        DataCache.set('to-delete', 'value');
        expect(DataCache.has('to-delete')).toBe(true);
        DataCache.delete('to-delete');
        expect(DataCache.has('to-delete')).toBe(false);
    });

    it('clear removes all cached values', () => {
        DataCache.set('x', 1);
        DataCache.set('y', 2);
        DataCache.clear();
        expect(DataCache.get('x')).toBeUndefined();
        expect(DataCache.get('y')).toBeUndefined();
    });

    it('invalidate with empty prefix does nothing', () => {
        DataCache.set('keep:this', 99);
        DataCache.invalidate('');
        expect(DataCache.get('keep:this')).toBe(99);
    });

    it('invalidate removes multiple matching keys', () => {
        DataCache.set('prefix:a', 1);
        DataCache.set('prefix:b', 2);
        DataCache.set('prefix:c', 3);
        DataCache.set('other', 4);
        DataCache.invalidate('prefix:');
        expect(DataCache.get('prefix:a')).toBeUndefined();
        expect(DataCache.get('prefix:b')).toBeUndefined();
        expect(DataCache.get('prefix:c')).toBeUndefined();
        expect(DataCache.get('other')).toBe(4);
    });

    it('unsubscribe removes listener so it is not called after removal', () => {
        const listener = vi.fn();
        const unsubscribe = DataCache.subscribe(listener);
        DataCache.notify({ type: 'storageCleared' });
        expect(listener).toHaveBeenCalledTimes(1);
        unsubscribe();
        DataCache.notify({ type: 'storageCleared' });
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('subscribe ignores non-function and returns no-op unsubscribe', () => {
        const unsubscribe = DataCache.subscribe('not-a-function');
        expect(typeof unsubscribe).toBe('function');
        expect(() => unsubscribe()).not.toThrow();
    });

    it('notify swallows listener errors to keep notifications resilient', () => {
        const throwing = vi.fn(() => { throw new Error('boom'); });
        const safe = vi.fn();
        DataCache.subscribe(throwing);
        DataCache.subscribe(safe);
        expect(() => DataCache.notify({ type: 'analyticsChanged' })).not.toThrow();
        expect(safe).toHaveBeenCalled();
    });

    it('notify with no payload calls listeners with empty object', () => {
        const listener = vi.fn();
        const unsubscribe = DataCache.subscribe(listener);
        DataCache.notify();
        expect(listener).toHaveBeenCalledWith({});
        unsubscribe();
    });

    it('set returns the stored value', () => {
        const val = { foo: 'bar' };
        const returned = DataCache.set('obj-key', val);
        expect(returned).toBe(val);
    });
});
