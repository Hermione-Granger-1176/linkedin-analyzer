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
 * A hidden screen has a display:none subtree, where animationend does not fire.
 * The timer removes the pose even when its animation cannot finish.
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
    // The element is an <svg>, and `hidden` is an HTMLElement property: setting
    // it there would never reach the attribute the stylesheet matches on.
    element.removeAttribute("hidden");
    // Reset and force layout so repeated calls restart the animation.
    reset();
    void element.getBoundingClientRect();
    apply();

    return window.setTimeout(() => {
        reset();
        element.setAttribute("hidden", "");
        done();
    }, durationMs);
}
