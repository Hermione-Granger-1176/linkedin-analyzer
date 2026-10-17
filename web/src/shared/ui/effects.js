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
// Busy spans kept for matching late long-frame entries.
const MAX_BUSY_SPANS = 16;

export const Effects = (() => {
    "use strict";

    let initialized = false;
    /** @type {Array<{start: number, end: number}>} */
    const busySpans = [];

    /**
     * Record when the page is busy, from the overlays and the screens' loading
     * state, so a long frame reported after the work ended is not blamed on
     * decoration. A busy state that starts and ends within one task leaves a
     * zero-length span at the time the observer runs, inside that task.
     */
    function recordBusySpans() {
        if (typeof MutationObserver !== "function") {
            return;
        }
        const open = () => {
            const last = busySpans[busySpans.length - 1];
            return last && last.end === Infinity ? last : null;
        };
        const push = (span) => {
            busySpans.push(span);
            if (busySpans.length > MAX_BUSY_SPANS) {
                busySpans.shift();
            }
        };
        if (isBusy()) {
            push({ start: performance.now(), end: Infinity });
        }
        const observer = new MutationObserver(() => {
            const now = performance.now();
            const current = open();
            if (isBusy()) {
                if (!current) {
                    push({ start: now, end: Infinity });
                }
            } else if (current) {
                current.end = now;
            } else {
                push({ start: now, end: now });
            }
        });
        ["progressOverlay", "contentLoadingOverlay"].forEach((id) => {
            const overlay = document.getElementById(id);
            if (overlay) {
                observer.observe(overlay, { attributes: true, attributeFilter: ["hidden"] });
            }
        });
        document.querySelectorAll(".screen").forEach((screen) => {
            observer.observe(screen, { attributes: true, attributeFilter: ["class"] });
        });
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

        recordBusySpans();
        watchForJank({
            Observer: typeof PerformanceObserver === "undefined" ? undefined : PerformanceObserver,
            // An explicit choice ignores jank, so it must not use up the
            // one-shot watcher that Auto needs later.
            isBusy: () => isBusy() || getDeviceProfile().override !== "auto",
            onJank: () => apply(downgradeForJank()),
            busySpans: () => busySpans,
        });
    }

    return { init };
})();
