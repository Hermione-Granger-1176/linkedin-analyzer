/* Hash-based SPA router */

export const AppRouter = (() => {
    'use strict';

    const routes = new Map();
    const listeners = new Set();
    const rememberedParams = new Map();
    const sharedParamValues = new Map();

    let defaultRoute = 'home';
    let started = false;
    let currentState = null;

    /**
     * Register a route.
     * @param {string} name - Route name
     * @param {object} [options] - Route options
     */
    function registerRoute(name, options) {
        const normalized = normalizeRouteName(name);
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
            window.addEventListener('hashchange', handleHashChange);
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
     * @param {object|undefined} [params] - Query params; undefined reuses last known params for route
     * @param {{replaceHistory?: boolean}} [options] - Navigation options
     */
    function navigate(name, params, options) {
        const normalized = normalizeRouteName(name);
        if (!normalized || !routes.has(normalized)) {
            return;
        }

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
     * @param {object} params - Next full params object
     * @param {{replaceHistory?: boolean}} [options] - Navigation options
     */
    function setParams(params, options) {
        const current = getCurrentRoute();
        if (!current) {
            return;
        }
        navigate(current.name, params || {}, options);
    }

    /**
     * Merge partial params into current route params.
     * Null/empty values remove keys.
     * @param {object} patch - Partial params
     * @param {{replaceHistory?: boolean}} [options] - Navigation options
     */
    function updateParams(patch, options) {
        const current = getCurrentRoute();
        if (!current) {
            return;
        }

        const merged = { ...current.params };
        Object.keys(patch || {}).forEach(key => {
            const value = patch[key];
            if (value === null || value === undefined || value === '') {
                delete merged[key];
                return;
            }
            merged[key] = String(value);
        });

        navigate(current.name, merged, options);
    }

    /**
     * Subscribe to route changes.
     * @param {function({to: object, from: object|null}): void} listener - Route listener
     * @returns {function(): void} Unsubscribe function
     */
    function subscribe(listener) {
        if (typeof listener !== 'function') {
            return () => {};
        }
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    }

    /**
     * Get the current route state.
     * @returns {{name: string, params: object}|null}
     */
    function getCurrentRoute() {
        return currentState
            ? { name: currentState.name, params: { ...currentState.params } }
            : null;
    }

    /**
     * Parse a hash into route + params.
     * @param {string} hash - Raw hash value
     * @returns {{name: string, params: object}}
     */
    function parseHash(hash) {
        const raw = (hash || '').replace(/^#/, '').trim();
        if (!raw) {
            return { name: defaultRoute, params: {} };
        }

        const parts = raw.split('?');
        const name = normalizeRouteName(parts[0]) || defaultRoute;
        const query = parts.slice(1).join('?');
        const search = new URLSearchParams(query);
        const params = {};
        search.forEach((value, key) => {
            params[key] = value;
        });

        return { name, params };
    }

    /**
     * Build a hash string from route + params.
     * @param {string} name - Route name
     * @param {object} params - Query params
     * @returns {string}
     */
    function buildHash(name, params) {
        const routeName = normalizeRouteName(name) || defaultRoute;
        const search = new URLSearchParams();
        Object.keys(params || {})
            .sort()
            .forEach(key => {
                const value = params[key];
                if (value === null || value === undefined || value === '') {
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
            listener({
                to: { name: currentState.name, params: { ...currentState.params } },
                from: previous
            });
        });
    }

    /**
     * Set browser hash from a route state.
     * @param {string} name - Route name
     * @param {object} params - Query params
     * @param {boolean} replaceHistory - Use replaceState instead of push
     */
    function setHash(name, params, replaceHistory) {
        const nextHash = buildHash(name, params || {});
        if (nextHash === window.location.hash) {
            handleHashChange();
            return;
        }

        if (replaceHistory) {
            history.replaceState(
                null,
                '',
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
        const normalized = String(value || '')
            .trim()
            .toLowerCase()
            .replace(/^#/, '')
            .replace(/^\//, '');
        return normalized;
    }

    /**
     * Apply shared param values (e.g. time range) for routes that opt in.
     * Explicit params always win.
     * @param {object} nextParams - Params object that will be navigated to
     * @param {object} routeOptions - Registered route options
     * @param {object|undefined} providedParams - Original navigate() params argument
     */
    function applySharedParams(nextParams, routeOptions, providedParams) {
        const keys = Array.isArray(routeOptions.sharedParams) ? routeOptions.sharedParams : [];
        if (!keys.length) {
            return;
        }

        keys.forEach(key => {
            const hasExplicitValue = providedParams !== undefined
                && Object.prototype.hasOwnProperty.call(providedParams, key);

            if (hasExplicitValue) {
                const explicitValue = providedParams[key];
                if (explicitValue === null || explicitValue === undefined || explicitValue === '') {
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
     * @param {{name: string, params: object}} state - Current route state
     */
    function rememberSharedParams(state) {
        const routeOptions = routes.get(state.name) || {};
        const keys = Array.isArray(routeOptions.sharedParams) ? routeOptions.sharedParams : [];
        if (!keys.length) {
            return;
        }

        keys.forEach(key => {
            const value = Object.prototype.hasOwnProperty.call(state.params, key)
                ? state.params[key]
                : getDefaultParamValue(routeOptions, key);
            if (value === null || value === undefined || value === '') {
                sharedParamValues.delete(key);
                return;
            }
            sharedParamValues.set(key, String(value));
        });
    }

    /**
     * Get normalized default param value for a route key.
     * @param {object} routeOptions - Registered route options
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
        if (value === null || value === undefined || value === '') {
            return null;
        }
        return String(value);
    }

    /**
     * Compare route states.
     * @param {{name: string, params: object}|null} left - Previous state
     * @param {{name: string, params: object}|null} right - Next state
     * @returns {boolean}
     */
    function isSameState(left, right) {
        if (!left || !right) {
            return false;
        }
        if (left.name !== right.name) {
            return false;
        }

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
