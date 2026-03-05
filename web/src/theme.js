/* Theme handling */

export const Theme = (() => {
    'use strict';

    const STORAGE_KEY = 'linkedin-analyzer-theme';

    /** Initialize theme toggle and system preference listeners. */
    function init() {
        const toggle = document.getElementById('themeToggle');
        if (!toggle) {return;}

        const savedTheme = getStoredTheme();
        const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        const theme = savedTheme || (systemPrefersDark ? 'dark' : 'light');
        applyTheme(theme);

        toggle.addEventListener('click', () => {
            const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
            applyTheme(next);
            setStoredTheme(next);
            notifyThemeChange();
        });

        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
            if (!getStoredTheme()) {
                applyTheme(event.matches ? 'dark' : 'light');
                notifyThemeChange();
            }
        });
    }

    /**
     * Read the current saved theme preference.
     * @returns {string|null}
     */
    function getStoredTheme() {
        try {
            return window.localStorage.getItem(STORAGE_KEY);
        } catch {
            /* v8 ignore next */
            return null;
        }
    }

    /**
     * Persist the theme preference across sessions.
     * @param {string} value - Theme value
     */
    function setStoredTheme(value) {
        try {
            window.localStorage.setItem(STORAGE_KEY, value);
        } catch {
            // Ignore storage write failures.
        }
    }

    /**
     * Apply a theme to the document root element.
     * @param {string} theme - Theme name ('light' or 'dark')
     */
    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
    }

    /** Dispatch a custom 'themechange' event on the document. */
    function notifyThemeChange() {
        document.dispatchEvent(new CustomEvent('themechange'));
    }

    return { init };
})();
