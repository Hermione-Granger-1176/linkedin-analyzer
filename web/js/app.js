/* SPA bootstrap */
/* global Tutorial, Session */

(function() {
    'use strict';

    const ROUTES = Object.freeze([
        {
            name: 'home',
            screenId: 'screen-home',
            controller: () => (typeof UploadPage !== 'undefined' ? UploadPage : null)
        },
        {
            name: 'clean',
            screenId: 'screen-clean',
            controller: () => (typeof CleanPage !== 'undefined' ? CleanPage : null)
        },
        {
            name: 'analytics',
            screenId: 'screen-analytics',
            controller: () => (typeof AnalyticsPage !== 'undefined' ? AnalyticsPage : null),
            routerOptions: {
                sharedParams: ['range'],
                defaultParams: { range: '12m' }
            }
        },
        {
            name: 'connections',
            screenId: 'screen-connections',
            controller: () => (typeof ConnectionsPage !== 'undefined' ? ConnectionsPage : null),
            routerOptions: {
                sharedParams: ['range'],
                defaultParams: { range: '12m' }
            }
        },
        {
            name: 'messages',
            screenId: 'screen-messages',
            controller: () => (typeof MessagesPage !== 'undefined' ? MessagesPage : null),
            routerOptions: {
                sharedParams: ['range'],
                defaultParams: { range: '12m' }
            }
        },
        {
            name: 'insights',
            screenId: 'screen-insights',
            controller: () => (typeof InsightsPage !== 'undefined' ? InsightsPage : null),
            routerOptions: {
                sharedParams: ['range'],
                defaultParams: { range: '12m' }
            }
        }
    ]);
    const SESSION_CLEANUP_PROMISE_KEY = '__linkedinAnalyzerSessionCleanupPromise';

    /** Initialize router and screen lifecycle wiring. */
    async function init() {
        if (typeof AppRouter === 'undefined' || typeof ScreenManager === 'undefined') {
            return;
        }

        initTutorial();
        registerRoutes();
        bindRouteLinks();

        runSessionCleanup();

        AppRouter.subscribe(({ to }) => {
            ScreenManager.activate(to.name, to.params);
            notifyTutorialRouteChange(to.name);
            if (typeof Session !== 'undefined' && Session.touch) {
                Session.touch();
            }
        });

        AppRouter.start('home');
    }

    /** Run session cleanup without blocking initial render. */
    function runSessionCleanup() {
        if (typeof Session === 'undefined' || !Session.cleanIfStale) {
            window[SESSION_CLEANUP_PROMISE_KEY] = Promise.resolve(false);
            return;
        }

        window[SESSION_CLEANUP_PROMISE_KEY] = Promise.resolve()
            .then(() => Session.cleanIfStale())
            .catch(() => {
                // Ignore session cleanup failures to avoid blocking startup.
                return false;
            });
    }

    /** Initialize tutorial module when available. */
    function initTutorial() {
        if (typeof Tutorial === 'undefined' || typeof Tutorial.init !== 'function') {
            return;
        }

        Tutorial.init();
    }

    /**
     * Notify tutorial module of route changes when available.
     * @param {string} routeName - Active route name
     */
    function notifyTutorialRouteChange(routeName) {
        if (typeof Tutorial === 'undefined' || typeof Tutorial.onRouteChange !== 'function') {
            return;
        }

        Tutorial.onRouteChange(routeName);
    }

    /**
     * Check whether a click includes modifier keys.
     * @param {MouseEvent} event - Click event
     * @returns {boolean}
     */
    function isModifiedClick(event) {
        return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
    }

    /**
     * Check whether click came from primary mouse button.
     * @param {MouseEvent} event - Click event
     * @returns {boolean}
     */
    function isPrimaryButtonClick(event) {
        return event.button === 0;
    }

    /** Register route names in router + screen manager. */
    function registerRoutes() {
        ROUTES.forEach(route => {
            AppRouter.registerRoute(route.name, route.routerOptions || {});
            ScreenManager.register(route.name, {
                screenId: route.screenId,
                controller: route.controller()
            });
        });
    }

    /** Intercept route links for robust hash navigation. */
    function bindRouteLinks() {
        document.addEventListener('click', event => {
            const link = event.target.closest('a[data-route]');
            if (!link) {
                return;
            }

            if (isModifiedClick(event) || !isPrimaryButtonClick(event)) {
                return;
            }

            const routeName = link.getAttribute('data-route');
            if (!routeName) {
                return;
            }

            event.preventDefault();
            AppRouter.navigate(routeName, undefined, { replaceHistory: false });
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
