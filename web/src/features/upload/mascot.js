/**
 * Control the decorative upload catcher pose.
 *
 * Show the ready pose during a drag and the catch pose after a drop.
 * index.html contains the drawing, and CSS supplies its animation.
 * With reduced motion, show a still pose during the drag and skip the catch.
 */

import { playOneShot, prefersReducedMotion } from "../../shared/ui/motion.js";

const CATCHER_ID = "uploadCatcher";
const POSE_ATTRIBUTE = "data-pose";
const READY_POSE = "ready";
const CATCH_POSE = "catch";
/* The hug runs 0.9s and the fade ends at 1.05s. */
const CATCH_LIFETIME_MS = 1100;

let catchTimer = 0;

/**
 * Find the drop zone's Pip, on the screens that have one.
 * @returns {Element|null} The catcher svg, or null where it is absent.
 */
function getCatcher() {
    return document.getElementById(CATCHER_ID);
}

/**
 * Put Pip away, whether the drag left the zone or the catch has played out.
 * @returns {void}
 */
export function hideCatcher() {
    // Clears the module-level timer even if the catch screen is no longer shown.
    window.clearTimeout(catchTimer);
    const catcher = getCatcher();
    if (!catcher) {
        return;
    }
    // Hide via the attribute, not the property.
    catcher.setAttribute("hidden", "");
    catcher.setAttribute(POSE_ATTRIBUTE, READY_POSE);
}

/**
 * Bring Pip up at the edge of the zone, arms out, while a file is over it.
 * A call while Pip is already up leaves him in place and does not restart his
 * entrance.
 * @returns {void}
 */
export function showCatcher() {
    const catcher = getCatcher();
    if (!catcher) {
        return;
    }
    if (!catcher.hasAttribute("hidden") && catcher.getAttribute(POSE_ATTRIBUTE) === READY_POSE) {
        return;
    }
    window.clearTimeout(catchTimer);
    catcher.setAttribute(POSE_ATTRIBUTE, READY_POSE);
    catcher.removeAttribute("hidden");
}

/**
 * Play the catch: Pip hugs the page that landed, bounces once, and fades out.
 * @returns {void}
 */
export function playCatch() {
    const catcher = getCatcher();
    if (!catcher) {
        return;
    }
    if (prefersReducedMotion()) {
        hideCatcher();
        return;
    }

    // The timer resets the pose even when the drawing is hidden.
    catchTimer = playOneShot({
        element: catcher,
        durationMs: CATCH_LIFETIME_MS,
        previousTimer: catchTimer,
        apply: () => catcher.setAttribute(POSE_ATTRIBUTE, CATCH_POSE),
        reset: () => catcher.setAttribute(POSE_ATTRIBUTE, READY_POSE),
        done: () => {
            catchTimer = 0;
        },
    });
}
