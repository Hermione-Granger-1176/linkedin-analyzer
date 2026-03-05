import { afterEach, describe, expect, it, vi } from 'vitest';

import { Theme } from '../src/theme.js';

import { mockMatchMedia, resetDom, setupDom } from './helpers/dom.js';

describe('Theme', () => {
    afterEach(() => {
        resetDom();
        window.localStorage.clear();
    });

    it('applies theme to document root', () => {
        setupDom('<button id="themeToggle"></button>');
        mockMatchMedia();
        document.documentElement.setAttribute('data-theme', 'light');
        Theme.init();
        expect(document.documentElement.getAttribute('data-theme')).toBeTruthy();
    });

    it('toggles theme on button click and persists', () => {
        setupDom('<button id="themeToggle"></button>');
        mockMatchMedia();
        document.documentElement.setAttribute('data-theme', 'light');
        Theme.init();
        document.getElementById('themeToggle').click();
        expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
        expect(window.localStorage.getItem('linkedin-analyzer-theme')).toBe('dark');
    });

    it('reacts to system preference changes when no stored theme', () => {
        setupDom('<button id="themeToggle"></button>');
        const mql = mockMatchMedia(false);
        Theme.init();
        mql.dispatch(true);
        expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    it('ignores system preference change when a stored theme exists (line 41)', () => {
        setupDom('<button id="themeToggle"></button>');
        const mql = mockMatchMedia(false);
        // Pre-set a stored preference so getStoredTheme() returns 'light'
        window.localStorage.setItem('linkedin-analyzer-theme', 'light');
        Theme.init();
        // Simulate system going dark — must be ignored because user has a stored pref
        mql.dispatch(true);
        expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });

    it('getStoredTheme catch branch returns null when localStorage.getItem throws (line 41)', () => {
        setupDom('<button id="themeToggle"></button>');
        const mql = mockMatchMedia(false);
        // Force localStorage.getItem to throw — this hits the catch branch at line 40-42
        vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
            throw new Error('SecurityError');
        });

        // Theme.init() calls getStoredTheme() which throws → returns null → uses system pref
        Theme.init();
        // System prefers dark (matches=false per mockMatchMedia(false)) → should be 'light'
        expect(document.documentElement.getAttribute('data-theme')).toBe('light');

        // Triggering system preference change also calls getStoredTheme() → null → applies
        mql.dispatch(true);
        expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

        vi.restoreAllMocks();
    });

    it('does not throw when localStorage.setItem throws during theme toggle', () => {
        setupDom('<button id="themeToggle"></button>');
        mockMatchMedia();
        document.documentElement.setAttribute('data-theme', 'light');
        Theme.init();

        vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
            throw new Error('QuotaExceededError');
        });

        expect(() => document.getElementById('themeToggle').click()).not.toThrow();
        // Theme should still toggle in the DOM even if storage write fails
        expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });
});
