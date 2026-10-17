/* Effects tier: apply what the device supports, and step down on jank */

import {
    applyEffectsTier,
    downgradeForJank,
    getDeviceProfile,
} from "../../platform/device/capabilities.js";
import { watchForJank } from "../../platform/device/jank.js";
import { setTelemetryEffectsTier } from "../../platform/observability/sentry.js";

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
        const push = (/** @type {{start: number, end: number}} */ span) => {
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
    }

    /** Pick the tier and start watching for jank. */
    function init() {
        if (initialized) {
            return;
        }
        initialized = true;

        apply(getDeviceProfile());

        recordBusySpans();
        watchForJank({
            Observer: typeof PerformanceObserver === "undefined" ? undefined : PerformanceObserver,
            isBusy,
            onJank: () => apply(downgradeForJank()),
            busySpans: () => busySpans,
        });
    }

    return { init };
})();
