/* Hash-based SPA router */

/** @typedef {Record<string, string>} RouteParams - Query params of a route state */
/** @typedef {Record<string, unknown>} RouteParamsInput - Params to navigate with; stringified */

/**
 * Options a route is registered with.
 * @typedef {object} RouteOptions
 * @property {string[]} [sharedParams] - Params shared across routes that opt in
 * @property {Record<string, unknown>} [defaultParams] - Defaults for shared params
 */

/**
 * A route and its query params.
 * @typedef {object} RouteState
 * @property {string} name - Route name
 * @property {RouteParams} params - Query params
 */

/**
 * A route change delivered to subscribers.
 * @typedef {object} RouteChange
 * @property {RouteState} to - Route now active
 * @property {RouteState|null} from - Route left, or null on the first change
 */

/** @typedef {{replaceHistory?: boolean}} NavigateOptions - Navigation options */

export const AppRouter = (() => {
    "use strict";

    /** @type {Map<string, RouteOptions>} */
    const routes = new Map();
    /** @type {Set<(change: RouteChange) => void>} */
    const listeners = new Set();
    /** @type {Map<string, RouteParams>} */
    const rememberedParams = new Map();
    /** @type {Map<string, string>} */
    const sharedParamValues = new Map();

    let defaultRoute = "home";
    let started = false;
    /** @type {RouteState|null} */
    let currentState = null;

    /**
     * Check whether a route param should be omitted from the URL.
     * @param {unknown} value - Route param value
     * @returns {boolean} True when the value represents an absent param
     */
    function isEmptyParamValue(value) {
        return value === null || value === undefined || value === "";
    }

    /**
     * Register a route.
     * @param {string} name - Route name
     * @param {RouteOptions} [options] - Route options
     */
    function registerRoute(name, options) {
        const normalized = normalizeRouteName(name);
        /* v8 ignore next 3 */
        if (!normalized) {
            return;
        }
        routes.set(normalized, options || {});
    }

    /**
     * Start hash route handling.
     * @param {string} [fallbackRoute] - Default route for empty/unknown hash
     */
    function start(fallbackRoute) {
        if (fallbackRoute) {
            const normalized = normalizeRouteName(fallbackRoute);
            if (normalized) {
                defaultRoute = normalized;
            }
        }

        if (!started) {
            window.addEventListener("hashchange", handleHashChange);
            started = true;
        }

        if (!window.location.hash) {
            setHash(defaultRoute, {}, true);
            return;
        }
        handleHashChange();
    }

    /**
     * Navigate to a route and params.
     * @param {string} name - Route name
     * @param {RouteParamsInput|null|undefined} [params] - Query params; undefined reuses the
     * route's last known params
     * @param {NavigateOptions} [options] - Navigation options
     */
    function navigate(name, params, options) {
        const normalized = normalizeRouteName(name);
        if (!normalized || !routes.has(normalized)) {
            return;
        }

        // The membership check above makes this lookup safe in normal execution.
        // Keep the fallback for an inconsistent route map.
        /* v8 ignore next */
        const routeOptions = routes.get(normalized) || {};
        const nextParams = params === undefined
            ? (rememberedParams.get(normalized) || {})
            : (params || {});

        const merged = { ...nextParams };
        applySharedParams(merged, routeOptions, params);

        setHash(normalized, merged, Boolean(options && options.replaceHistory));
    }

    /**
     * Replace current route params entirely.
     * @param {RouteParamsInput} params - Next full params object
     * @param {NavigateOptions} [options] - Navigation options
     */
    function setParams(params, options) {
        const current = getCurrentRoute();
        /* v8 ignore next 3 */
        if (!current) {
            return;
        }
        navigate(current.name, params || {}, options);
    }

    /**
     * Merge partial params into current route params.
     * Null/empty values remove keys.
     * @param {RouteParamsInput} patch - Partial params
     * @param {NavigateOptions} [options] - Navigation options
     */
    function updateParams(patch, options) {
        const current = getCurrentRoute();
        /* v8 ignore next 3 */
        if (!current) {
            return;
        }

        /** @type {RouteParams} */
        const merged = { ...current.params };
        Object.entries(patch || {}).forEach(([key, value]) => {
            if (isEmptyParamValue(value)) {
                delete merged[key];
                return;
            }
            merged[key] = String(value);
        });

        navigate(current.name, merged, options);
    }

    /**
     * Subscribe to route changes.
     * @param {(change: RouteChange) => void} listener - Route listener
     * @returns {function(): void} Unsubscribe function
     */
    function subscribe(listener) {
        if (typeof listener !== "function") {
            return () => {};
        }
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    }

    /**
     * Get the current route state.
     * @returns {RouteState|null}
     */
    function getCurrentRoute() {
        return currentState
            ? { name: currentState.name, params: { ...currentState.params } }
            : null;
    }

    /**
     * Parse a hash into route + params.
     * @param {string} hash - Raw hash value
     * @returns {RouteState}
     */
    function parseHash(hash) {
        const raw = (hash || "").replace(/^#/, "").trim();
        if (!raw) {
            return { name: defaultRoute, params: {} };
        }

        const parts = raw.split("?");
        const name = normalizeRouteName(parts[0]) || defaultRoute;
        const query = parts.slice(1).join("?");
        const search = new URLSearchParams(query);
        /** @type {RouteParams} */
        const params = {};
        search.forEach((value, key) => {
            params[key] = value;
        });

        return { name, params };
    }

    /**
     * Build a hash string from route + params.
     * @param {string} name - Route name
     * @param {RouteParamsInput} params - Query params
     * @returns {string}
     */
    function buildHash(name, params) {
        const routeName = normalizeRouteName(name) || defaultRoute;
        const search = new URLSearchParams();
        Object.keys(params || {})
            .sort()
            .forEach(key => {
                const value = params[key];
                if (isEmptyParamValue(value)) {
                    return;
                }
                search.set(key, String(value));
            });
        const query = search.toString();
        return query ? `#${routeName}?${query}` : `#${routeName}`;
    }

    /** Handle browser hash changes. */
    function handleHashChange() {
        const next = parseHash(window.location.hash);
        /* v8 ignore next 4 */
        if (!routes.has(next.name)) {
            setHash(defaultRoute, {}, true);
            return;
        }

        if (isSameState(currentState, next)) {
            return;
        }

        const previous = currentState
            ? { name: currentState.name, params: { ...currentState.params } }
            : null;
        currentState = { name: next.name, params: { ...next.params } };
        rememberedParams.set(currentState.name, { ...currentState.params });
        rememberSharedParams(currentState);

        listeners.forEach(listener => {
            // Read at call time: a listener that navigates replaces the state.
            const active = /** @type {RouteState} */ (currentState);
            listener({
                to: { name: active.name, params: { ...active.params } },
                from: previous
            });
        });
    }

    /**
     * Set browser hash from a route state.
     * @param {string} name - Route name
     * @param {RouteParamsInput} params - Query params
     * @param {boolean} replaceHistory - Use replaceState instead of push
     */
    function setHash(name, params, replaceHistory) {
        // Callers pass params objects. Keep the fallback for malformed state.
        /* v8 ignore next */
        const nextHash = buildHash(name, params || {});
        if (nextHash === window.location.hash) {
            handleHashChange();
            return;
        }

        if (replaceHistory) {
            history.replaceState(
                null,
                "",
                `${window.location.pathname}${window.location.search}${nextHash}`
            );
            handleHashChange();
            return;
        }

        window.location.hash = nextHash;
    }

    /**
     * Normalize route names.
     * @param {string} value - Raw route name
     * @returns {string}
     */
    function normalizeRouteName(value) {
        const normalized = String(value || "")
            .trim()
            .toLowerCase()
            .replace(/^#/, "")
            .replace(/^\//, "");
        return normalized;
    }

    /**
     * Apply shared param values (e.g. time range) for routes that opt in.
     * Explicit params always win.
     * @param {RouteParamsInput} nextParams - Params object that will be navigated to
     * @param {RouteOptions} routeOptions - Registered route options
     * @param {RouteParamsInput|null|undefined} providedParams - Original navigate() params argument
     */
    function applySharedParams(nextParams, routeOptions, providedParams) {
        const keys = Array.isArray(routeOptions.sharedParams) ? routeOptions.sharedParams : [];
        if (!keys.length) {
            return;
        }

        keys.forEach(key => {
            const hasExplicitValue = providedParams !== undefined
                && providedParams !== null
                && Object.prototype.hasOwnProperty.call(providedParams, key);

            if (hasExplicitValue) {
                const explicitValue = providedParams[key];
                if (isEmptyParamValue(explicitValue)) {
                    delete nextParams[key];
                    return;
                }
                nextParams[key] = String(explicitValue);
                return;
            }

            if (sharedParamValues.has(key)) {
                nextParams[key] = sharedParamValues.get(key);
                return;
            }

            const defaultValue = getDefaultParamValue(routeOptions, key);
            if (defaultValue !== null) {
                nextParams[key] = defaultValue;
            }
        });
    }

    /**
     * Remember shared params from the current route for cross-tab reuse.
     * @param {RouteState} state - Current route state
     */
    function rememberSharedParams(state) {
        // state.name identifies a registered route. Keep the fallback for malformed state.
        /* v8 ignore next */
        const routeOptions = routes.get(state.name) || {};
        const keys = Array.isArray(routeOptions.sharedParams) ? routeOptions.sharedParams : [];
        if (!keys.length) {
            return;
        }

        keys.forEach(key => {
            const value = Object.prototype.hasOwnProperty.call(state.params, key)
                ? state.params[key]
                : getDefaultParamValue(routeOptions, key);
            if (isEmptyParamValue(value)) {
                sharedParamValues.delete(key);
                return;
            }
            sharedParamValues.set(key, String(value));
        });
    }

    /**
     * Get normalized default param value for a route key.
     * @param {RouteOptions} routeOptions - Registered route options
     * @param {string} key - Param key
     * @returns {string|null}
     */
    function getDefaultParamValue(routeOptions, key) {
        const defaults = routeOptions && routeOptions.defaultParams
            ? routeOptions.defaultParams
            : null;
        if (!defaults || !Object.prototype.hasOwnProperty.call(defaults, key)) {
            return null;
        }

        const value = defaults[key];
        if (isEmptyParamValue(value)) {
            return null;
        }
        return String(value);
    }

    /**
     * Compare route states.
     * @param {RouteState|null} left - Previous state
     * @param {RouteState|null} right - Next state
     * @returns {boolean}
     */
    function isSameState(left, right) {
        if (!left || !right) {
            return false;
        }
        if (left.name !== right.name) {
            return false;
        }

        // Route states store params as objects. Keep these fallbacks for malformed state.
        /* v8 ignore next 2 */
        const leftKeys = Object.keys(left.params || {});
        const rightKeys = Object.keys(right.params || {});
        if (leftKeys.length !== rightKeys.length) {
            return false;
        }
        return leftKeys.every(key => String(left.params[key]) === String(right.params[key]));
    }

    return {
        registerRoute,
        start,
        navigate,
        setParams,
        updateParams,
        subscribe,
        getCurrentRoute,
        parseHash,
        buildHash
    };
})();
