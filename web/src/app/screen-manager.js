/* Screen transitions and page lifecycle management */

import { captureError } from "../platform/observability/sentry.js";
import { LoadingOverlay } from "../shared/ui/loading-overlay.js";

export const ScreenManager = (() => {
    "use strict";

    /* Keep in sync with --screen-transition in styles/foundations/variables.css. */
    const TRANSITION_DURATION_MS = 50;

    const routes = new Map();
    let currentRouteName = null;
    let transitionToken = 0;

    /**
     * Register a screen route. A route either carries its controller or a
     * `load` function that imports it the first time the route opens, so the
     * first visit does not download every screen.
     * @param {string} routeName - Route name
     * @param {{screenId: string, controller?: object, load?: () => Promise<object>}} config - Route config
     */
    function register(routeName, config) {
        if (!routeName || !config || !config.screenId) {
            return;
        }
        routes.set(routeName, {
            screenId: config.screenId,
            controller: config.controller || null,
            load: typeof config.load === "function" ? config.load : null,
            loading: null,
            activation: 0,
            params: {},
            initialized: false
        });
    }

    /**
     * Import a route's controller once. A failed import is forgotten so a
     * retry or the next visit tries again, which is what recovers from a chunk
     * that went missing in a deploy.
     * @param {string} routeName - Route name
     * @returns {Promise<object|null>} The controller, or null when it cannot be loaded
     */
    function loadController(routeName) {
        const route = routes.get(routeName);
        if (!route) {
            return Promise.resolve(null);
        }
        if (route.controller || !route.load) {
            return Promise.resolve(route.controller);
        }
        if (!route.loading) {
            route.loading = route.load().then(
                (controller) => {
                    route.controller = controller || null;
                    return route.controller;
                },
                () => {
                    route.loading = null;
                    captureError(new Error("Screen code could not be loaded."), {
                        module: "screen-manager",
                        operation: "route-load",
                        route: routeName
                    });
                    return null;
                }
            );
        }
        return route.loading;
    }

    /**
     * Wait for a lazy route's controller behind the loading overlay, then run
     * its first lifecycle hooks if this is still the route's latest activation.
     * @param {string} routeName - Route name
     * @param {string|null} previousName - Route the user came from
     */
    async function activateWhenLoaded(routeName, previousName) {
        const source = `route:${routeName}`;
        const route = routes.get(routeName);
        const activation = ++route.activation;
        clearLoadError(route);
        LoadingOverlay.show(source, { title: "Loading", message: "Opening this screen." });
        let controller;
        try {
            controller = await loadController(routeName);
        } finally {
            // An earlier activation settling must not hide a later one's overlay.
            if (route.activation === activation) {
                LoadingOverlay.hide(source);
            }
        }
        if (currentRouteName !== routeName || route.activation !== activation) {
            return;
        }
        // A failed import clears `loading`; a loader that yields nothing keeps it.
        if (!controller && !route.loading) {
            showLoadError(routeName, route);
            return;
        }
        runControllerHooks(route, route.params, previousName, routeName);
    }

    /**
     * Tell the user a screen's code did not arrive, with a way to try again.
     * @param {string} routeName - Route name
     * @param {object} route - Registered route
     */
    function showLoadError(routeName, route) {
        const screen = document.getElementById(route.screenId);
        if (!screen) {
            return;
        }
        const notice = document.createElement("div");
        notice.className = "error-message";
        notice.setAttribute("role", "alert");
        notice.dataset.routeLoadError = "";
        const text = document.createElement("p");
        text.textContent = "This screen could not be opened. Check your connection and try again.";
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "ghost-btn";
        retry.textContent = "Try again";
        retry.addEventListener("click", () => {
            if (currentRouteName === routeName) {
                void activateWhenLoaded(routeName, null);
            }
        });
        notice.append(text, retry);
        screen.prepend(notice);
    }

    /**
     * Remove a load-failure notice left on a route's screen.
     * @param {object} route - Registered route
     */
    function clearLoadError(route) {
        const screen = document.getElementById(route.screenId);
        const notice = screen ? screen.querySelector("[data-route-load-error]") : null;
        if (notice) {
            notice.remove();
        }
    }

    /**
     * Initialize a route's controller once, then tell it about the route.
     * @param {object} route - Registered route
     * @param {object} params - Route query params
     * @param {string|null} from - Previous route name
     * @param {string} to - Active route name
     */
    function runControllerHooks(route, params, from, to) {
        ensureControllerInitialized(route);
        if (route.controller && typeof route.controller.onRouteChange === "function") {
            route.controller.onRouteChange(params, { from, to });
        }
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
            // A screen still loading must not leave its overlay on the next one.
            if (previousName) {
                LoadingOverlay.hide(`route:${previousName}`);
            }
            if (previousRoute && previousRoute.controller && typeof previousRoute.controller.onRouteLeave === "function") {
                previousRoute.controller.onRouteLeave({ from: previousName, to: routeName });
            }
            switchScreens(previousScreen, nextScreen);
        }

        currentRouteName = routeName;
        nextRoute.params = params || {};
        if (!nextRoute.controller && nextRoute.load) {
            // The latest params are read once the code arrives, so a route
            // change made while it loads is not lost.
            void activateWhenLoaded(routeName, previousName);
        } else {
            runControllerHooks(nextRoute, nextRoute.params, previousName, routeName);
        }
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
     * @param {{controller: object|null, load?: Function|null, initialized: boolean}} route - Route config
     */
    function ensureControllerInitialized(route) {
        if (route.initialized || (!route.controller && route.load)) {
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
        if (!nextScreen) {
            /* Target DOM element is missing; leave the current screen visible rather
               than sweeping it away and blanking the app. */
            return;
        }

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

    /** Human-readable screen names for the route announcer. */
    const ROUTE_LABELS = Object.freeze({
        home: "Home",
        clean: "Clean",
        analytics: "Analytics",
        connections: "Connections",
        messages: "Messages",
        insights: "Insights"
    });

    /**
     * Update route announcer live region for accessibility.
     * @param {string} routeName - Active route name
     */
    function announceRoute(routeName) {
        const announcer = document.getElementById("routeAnnouncer");
        if (!announcer) {
            return;
        }
        announcer.textContent = `${ROUTE_LABELS[routeName] || routeName} screen`;
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
        loadController,
        getCurrentRouteName
    };
})();
