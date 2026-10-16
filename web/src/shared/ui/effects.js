/* Effects tier: apply it, let the visitor override it, and step down on jank */

import {
    applyEffectsTier,
    downgradeForJank,
    getDeviceProfile,
    setEffectsOverride,
} from "../../platform/device/capabilities.js";
import { watchForJank } from "../../platform/device/jank.js";
import { setTelemetryEffectsTier } from "../../platform/observability/sentry.js";

const OVERRIDE_CYCLE = Object.freeze({ auto: "lite", lite: "full", full: "auto" });
const OVERRIDE_LABELS = Object.freeze({ auto: "Auto", lite: "Lite", full: "Full" });

export const Effects = (() => {
    "use strict";

    let initialized = false;

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
        render(profile);
    }

    /**
     * Reflect the current choice on the toggle.
     * @param {import("../../platform/device/capabilities.js").DeviceProfile} profile
     */
    function render(profile) {
        const toggle = document.getElementById("effectsToggle");
        if (!toggle) {
            return;
        }
        const label = OVERRIDE_LABELS[profile.override];
        toggle.dataset.override = profile.override;
        toggle.setAttribute("aria-label", `Visual effects: ${label}. Select to change.`);
        toggle.title = `Visual effects: ${label}`;
        const text = toggle.querySelector(".effects-toggle-label");
        if (text) {
            text.textContent = label;
        }
    }

    /** Pick the tier, wire the toggle, and start watching for jank. */
    function init() {
        if (initialized) {
            return;
        }
        initialized = true;

        apply(getDeviceProfile());

        const toggle = document.getElementById("effectsToggle");
        if (toggle) {
            toggle.addEventListener("click", () => {
                const current = getDeviceProfile().override;
                apply(setEffectsOverride(OVERRIDE_CYCLE[current]));
            });
        }

        watchForJank({
            Observer: typeof PerformanceObserver === "undefined" ? undefined : PerformanceObserver,
            isBusy,
            onJank: () => apply(downgradeForJank()),
        });
    }

    return { init };
})();
