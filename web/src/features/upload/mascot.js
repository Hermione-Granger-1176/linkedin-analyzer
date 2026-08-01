/**
 * Pip catching what you drop.
 *
 * He is out of the page until a file is dragged over the drop zone, comes up
 * behind its bottom edge with his arms out while the file is still in the air,
 * and hugs the page once it lands. The drawing and both arm poses live in
 * index.html; all this owns is which pose is showing and for how long.
 *
 * He is decoration, so a visitor who asked for reduced motion gets the drawing
 * standing still during the drag and nothing at all on the drop. The stylesheet
 * switches the moves off on the same preference, so the two agree even if one
 * of them is reached on its own.
 */

const CATCHER_ID = "uploadCatcher";
const POSE_ATTRIBUTE = "data-pose";
const READY_POSE = "ready";
const CATCH_POSE = "catch";
/* The hug runs 0.9s and the fade over it ends at 1.05s, which keeps the whole
   moment clear of the upload feedback it plays in front of. */
const CATCH_LIFETIME_MS = 1100;

let catchTimer = 0;

/**
 * Check whether the visitor asked for reduced motion.
 * @returns {boolean} True when the reduce preference is set.
 */
function prefersReducedMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Find the drop zone's Pip, on the screens that have one.
 * @returns {HTMLElement|null} The catcher element, or null where it is absent.
 */
function getCatcher() {
    return document.getElementById(CATCHER_ID);
}

/**
 * Put Pip away, whether the drag left the zone or the catch has played out.
 * @returns {void}
 */
export function hideCatcher() {
    const catcher = getCatcher();
    if (!catcher) {
        return;
    }
    window.clearTimeout(catchTimer);
    // The element is an <svg>, and `hidden` is an HTMLElement property: setting
    // it there would never reach the attribute the stylesheet matches on.
    catcher.setAttribute("hidden", "");
    catcher.setAttribute(POSE_ATTRIBUTE, READY_POSE);
}

/**
 * Bring Pip up at the edge of the zone, arms out, while a file is over it.
 * Dragging fires by the frame, so a second call while he is already up leaves
 * him alone rather than restarting his entrance under the pointer.
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

    window.clearTimeout(catchTimer);
    catcher.removeAttribute("hidden");
    // Back to the ready pose first so a second drop replays the catch instead
    // of holding the pose it is already in.
    catcher.setAttribute(POSE_ATTRIBUTE, READY_POSE);
    void catcher.getBoundingClientRect();
    catcher.setAttribute(POSE_ATTRIBUTE, CATCH_POSE);
    // A drop can take the screen out from under him, and an animation in a
    // display:none subtree never ends, so the timer is what puts him away.
    catchTimer = window.setTimeout(hideCatcher, CATCH_LIFETIME_MS);
}
