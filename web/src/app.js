/* SPA bootstrap */

import { AppRouter } from "./app/router.js";
import { initRuntime } from "./app/runtime.js";
import { ScreenManager } from "./app/screen-manager.js";
import { PdfExport } from "./features/export/pdf.js";
import { Tutorial } from "./features/tutorial/tutorial.js";
import { UploadPage } from "./features/upload/upload.js";
import { RunTracker, memoryBucket } from "./platform/observability/run-tracker.js";
import {
    captureError,
    captureProcessingUnfinished,
    disableTelemetry,
    initSentry,
    setTelemetryConsent,
    telemetryConsentGranted,
} from "./platform/observability/sentry.js";
import { initTelemetry } from "./platform/observability/telemetry.js";
import { Session } from "./platform/persistence/session.js";
import { SESSION_CLEANUP_PROMISE_KEY } from "./shared/constants.js";
import { DomEvents } from "./shared/dom-events.js";
import { initAlive } from "./shared/ui/alive.js";
import { initDecorations } from "./shared/ui/decorations.js";
import { Effects } from "./shared/ui/effects.js";
import { initMascot } from "./shared/ui/mascot.js";
import { NavMenu } from "./shared/ui/nav-menu.js";
import { Theme } from "./shared/ui/theme.js";

function init() {
    "use strict";

    // Upload is the screen most visits land on, so it ships in the main bundle.
    // Every other screen's code is imported the first time its route opens.
    const ROUTES = Object.freeze([
        {
            name: "home",
            screenId: "screen-home",
            controller: UploadPage,
        },
        {
            name: "clean",
            screenId: "screen-clean",
            load: () => import("./features/cleaning/screen.js").then((module) => module.CleanPage),
        },
        {
            name: "analytics",
            screenId: "screen-analytics",
            load: () =>
                import("./features/analytics/screen.js").then((module) => module.AnalyticsPage),
            routerOptions: {
                sharedParams: ["range"],
                defaultParams: { range: "12m" },
            },
        },
        {
            name: "connections",
            screenId: "screen-connections",
            load: () =>
                import("./features/connections/screen.js").then((module) => module.ConnectionsPage),
            routerOptions: {
                sharedParams: ["range"],
                defaultParams: { range: "12m" },
            },
        },
        {
            name: "messages",
            screenId: "screen-messages",
            load: () =>
                import("./features/messages/screen.js").then((module) => module.MessagesPage),
            routerOptions: {
                sharedParams: ["range"],
                defaultParams: { range: "12m" },
            },
        },
        {
            name: "insights",
            screenId: "screen-insights",
            load: () =>
                import("./features/insights/screen.js").then((module) => module.InsightsPage),
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
    // Before the decoration layer starts, so it reads the tier it will run in.
    Effects.init();
    initMascot();
    initAlive();
    Theme.init();
    // After Theme.init() on purpose: the doodles read their palette off the
    // theme, and painting before it has settled means painting twice.
    initDecorations();
    PdfExport.init();
    NavMenu.init();
    Tutorial.init();
    registerRoutes();
    bindRouteLinks();
    initConsentControls(hasTelemetryConsent);
    checkUnfinishedRuns();

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
     * Tell the user when an earlier processing run did not finish, and report
     * it with consent. The wording never claims a crash or a too-large file.
     */
    function checkUnfinishedRuns() {
        const banner = document.getElementById("unfinishedRunBanner");
        const dismissButton = document.getElementById("unfinishedRunDismissBtn");
        if (dismissButton && banner) {
            dismissButton.addEventListener("click", () => {
                banner.hidden = true;
            });
        }
        const deviceMemory = /** @type {Navigator & { deviceMemory?: number }} */ (navigator)
            .deviceMemory;
        RunTracker.checkPrevious((run) => {
            if (banner) {
                banner.hidden = false;
            }
            captureProcessingUnfinished({ ...run, memoryBucket: memoryBucket(deviceMemory) });
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
                controller: route.controller,
                load: route.load,
            });
        });
    }

    /** Intercept route links for hash navigation. */
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
     * The banner appears once. The footer shows the saved consent state and lets
     * the user enable or revoke diagnostics at any time.
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
