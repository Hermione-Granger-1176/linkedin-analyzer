/* Theme handling */
/* exported Theme */

const Theme = (() => {
    'use strict';

    const STORAGE_KEY = 'linkedin-analyzer-theme';

    /**
     * Initialize theme toggle and system preference listeners.
     * @description Reads saved or system theme, applies it, and binds the toggle button.
     */
    function init() {
        const toggle = document.getElementById('themeToggle');
        if (!toggle) return;

        const savedTheme = localStorage.getItem(STORAGE_KEY);
        const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        const theme = savedTheme || (systemPrefersDark ? 'dark' : 'light');
        applyTheme(theme);

        toggle.addEventListener('click', () => {
            const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
            applyTheme(next);
            localStorage.setItem(STORAGE_KEY, next);
            notifyThemeChange();
        });

        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
            if (!localStorage.getItem(STORAGE_KEY)) {
                applyTheme(event.matches ? 'dark' : 'light');
                notifyThemeChange();
            }
        });
    }

    /**
     * Apply a theme to the document root element.
     * @param {string} theme - Theme name ('light' or 'dark')
     */
    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
    }

    /**
     * Dispatch a custom 'themechange' event on the document.
     * @description Used to notify chart and decoration modules to re-render with updated colors.
     */
    function notifyThemeChange() {
        document.dispatchEvent(new CustomEvent('themechange'));
    }

    return { init };
})();

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', Theme.init);
} else {
    Theme.init();
}
