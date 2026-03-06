/* SPA bootstrap */

import { AnalyticsPage } from "./analytics-ui.js";
import { CleanPage } from "./clean.js";
import { ConnectionsPage } from "./connections-ui.js";
import { initDecorations } from "./decorations.js";
import { DomEvents } from "./dom-events.js";
import { InsightsPage } from "./insights-ui.js";
import { MessagesPage } from "./messages-insights.js";
import { AppRouter } from "./router.js";
import { initRuntime } from "./runtime.js";
import { ScreenManager } from "./screen-manager.js";
import {
    captureError,
    initSentry,
    setTelemetryConsent,
    telemetryConsentGranted,
} from "./sentry.js";
import { Session } from "./session.js";
import { initTelemetry } from "./telemetry.js";
import { Theme } from "./theme.js";
import { Tutorial } from "./tutorial.js";
import { UploadPage } from "./upload.js";

function init() {
    "use strict";

    const ROUTES = Object.freeze([
        {
            name: "home",
            screenId: "screen-home",
            controller: () => UploadPage,
        },
        {
            name: "clean",
            screenId: "screen-clean",
            controller: () => CleanPage,
        },
        {
            name: "analytics",
            screenId: "screen-analytics",
            controller: () => AnalyticsPage,
            routerOptions: {
                sharedParams: ["range"],
                defaultParams: { range: "12m" },
            },
        },
        {
            name: "connections",
            screenId: "screen-connections",
            controller: () => ConnectionsPage,
            routerOptions: {
                sharedParams: ["range"],
                defaultParams: { range: "12m" },
            },
        },
        {
            name: "messages",
            screenId: "screen-messages",
            controller: () => MessagesPage,
            routerOptions: {
                sharedParams: ["range"],
                defaultParams: { range: "12m" },
            },
        },
        {
            name: "insights",
            screenId: "screen-insights",
            controller: () => InsightsPage,
            routerOptions: {
                sharedParams: ["range"],
                defaultParams: { range: "12m" },
            },
        },
    ]);
    const SESSION_CLEANUP_PROMISE_KEY = "__linkedinAnalyzerSessionCleanupPromise";
    const hasTelemetryConsent = telemetryConsentGranted();

    /* Initialize runtime modules and route wiring. */
    initSentry();
    if (hasTelemetryConsent) {
        initTelemetry();
    }
    initRuntime();
    initDecorations();
    Theme.init();
    Tutorial.init();
    registerRoutes();
    bindRouteLinks();
    initTelemetryBanner(hasTelemetryConsent);

    runSessionCleanup();

    AppRouter.subscribe(({ to }) => {
        ScreenManager.activate(to.name, to.params);
        Tutorial.onRouteChange(to.name);
        Session.touch();
    });

    AppRouter.start("home");

    /** Run session cleanup without blocking initial render. */
    function runSessionCleanup() {
        window[SESSION_CLEANUP_PROMISE_KEY] = Promise.resolve()
            .then(() => Session.cleanIfStale())
            /* v8 ignore next */
            .catch((error) => {
                captureError(error, {
                    module: "app",
                    operation: "session-cleanup",
                });
                return false;
            });
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
        ROUTES.forEach((route) => {
            AppRouter.registerRoute(route.name, route.routerOptions || {});
            ScreenManager.register(route.name, {
                screenId: route.screenId,
                controller: route.controller(),
            });
        });
    }

    /** Intercept route links for robust hash navigation. */
    function bindRouteLinks() {
        document.addEventListener("click", (event) => {
            const link = DomEvents.closest(event, "a[data-route]");
            if (!link) {
                return;
            }

            if (isModifiedClick(event) || !isPrimaryButtonClick(event)) {
                return;
            }

            const routeName = link.getAttribute("data-route");
            if (!routeName) {
                return;
            }

            event.preventDefault();
            AppRouter.navigate(routeName, undefined, { replaceHistory: false });
        });
    }

    function initTelemetryBanner(consentGranted) {
        const banner = document.getElementById("telemetryBanner");
        const enableButton = document.getElementById("telemetryEnableBtn");
        const dismissButton = document.getElementById("telemetryDismissBtn");

        if (!banner || !enableButton || !dismissButton) {
            return;
        }

        const shouldOfferTelemetry = Boolean(import.meta.env.VITE_SENTRY_DSN);
        if (!shouldOfferTelemetry || consentGranted) {
            banner.hidden = true;
            return;
        }

        banner.hidden = false;
        enableButton.addEventListener("click", () => {
            setTelemetryConsent(true);
            banner.hidden = true;
            initSentry();
            initTelemetry();
        });
        dismissButton.addEventListener("click", () => {
            banner.hidden = true;
        });
    }
}

/* v8 ignore next 5 */
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}
