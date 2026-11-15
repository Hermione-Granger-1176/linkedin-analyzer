/* Shared reduced-motion checks and timed mascot animations. */

/**
 * Check whether the visitor asked for reduced motion.
 * @returns {boolean} True when the reduce preference is set.
 */
export function prefersReducedMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Show a pose, restart its animation, and hide it after the specified duration.
 *
 * The timer hides the pose even when animationend never fires, such as inside
 * a display:none subtree.
 * @param {object} shot - The moment to play.
 * @param {Element} shot.element - The drawing the pose is held in.
 * @param {number} shot.durationMs - How long the pose stays on screen.
 * @param {number} [shot.previousTimer] - The timer from the last run, cleared before this one starts.
 * @param {() => void} shot.apply - Put the active state on, whichever form the pose reads it in.
 * @param {() => void} shot.reset - Take that state back off again.
 * @param {() => void} shot.done - Called once the pose is away, for the caller's own bookkeeping.
 * @returns {number} The timer that will put the pose away.
 */
export function playOneShot({ element, durationMs, previousTimer, apply, reset, done }) {
    window.clearTimeout(previousTimer);
    // Toggles the hidden attribute directly, since SVG elements have no hidden property.
    element.removeAttribute("hidden");
    // Reset, force a layout, then apply, so repeated calls restart the animation.
    reset();
    void element.getBoundingClientRect();
    apply();

    return window.setTimeout(() => {
        reset();
        element.setAttribute("hidden", "");
        done();
    }, durationMs);
}
