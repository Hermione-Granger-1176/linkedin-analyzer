/* Theme handling */

const Theme = (() => {
    'use strict';

    const STORAGE_KEY = 'linkedin-analyzer-theme';

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

    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
    }

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
