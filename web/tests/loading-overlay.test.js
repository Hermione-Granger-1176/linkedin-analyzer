import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setupDom } from './helpers/dom.js';

let LoadingOverlay;

describe('LoadingOverlay', () => {
    beforeEach(async () => {
        // Reset the module so overlayElements cache is cleared each test
        vi.resetModules();
        ({ LoadingOverlay } = await import('../src/loading-overlay.js'));

        setupDom(`
            <div id="contentLoadingOverlay" hidden></div>
            <div id="contentLoadingTitle"></div>
            <div id="contentLoadingText"></div>
        `);
    });

    it('shows and hides overlay sources', () => {
        LoadingOverlay.show('analytics');
        expect(LoadingOverlay.isActive()).toBe(true);
        LoadingOverlay.hide('analytics');
        expect(LoadingOverlay.isActive()).toBe(false);
    });

    it('isActive returns false when no sources are active', () => {
        LoadingOverlay.clear();
        expect(LoadingOverlay.isActive()).toBe(false);
    });

    it('clear removes all active sources', () => {
        LoadingOverlay.show('analytics');
        LoadingOverlay.show('connections');
        expect(LoadingOverlay.isActive()).toBe(true);
        LoadingOverlay.clear();
        expect(LoadingOverlay.isActive()).toBe(false);
    });

    it('tracks multiple sources independently', () => {
        LoadingOverlay.show('analytics');
        LoadingOverlay.show('connections');
        expect(LoadingOverlay.isActive()).toBe(true);
        LoadingOverlay.hide('analytics');
        expect(LoadingOverlay.isActive()).toBe(true);
        LoadingOverlay.hide('connections');
        expect(LoadingOverlay.isActive()).toBe(false);
    });

    it('hide with no active source does nothing', () => {
        expect(() => LoadingOverlay.hide('analytics')).not.toThrow();
        expect(LoadingOverlay.isActive()).toBe(false);
    });

    it('show with empty source does nothing', () => {
        LoadingOverlay.show('');
        expect(LoadingOverlay.isActive()).toBe(false);
    });

    it('hide with empty source does nothing', () => {
        LoadingOverlay.show('analytics');
        expect(LoadingOverlay.isActive()).toBe(true);
        LoadingOverlay.hide('');
        expect(LoadingOverlay.isActive()).toBe(true);
        LoadingOverlay.hide('analytics');
    });

    it('show with custom options overrides default text', () => {
        LoadingOverlay.show('analytics', { title: 'Custom Title', message: 'Custom message.' });
        expect(document.getElementById('contentLoadingTitle').textContent).toBe('Custom Title');
        expect(document.getElementById('contentLoadingText').textContent).toBe('Custom message.');
        LoadingOverlay.hide('analytics');
    });

    it('show with unknown source uses generic default text', () => {
        LoadingOverlay.show('unknown-source-xyz');
        expect(document.getElementById('contentLoadingTitle').textContent).toBe('Loading');
        LoadingOverlay.hide('unknown-source-xyz');
    });

    it('syncActiveScreen applies is-loading to active screen when sources present', () => {
        setupDom(`
            <div id="contentLoadingOverlay" hidden></div>
            <div id="contentLoadingTitle"></div>
            <div id="contentLoadingText"></div>
            <section class="screen active"></section>
        `);
        LoadingOverlay.show('analytics');
        LoadingOverlay.syncActiveScreen();
        expect(document.querySelector('.screen.active').classList.contains('is-loading')).toBe(true);
        LoadingOverlay.hide('analytics');
    });

    it('syncActiveScreen removes is-loading when no sources are active', () => {
        setupDom(`
            <div id="contentLoadingOverlay" hidden></div>
            <div id="contentLoadingTitle"></div>
            <div id="contentLoadingText"></div>
            <section class="screen active is-loading"></section>
        `);
        LoadingOverlay.syncActiveScreen();
        expect(document.querySelector('.screen.active').classList.contains('is-loading')).toBe(false);
    });

    it('render does nothing when overlay element is missing from DOM', () => {
        setupDom('');
        expect(() => LoadingOverlay.show('analytics')).not.toThrow();
        expect(() => LoadingOverlay.hide('analytics')).not.toThrow();
    });

    it('overlay is hidden when last source is removed', () => {
        LoadingOverlay.show('messages');
        expect(document.getElementById('contentLoadingOverlay').hidden).toBe(false);
        LoadingOverlay.hide('messages');
        expect(document.getElementById('contentLoadingOverlay').hidden).toBe(true);
    });
});
