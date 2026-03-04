/* SPA bootstrap */

import { initRuntime } from './runtime.js';
import { initSentry } from './sentry.js';
import { initDecorations } from './decorations.js';
import { Theme } from './theme.js';
import { AppRouter } from './router.js';
import { DomEvents } from './dom-events.js';
import { ScreenManager } from './screen-manager.js';
import { Session } from './session.js';
import { Tutorial } from './tutorial.js';
import { UploadPage } from './upload.js';
import { CleanPage } from './clean.js';
import { AnalyticsPage } from './analytics-ui.js';
import { ConnectionsPage } from './connections-ui.js';
import { MessagesPage } from './messages-insights.js';
import { InsightsPage } from './insights-ui.js';

function init() {
    'use strict';

    const ROUTES = Object.freeze([
        {
            name: 'home',
            screenId: 'screen-home',
            controller: () => UploadPage
        },
        {
            name: 'clean',
            screenId: 'screen-clean',
            controller: () => CleanPage
        },
        {
            name: 'analytics',
            screenId: 'screen-analytics',
            controller: () => AnalyticsPage,
            routerOptions: {
                sharedParams: ['range'],
                defaultParams: { range: '12m' }
            }
        },
        {
            name: 'connections',
            screenId: 'screen-connections',
            controller: () => ConnectionsPage,
            routerOptions: {
                sharedParams: ['range'],
                defaultParams: { range: '12m' }
            }
        },
        {
            name: 'messages',
            screenId: 'screen-messages',
            controller: () => MessagesPage,
            routerOptions: {
                sharedParams: ['range'],
                defaultParams: { range: '12m' }
            }
        },
        {
            name: 'insights',
            screenId: 'screen-insights',
            controller: () => InsightsPage,
            routerOptions: {
                sharedParams: ['range'],
                defaultParams: { range: '12m' }
            }
        }
    ]);
    const SESSION_CLEANUP_PROMISE_KEY = '__linkedinAnalyzerSessionCleanupPromise';

    /** Initialize router and screen lifecycle wiring. */
    initSentry();
    initRuntime();
    initDecorations();
    Theme.init();
    Tutorial.init();
    registerRoutes();
    bindRouteLinks();

    runSessionCleanup();

    AppRouter.subscribe(({ to }) => {
        ScreenManager.activate(to.name, to.params);
        Tutorial.onRouteChange(to.name);
        Session.touch();
    });

    AppRouter.start('home');

    /** Run session cleanup without blocking initial render. */
    function runSessionCleanup() {
        window[SESSION_CLEANUP_PROMISE_KEY] = Promise.resolve()
            .then(() => Session.cleanIfStale())
            .catch(() => false);
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
            const link = DomEvents.closest(event, 'a[data-route]');
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

}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
