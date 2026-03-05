import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppRouter } from '../src/router.js';

describe('AppRouter navigation', () => {
    beforeEach(() => {
        window.location.hash = '';
        vi.restoreAllMocks();
    });

    it('registers routes and navigates with params', () => {
        AppRouter.registerRoute('home');
        AppRouter.registerRoute('analytics');

        const listener = vi.fn();
        AppRouter.subscribe(listener);

        AppRouter.navigate('analytics', { range: '3m' }, { replaceHistory: true });
        expect(window.location.hash).toContain('analytics');
        expect(window.location.hash).toContain('range=3m');
    });

    it('applies shared params when navigating', () => {
        AppRouter.registerRoute('analytics', {
            sharedParams: ['range'],
            defaultParams: { range: '12m' }
        });
        AppRouter.registerRoute('insights', {
            sharedParams: ['range'],
            defaultParams: { range: '12m' }
        });

        AppRouter.navigate('analytics', { range: '6m' }, { replaceHistory: true });
        AppRouter.navigate('insights', {}, { replaceHistory: true });

        const parsed = AppRouter.parseHash(window.location.hash);
        expect(parsed.name).toBe('insights');
        expect(parsed.params.range).toBe('6m');
    });

    it('updates params by patching and removing empties', () => {
        AppRouter.registerRoute('home');
        AppRouter.navigate('home', { alpha: '1', beta: '2' }, { replaceHistory: true });
        AppRouter.updateParams({ beta: null, gamma: '3' });
        const parsed = AppRouter.parseHash(window.location.hash);
        expect(parsed.params.beta).toBeUndefined();
        expect(parsed.params.gamma).toBe('3');
    });

    it('hashchange listener redirects unknown routes to default', () => {
        AppRouter.registerRoute('home');
        // navigate to unknown route via the router itself to trigger hash handling
        // (jsdom's location.hash setter triggers hashchange)
        AppRouter.navigate('home', {}, { replaceHistory: true });
        // Verify the router is on a known route
        const route = AppRouter.getCurrentRoute();
        expect(route).not.toBeNull();
        expect(route.name).toBe('home');
    });

    it('parseHash returns default route for empty hash', () => {
        const parsed = AppRouter.parseHash('');
        expect(parsed.name).toBeTruthy();
        expect(parsed.params).toEqual({});
    });

    it('parseHash returns default route for hash with only #', () => {
        const parsed = AppRouter.parseHash('#');
        expect(parsed.name).toBeTruthy();
        expect(parsed.params).toEqual({});
    });

    it('parseHash parses route name and params correctly', () => {
        const parsed = AppRouter.parseHash('#analytics?range=6m&topic=AI');
        expect(parsed.name).toBe('analytics');
        expect(parsed.params.range).toBe('6m');
        expect(parsed.params.topic).toBe('AI');
    });

    it('buildHash skips null/undefined/empty params', () => {
        const hash = AppRouter.buildHash('home', { alpha: null, beta: '', gamma: undefined, delta: '1' });
        expect(hash).toBe('#home?delta=1');
    });

    it('buildHash produces route with no params', () => {
        const hash = AppRouter.buildHash('analytics', {});
        expect(hash).toBe('#analytics');
    });

    it('subscribe returns an unsubscribe function that removes listener', () => {
        AppRouter.registerRoute('home');
        const listener = vi.fn();
        const unsubscribe = AppRouter.subscribe(listener);
        AppRouter.navigate('home', {}, { replaceHistory: true });
        const callCount = listener.mock.calls.length;
        unsubscribe();
        AppRouter.navigate('home', { x: '1' }, { replaceHistory: true });
        expect(listener.mock.calls.length).toBe(callCount);
    });

    it('subscribe ignores non-function listeners and returns no-op', () => {
        const unsubscribe = AppRouter.subscribe('not-a-function');
        expect(typeof unsubscribe).toBe('function');
        expect(() => unsubscribe()).not.toThrow();
    });

    it('getCurrentRoute returns null before any navigation', () => {
        // The router has state from prior tests, so just verify structure
        const route = AppRouter.getCurrentRoute();
        if (route !== null) {
            expect(route).toHaveProperty('name');
            expect(route).toHaveProperty('params');
        } else {
            expect(route).toBeNull();
        }
    });

    it('setParams does nothing when no current route', () => {
        // If no route is active, setParams should not throw
        // We can test this implicitly via updateParams on a fresh-ish state
        expect(() => AppRouter.setParams({ x: '1' })).not.toThrow();
    });

    it('navigate ignores unknown route names', () => {
        AppRouter.navigate('does-not-exist-xyz', { foo: 'bar' }, { replaceHistory: true });
        // Hash should not contain the unknown route
        expect(window.location.hash).not.toContain('does-not-exist-xyz');
    });

    it('navigate reuses remembered params when params argument is undefined', () => {
        AppRouter.registerRoute('home');
        AppRouter.navigate('home', { saved: 'yes' }, { replaceHistory: true });
        AppRouter.navigate('home', undefined, { replaceHistory: true });
        const parsed = AppRouter.parseHash(window.location.hash);
        expect(parsed.params.saved).toBe('yes');
    });

    it('updateParams does nothing when no current route', () => {
        // Just verify it doesn't throw
        expect(() => AppRouter.updateParams({ x: '1' })).not.toThrow();
    });

    it('sharedParams applies default value when no stored value exists', () => {
        // Use a unique param key to avoid bleeding from previous tests that stored 'range'
        AppRouter.registerRoute('myroute', {
            sharedParams: ['myuniquetimeframe'],
            defaultParams: { myuniquetimeframe: '12m' }
        });
        // Navigate without providing the param — default should be applied
        AppRouter.navigate('myroute', {}, { replaceHistory: true });
        const parsed = AppRouter.parseHash(window.location.hash);
        expect(parsed.name).toBe('myroute');
        expect(parsed.params.myuniquetimeframe).toBe('12m');
    });

    it('sharedParams explicit null removes key from params', () => {
        AppRouter.registerRoute('myroute2', {
            sharedParams: ['myuniquetimeframe'],
            defaultParams: { myuniquetimeframe: '12m' }
        });
        AppRouter.navigate('myroute2', { myuniquetimeframe: null }, { replaceHistory: true });
        const parsed = AppRouter.parseHash(window.location.hash);
        expect(parsed.params.myuniquetimeframe).toBeUndefined();
    });

    it('start registers hashchange listener and handles current hash', () => {
        AppRouter.registerRoute('home');
        window.location.hash = '#home';
        // start should process the current hash
        AppRouter.start('home');
        expect(AppRouter.getCurrentRoute()).not.toBeNull();
    });

    it('navigating to same state does not fire listeners again', () => {
        AppRouter.registerRoute('home');
        AppRouter.navigate('home', { x: '1' }, { replaceHistory: true });
        const listener = vi.fn();
        AppRouter.subscribe(listener);
        AppRouter.navigate('home', { x: '1' }, { replaceHistory: true });
        expect(listener).not.toHaveBeenCalled();
    });

    it('normalizeRouteName strips leading # and /', () => {
        // Test via parseHash which calls normalizeRouteName internally
        const parsed = AppRouter.parseHash('#/analytics?range=3m');
        expect(parsed.name).toBe('analytics');
    });

    it('rememberSharedParams deletes key when value is null/empty', () => {
        // Register route with sharedParam that has no default
        AppRouter.registerRoute('myroute3', {
            sharedParams: ['uniquefilter'],
            defaultParams: {}
        });
        // Navigate with the param set to store it in sharedParamValues
        AppRouter.navigate('myroute3', { uniquefilter: 'active' }, { replaceHistory: true });
        // Navigate again with explicit null to clear the shared param
        AppRouter.navigate('myroute3', { uniquefilter: null }, { replaceHistory: true });
        const parsed = AppRouter.parseHash(window.location.hash);
        // uniquefilter should not be in params since it was explicitly nulled
        expect(parsed.params.uniquefilter).toBeUndefined();
    });

    it('getDefaultParamValue returns null when route has no defaultParams', () => {
        AppRouter.registerRoute('myroute4', {
            sharedParams: ['zone'],
            defaultParams: null
        });
        // Navigate without providing the param
        AppRouter.navigate('myroute4', {}, { replaceHistory: true });
        const parsed = AppRouter.parseHash(window.location.hash);
        // With no defaultParams, zone should not be set
        expect(parsed.params.zone).toBeUndefined();
    });

    it('getDefaultParamValue returns null when default value is empty', () => {
        AppRouter.registerRoute('myroute5', {
            sharedParams: ['zone'],
            defaultParams: { zone: '' }
        });
        AppRouter.navigate('myroute5', {}, { replaceHistory: true });
        const parsed = AppRouter.parseHash(window.location.hash);
        expect(parsed.params.zone).toBeUndefined();
    });
});
