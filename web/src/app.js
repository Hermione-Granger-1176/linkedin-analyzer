/* SPA bootstrap */

import { AnalyticsPage } from "./analytics-ui.js";
import { CleanPage } from "./clean.js";
import { ConnectionsPage } from "./connections-ui.js";
import { SESSION_CLEANUP_PROMISE_KEY } from "./constants.js";
import { initDecorations } from "./decorations.js";
import { DomEvents } from "./dom-events.js";
import { InsightsPage } from "./insights-ui.js";
import { MessagesPage } from "./messages-insights.js";
import { NavMenu } from "./nav-menu.js";
import { AppRouter } from "./router.js";
import { initRuntime } from "./runtime.js";
import { ScreenManager } from "./screen-manager.js";
import {
    captureError,
    disableTelemetry,
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
    const hasTelemetryConsent = telemetryConsentGranted();

    /* Initialize runtime modules and route wiring. */
    initSentry();
    if (hasTelemetryConsent) {
        initTelemetry();
    }
    initRuntime();
    initDecorations();
    Theme.init();
    NavMenu.init();
    Tutorial.init();
    registerRoutes();
    bindRouteLinks();
    initConsentControls(hasTelemetryConsent);

    runSessionCleanup();

    AppRouter.subscribe(({ to }) => {
        ScreenManager.activate(to.name, to.params);
        Tutorial.onRouteChange(to.name);
        Session.touch();
    });

    AppRouter.start("home");

    /** Run session cleanup without blocking initial render. */
    function runSessionCleanup() {
        window[SESSION_CLEANUP_PROMISE_KEY] = Session.cleanIfStale()
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

    /**
     * Wire the opt-in diagnostics banner and the persistent footer toggle.
     * The banner is a one-time proactive prompt; the footer reflects the current
     * consent state and lets the user enable or revoke diagnostics at any time.
     * @param {boolean} consentGranted - Whether telemetry consent is already stored
     */
    function initConsentControls(consentGranted) {
        const banner = document.getElementById("telemetryBanner");
        const enableButton = document.getElementById("telemetryEnableBtn");
        const dismissButton = document.getElementById("telemetryDismissBtn");
        const footer = document.getElementById("appFooter");
        const toggleButton = document.getElementById("telemetryToggleBtn");
        const statusLabel = document.getElementById("telemetryStatusLabel");

        // Diagnostics are only meaningful when a Sentry DSN is built in. The test
        // hook lets e2e exercise the consent flow without baking a DSN into the build.
        const globalWindow =
            /** @type {Window & { __LINKEDIN_ANALYZER_FORCE_TELEMETRY_OFFER__?: boolean }} */ (
                window
            );
        const offerTelemetry =
            Boolean(import.meta.env.VITE_SENTRY_DSN) ||
            /* v8 ignore next */
            Boolean(globalWindow.__LINKEDIN_ANALYZER_FORCE_TELEMETRY_OFFER__);

        let granted = consentGranted;
        let bannerDismissed = false;

        const enable = () => {
            setTelemetryConsent(true);
            granted = true;
            // Any explicit choice settles the prompt: the banner must not reappear
            // later in the session (e.g. after a subsequent revoke).
            bannerDismissed = true;
            initSentry();
            initTelemetry();
            render();
        };

        const revoke = () => {
            setTelemetryConsent(false);
            disableTelemetry();
            granted = false;
            bannerDismissed = true;
            render();
        };

        /** Reflect the current consent state in the banner and footer. */
        function render() {
            if (banner) {
                banner.hidden = !(offerTelemetry && !granted && !bannerDismissed);
            }
            if (footer && toggleButton && statusLabel) {
                const showFooter = offerTelemetry || granted;
                footer.hidden = !showFooter;
                // Stored consent only means diagnostics are actually running when the
                // build can send them (a DSN is present). If consent was carried
                // forward into a build without one, say so rather than claim "on".
                let statusText;
                if (granted && !offerTelemetry) {
                    statusText = "Diagnostics are on but unavailable in this build.";
                } else if (granted) {
                    statusText = "Diagnostics are on.";
                } else {
                    statusText = "Diagnostics are off.";
                }
                statusLabel.textContent = statusText;
                toggleButton.textContent = granted
                    ? "Turn off diagnostics"
                    : "Turn on diagnostics";
                toggleButton.setAttribute("aria-pressed", granted ? "true" : "false");
            }
        }

        if (enableButton) {
            enableButton.addEventListener("click", enable);
        }
        if (dismissButton) {
            dismissButton.addEventListener("click", () => {
                bannerDismissed = true;
                render();
            });
        }
        if (toggleButton) {
            toggleButton.addEventListener("click", () => (granted ? revoke() : enable()));
        }

        render();
    }
}

/* v8 ignore next 5 */
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}
