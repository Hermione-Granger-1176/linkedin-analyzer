/* Pip mascot interactions: an ink splat where a button was clicked, and a
   short celebration when a clean export lands. Both are decoration, so both
   sit out entirely when the visitor asked for reduced motion. */

import { DomEvents } from "../dom-events.js";

const SPLAT_TARGETS = ".primary-btn, .download-btn";
const SPLAT_PATH =
    "M13 1 q5 5 6 10 q4 1 4 4 q-1 3 -5 2 q-2 5 -6 6 q-5 0 -7 -5 q-4 1 -4 -3 q0 -3 4 -4 q0 -6 8 -10 Z";
/* Comfortably past the 0.55s splat animation. */
const SPLAT_LIFETIME_MS = 800;
const CHEER_ID = "cleanCheer";
/* Long enough for the 0.85s cheer to play out, short enough that nothing
   lingers on screen once the download is old news. */
const CHEER_DURATION_MS = 2000;

let cheerTimer = 0;
let clickBound = false;

/**
 * Check whether the visitor asked for reduced motion.
 * @returns {boolean} True when the reduce preference is set.
 */
function prefersReducedMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Drop a short-lived ink splat inside a clicked button, where the pointer was.
 * @param {MouseEvent} event - The click that landed on the button.
 * @param {Element} button - The button the splat belongs to.
 * @returns {void}
 */
function spawnSplat(event, button) {
    const rect = button.getBoundingClientRect();
    const splat = document.createElement("span");
    splat.className = "pip-splat";
    splat.setAttribute("aria-hidden", "true");
    splat.innerHTML = `<svg viewBox="0 0 26 26"><path d="${SPLAT_PATH}"></path></svg>`;
    splat.style.left = `${event.clientX - rect.left}px`;
    splat.style.top = `${event.clientY - rect.top}px`;
    splat.addEventListener("animationend", () => splat.remove(), { once: true });
    // A route button hides its own screen on the way out, and an animation in a
    // display:none subtree never ends, so the splat would sit there for good.
    // The backstop clears it either way; remove() twice is harmless.
    window.setTimeout(() => splat.remove(), SPLAT_LIFETIME_MS);
    button.appendChild(splat);
}

/**
 * Handle a delegated click and splat when it landed on a splattable button.
 * @param {MouseEvent} event - The document-level click event.
 * @returns {void}
 */
function handleClick(event) {
    if (prefersReducedMotion()) {
        return;
    }
    const button = DomEvents.closest(event, SPLAT_TARGETS);
    if (!button) {
        return;
    }
    spawnSplat(event, button);
}

/**
 * Play the fist pump next to the clean download button, then put Pip away.
 * Called when an Excel export has actually been generated and downloaded.
 * @returns {void}
 */
export function celebrateDownload() {
    if (prefersReducedMotion()) {
        return;
    }
    const cheer = document.getElementById(CHEER_ID);
    if (!cheer) {
        return;
    }

    window.clearTimeout(cheerTimer);
    // The element is an <svg>, and `hidden` is an HTMLElement property: setting
    // it there would never reach the attribute the stylesheet matches on.
    cheer.removeAttribute("hidden");
    // Reapply from a clean slate so a second download replays the animation.
    cheer.classList.remove("is-cheering");
    void cheer.getBoundingClientRect();
    cheer.classList.add("is-cheering");

    cheerTimer = window.setTimeout(() => {
        cheer.classList.remove("is-cheering");
        cheer.setAttribute("hidden", "");
    }, CHEER_DURATION_MS);
}

/**
 * Bind the mascot's click-driven decoration for the life of the page. Binding
 * is one-shot: a second call would leave two splats behind every click.
 * @returns {void}
 */
export function initMascot() {
    if (clickBound) {
        return;
    }
    clickBound = true;
    document.addEventListener("click", handleClick);
}
