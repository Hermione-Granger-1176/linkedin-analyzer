/* Effects tier: apply what the device supports, and step down on jank */

import {
    applyEffectsTier,
    downgradeForJank,
    getDeviceProfile,
} from "../../platform/device/capabilities.js";
import { watchForJank } from "../../platform/device/jank.js";
import { setTelemetryEffectsTier } from "../../platform/observability/sentry.js";

export const Effects = (() => {
    "use strict";

    let initialized = false;

    // Where the removed Auto, Lite, and Full button stored its choice.
    const RETIRED_OVERRIDE_KEY = "linkedin-analyzer-effects";

    /** Drop the retired button's stored choice; nothing reads it any more. */
    function forgetRetiredOverride() {
        try {
            window.localStorage.removeItem(RETIRED_OVERRIDE_KEY);
        } catch {
            // Storage can be blocked; the stale value is harmless either way.
        }
    }

    /**
     * True while processing or a screen load is expected to block the page, so
     * its long frames are not blamed on decoration.
     * @returns {boolean}
     */
    function isBusy() {
        const progress = document.getElementById("progressOverlay");
        const loading = document.getElementById("contentLoadingOverlay");
        return (
            Boolean(progress && !progress.hidden) ||
            Boolean(loading && !loading.hidden) ||
            document.querySelector(".screen.is-loading") !== null
        );
    }

    /**
     * Apply a profile to the page and to telemetry.
     * @param {import("../../platform/device/capabilities.js").DeviceProfile} profile
     */
    function apply(profile) {
        applyEffectsTier(profile.tier);
        setTelemetryEffectsTier(profile.tier);
    }

    /** Pick the tier and start watching for jank. */
    function init() {
        if (initialized) {
            return;
        }
        initialized = true;
        forgetRetiredOverride();

        apply(getDeviceProfile());

        watchForJank({
            Observer: typeof PerformanceObserver === "undefined" ? undefined : PerformanceObserver,
            isBusy,
            onJank: () => apply(downgradeForJank()),
        });
    }

    return { init };
})();
