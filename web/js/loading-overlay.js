/* Shared loading overlay for content screens */
/* exported LoadingOverlay */

const LoadingOverlay = (() => {
    'use strict';

    const DEFAULT_MESSAGES = Object.freeze({
        analytics: {
            title: 'Loading analytics',
            message: 'Crunching your activity view.'
        },
        messages: {
            title: 'Loading messages',
            message: 'Reading conversations and building relationship insights.'
        },
        insights: {
            title: 'Loading insights',
            message: 'Preparing your personalized takeaways.'
        }
    });

    const activeSources = new Map();
    let overlayElements = null;

    /**
     * Show overlay for a source key.
     * @param {string} source - Source identifier
     * @param {{title?: string, message?: string}} [options] - Text overrides
     */
    function show(source, options) {
        if (!source) {
            return;
        }
        const defaults = DEFAULT_MESSAGES[source] || {
            title: 'Loading',
            message: 'Preparing your data view.'
        };
        activeSources.set(source, {
            title: (options && options.title) || defaults.title,
            message: (options && options.message) || defaults.message
        });
        render();
    }

    /**
     * Hide overlay source key.
     * @param {string} source - Source identifier
     */
    function hide(source) {
        if (!source) {
            return;
        }
        activeSources.delete(source);
        render();
    }

    /** Hide all active overlay sources. */
    function clear() {
        activeSources.clear();
        render();
    }

    /** Reapply blur class to the currently active screen. */
    function syncActiveScreen() {
        applyLoadingClass(activeSources.size > 0);
    }

    /**
     * Render overlay visibility, text, and active blur class.
     */
    function render() {
        const elements = ensureElements();
        const isVisible = activeSources.size > 0;

        if (!elements) {
            return;
        }

        if (!isVisible) {
            elements.overlay.hidden = true;
            applyLoadingClass(false);
            return;
        }

        const latest = Array.from(activeSources.values()).pop();
        if (elements.title) {
            elements.title.textContent = latest.title;
        }
        if (elements.message) {
            elements.message.textContent = latest.message;
        }

        elements.overlay.hidden = false;
        applyLoadingClass(true);
    }

    /**
     * Toggle loading class on active screen.
     * @param {boolean} isLoading - Whether loading is active
     */
    function applyLoadingClass(isLoading) {
        const screens = document.querySelectorAll('.screen');
        screens.forEach(screen => {
            screen.classList.remove('is-loading');
        });

        if (!isLoading) {
            return;
        }

        const active = document.querySelector('.screen.active');
        if (active) {
            active.classList.add('is-loading');
        }
    }

    /**
     * Resolve overlay elements.
     * @returns {{overlay: HTMLElement, title: HTMLElement, message: HTMLElement}|null}
     */
    function ensureElements() {
        if (overlayElements) {
            return overlayElements;
        }

        const overlay = document.getElementById('contentLoadingOverlay');
        if (!overlay) {
            return null;
        }

        overlayElements = {
            overlay,
            title: document.getElementById('contentLoadingTitle'),
            message: document.getElementById('contentLoadingText')
        };
        return overlayElements;
    }

    return {
        show,
        hide,
        clear,
        syncActiveScreen
    };
})();
