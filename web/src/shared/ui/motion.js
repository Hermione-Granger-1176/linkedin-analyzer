/* What the decoration layer needs from the visitor's motion preference, in one
   place, so every drawing that sits out asks the same question the same way,
   plus the shape every one of Pip's one-shot moments is played in. */

/**
 * Check whether the visitor asked for reduced motion.
 * @returns {boolean} True when the reduce preference is set.
 */
export function prefersReducedMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Play a one-shot pose: bring the drawing out, replay its move from the start,
 * and put it away again when the move is due to be over.
 *
 * The timer is the backstop rather than animationend: a pose whose screen is
 * hidden underneath it sits in a display:none subtree, where no animation ever
 * ends and the moment would stay on screen for the rest of the session.
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
    // Back to a clean slate first, so a second run replays the move instead of
    // holding the state it is already in.
    reset();
    void element.getBoundingClientRect();
    apply();

    return window.setTimeout(() => {
        reset();
        element.setAttribute("hidden", "");
        done();
    }, durationMs);
}
