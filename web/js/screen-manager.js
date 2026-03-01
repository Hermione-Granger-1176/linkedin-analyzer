/* Screen transitions and page lifecycle management */
/* exported ScreenManager */

const ScreenManager = (() => {
    'use strict';

    const TRANSITION_DURATION_MS = 350;

    const routes = new Map();
    let currentRouteName = null;
    let transitionToken = 0;

    /**
     * Register a screen route.
     * @param {string} routeName - Route name
     * @param {{screenId: string, controller: object}} config - Route config
     */
    function register(routeName, config) {
        if (!routeName || !config || !config.screenId) {
            return;
        }
        routes.set(routeName, {
            screenId: config.screenId,
            controller: config.controller || null,
            initialized: false
        });
    }

    /**
     * Activate a route screen and trigger its lifecycle hooks.
     * @param {string} routeName - Route name
     * @param {object} params - Route query params
     */
    function activate(routeName, params) {
        const nextRoute = routes.get(routeName);
        if (!nextRoute) {
            return;
        }

        const previousName = currentRouteName;
        const previousRoute = previousName ? routes.get(previousName) : null;
        const nextScreen = document.getElementById(nextRoute.screenId);
        const previousScreen = previousRoute
            ? document.getElementById(previousRoute.screenId)
            : null;

        updateActiveLinks(routeName);

        if (previousName !== routeName) {
            if (previousRoute && previousRoute.controller && typeof previousRoute.controller.onRouteLeave === 'function') {
                previousRoute.controller.onRouteLeave({ from: previousName, to: routeName });
            }
            switchScreens(previousScreen, nextScreen);
        }

        ensureControllerInitialized(nextRoute);
        if (nextRoute.controller && typeof nextRoute.controller.onRouteChange === 'function') {
            nextRoute.controller.onRouteChange(params || {}, { from: previousName, to: routeName });
        }

        currentRouteName = routeName;
        announceRoute(routeName);

        if (typeof LoadingOverlay !== 'undefined') {
            LoadingOverlay.syncActiveScreen();
        }
    }

    /**
     * Ensure a route controller init is called only once.
     * @param {{controller: object, initialized: boolean}} route - Route config
     */
    function ensureControllerInitialized(route) {
        if (route.initialized) {
            return;
        }
        if (route.controller && typeof route.controller.init === 'function') {
            route.controller.init();
        }
        route.initialized = true;
    }

    /**
     * Transition between route screens using existing CSS classes.
     * @param {HTMLElement|null} previousScreen - Previous screen
     * @param {HTMLElement|null} nextScreen - Next screen
     */
    function switchScreens(previousScreen, nextScreen) {
        const token = ++transitionToken;

        if (previousScreen && previousScreen !== nextScreen) {
            previousScreen.classList.remove('enter');
            previousScreen.classList.remove('active');
            previousScreen.classList.add('exit');
            setTimeout(() => {
                if (token !== transitionToken) {
                    return;
                }
                previousScreen.classList.remove('exit');
                previousScreen.classList.remove('is-loading');
            }, TRANSITION_DURATION_MS);
        }

        if (!nextScreen) {
            return;
        }

        nextScreen.classList.add('active');
        nextScreen.classList.remove('exit');

        requestAnimationFrame(() => {
            if (token !== transitionToken) {
                return;
            }
            nextScreen.classList.add('enter');
            setTimeout(() => {
                if (token !== transitionToken) {
                    return;
                }
                nextScreen.classList.remove('enter');
            }, TRANSITION_DURATION_MS);
        });
    }

    /**
     * Toggle active nav link classes globally.
     * @param {string} routeName - Active route name
     */
    function updateActiveLinks(routeName) {
        const links = document.querySelectorAll('.top-link[data-route]');
        links.forEach(link => {
            const isActive = link.getAttribute('data-route') === routeName;
            link.classList.toggle('is-active', isActive);
            if (isActive) {
                link.setAttribute('aria-current', 'page');
            } else {
                link.removeAttribute('aria-current');
            }
        });
    }

    /**
     * Update route announcer live region for accessibility.
     * @param {string} routeName - Active route name
     */
    function announceRoute(routeName) {
        const announcer = document.getElementById('routeAnnouncer');
        if (!announcer) {
            return;
        }
        const labels = {
            home: 'Home',
            clean: 'Clean',
            analytics: 'Analytics',
            connections: 'Connections',
            messages: 'Messages',
            insights: 'Insights'
        };
        announcer.textContent = `${labels[routeName] || routeName} screen`;
    }

    /**
     * Read current active route name.
     * @returns {string|null}
     */
    function getCurrentRouteName() {
        return currentRouteName;
    }

    return {
        register,
        activate,
        getCurrentRouteName
    };
})();
