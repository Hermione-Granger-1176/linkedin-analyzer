/* Screen transitions and page lifecycle management */

import { LoadingOverlay } from "./loading-overlay.js";

export const ScreenManager = (() => {
    "use strict";

    /* Keep in sync with the CSS --screen-transition value in css/variables.css. */
    const TRANSITION_DURATION_MS = 50;

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
            if (previousRoute && previousRoute.controller && typeof previousRoute.controller.onRouteLeave === "function") {
                previousRoute.controller.onRouteLeave({ from: previousName, to: routeName });
            }
            switchScreens(previousScreen, nextScreen);
        }

        ensureControllerInitialized(nextRoute);
        if (nextRoute.controller && typeof nextRoute.controller.onRouteChange === "function") {
            /* v8 ignore next */
            nextRoute.controller.onRouteChange(params || {}, { from: previousName, to: routeName });
        }

        currentRouteName = routeName;
        announceRoute(routeName);

        if (previousName !== routeName && nextScreen) {
            const targetRoute = routeName;
            setTimeout(() => {
                if (currentRouteName !== targetRoute) {
                    return;
                }
                const heading = /** @type {HTMLElement|null} */ (nextScreen.querySelector("h1, h2"));
                if (heading && !heading.hasAttribute("tabindex")) {
                    heading.setAttribute("tabindex", "-1");
                }
                (heading || nextScreen).focus({ preventScroll: false });
            }, TRANSITION_DURATION_MS);
        }

        LoadingOverlay.syncActiveScreen();
    }

    /**
     * Ensure a route controller init is called only once.
     * @param {{controller: object, initialized: boolean}} route - Route config
     */
    function ensureControllerInitialized(route) {
        if (route.initialized) {
            return;
        }
        if (route.controller && typeof route.controller.init === "function") {
            route.controller.init();
        }
        route.initialized = true;
    }

    /**
     * Run a callback for every registered screen element that currently exists.
     * @param {(screen: HTMLElement) => void} fn - Callback per screen element
     */
    function forEachScreenElement(fn) {
        routes.forEach(route => {
            const screen = document.getElementById(route.screenId);
            if (screen) {
                fn(screen);
            }
        });
    }

    /**
     * Transition between route screens. Only the incoming screen is ever painted:
     * every other screen is reset to its hidden base state synchronously, so a fast
     * switch can never leave the previous page overlaid on the new one.
     * @param {HTMLElement|null} previousScreen - Previous screen
     * @param {HTMLElement|null} nextScreen - Next screen
     */
    function switchScreens(previousScreen, nextScreen) {
        const token = ++transitionToken;
        const isInitialMount = !previousScreen;

        /* Strip transition classes from the outgoing screen and from any screen left
           mid-transition by a superseded switch. is-loading is left to LoadingOverlay,
           which only marks the active screen. */
        forEachScreenElement(screen => {
            if (screen !== nextScreen) {
                screen.classList.remove("active", "enter", "exit");
            }
        });

        if (!nextScreen) {
            return;
        }

        nextScreen.classList.add("active");
        nextScreen.classList.remove("exit");

        if (isInitialMount) {
            nextScreen.classList.remove("enter");
            return;
        }

        requestAnimationFrame(() => {
            if (token !== transitionToken) {
                return;
            }
            nextScreen.classList.add("enter");
            setTimeout(() => {
                if (token !== transitionToken) {
                    return;
                }
                nextScreen.classList.remove("enter");
            }, TRANSITION_DURATION_MS);
        });
    }

    /**
     * Toggle active nav link classes globally.
     * @param {string} routeName - Active route name
     */
    function updateActiveLinks(routeName) {
        const links = document.querySelectorAll(".top-link[data-route]");
        links.forEach(link => {
            const isActive = link.getAttribute("data-route") === routeName;
            link.classList.toggle("is-active", isActive);
            if (isActive) {
                link.setAttribute("aria-current", "page");
            } else {
                link.removeAttribute("aria-current");
            }
        });
    }

    /**
     * Update route announcer live region for accessibility.
     * @param {string} routeName - Active route name
     */
    function announceRoute(routeName) {
        const announcer = document.getElementById("routeAnnouncer");
        if (!announcer) {
            return;
        }
        const labels = {
            home: "Home",
            clean: "Clean",
            analytics: "Analytics",
            connections: "Connections",
            messages: "Messages",
            insights: "Insights"
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
