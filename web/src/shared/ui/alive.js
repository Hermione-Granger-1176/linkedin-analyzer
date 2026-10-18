/* Hero mascot behavior: pointer gaze, idle yawn, and wake-up animation.

   The drawing is aria-hidden. Reduced motion is checked when each animation
   starts, so a preference change applies to the next animation. Gaze is disabled
   on touch devices. Timers remove one-shot classes because hidden SVG elements do
   not reliably emit animationend. */

import { prefersReducedMotion } from "./motion.js";

const HERO_SELECTOR = ".pip-hero";
const GAZE_SELECTOR = ".pip-gaze";
const HOME_SCREEN_ID = "screen-home";

/* Pip is bored after this long with nothing happening on the page. */
const IDLE_DELAY_MS = 20000;
/* Remove each one-shot class after its CSS animation. Keep these values in sync
   with the pip-idle-yawn and pip-wake-* durations in components/mascot.css. */
const IDLE_DOODLE_MS = 2600;
const WAKE_MS = 800;

/* Maximum gaze offsets in viewBox units. Limit vertical movement to the
1.3 units below the brows so the pupils do not touch them. */
const GAZE_TRAVEL_X = 1.6;
const GAZE_TRAVEL_Y = 0.8;
/* The pointer distance at which the gaze is already all the way over. Past this
   Pip is looking as far as he is going to look. */
const GAZE_REACH_PX = 280;

const ACTIVITY_EVENTS = Object.freeze(["pointermove", "pointerdown", "keydown", "wheel"]);

let started = false;
let idleTimer = 0;
let doodleTimer = 0;
let wakeTimer = 0;
let gazeFrame = 0;
/* Where the pointer was last seen, and whether it has ever been seen at all. A
   scroll aims at that same position, and before the first move there is no
   position to aim at, only the origin. */
const pendingPointer = { x: 0, y: 0 };
let pointerSeen = false;
/* Whether a yawn is active. Avoid repeated DOM updates from activity events. */
let bored = false;

/**
 * Check whether the device drives a real pointer that Pip could follow.
 * @returns {boolean} True on a fine pointer such as a mouse or trackpad.
 */
function hasFinePointer() {
    return window.matchMedia("(pointer: fine)").matches;
}

/**
 * Find the hero Pip drawing, which only exists on the Home screen.
 * @returns {SVGElement|null} The hero svg, or null when it is not in the page.
 */
function heroElement() {
    return /** @type {SVGElement|null} */ (document.querySelector(HERO_SELECTOR));
}

/**
 * Check whether the Home screen is the one currently on show. Pip should not be
 * yawning at a screen nobody can see, and an animation started on a hidden
 * screen would not run anyway.
 * @returns {boolean} True when the Home screen is the active route screen.
 */
function homeIsVisible() {
    const home = document.getElementById(HOME_SCREEN_ID);
    return Boolean(home && home.classList.contains("active"));
}

/**
 * Clamp a value into a range.
 * @param {number} value - The value to clamp.
 * @param {number} min - Lower bound.
 * @param {number} max - Upper bound.
 * @returns {number} The value, held inside the bounds.
 */
function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

/**
 * Move the pupils toward the latest pointer position once per animation frame.
 * @returns {void}
 */
function applyGaze() {
    gazeFrame = 0;
    if (prefersReducedMotion()) {
        return;
    }
    const pointer = pendingPointer;
    const hero = heroElement();
    if (!hero) {
        return;
    }
    const gaze = /** @type {SVGElement|null} */ (hero.querySelector(GAZE_SELECTOR));
    if (!gaze) {
        return;
    }

    const rect = hero.getBoundingClientRect();
    // A hidden or zero-width drawing has no useful gaze position. Reset its
    // offset before returning.
    if (!rect.width || !rect.height) {
        gaze.style.transform = "";
        return;
    }

    const dx = clamp((pointer.x - (rect.left + rect.width / 2)) / GAZE_REACH_PX, -1, 1);
    const dy = clamp((pointer.y - (rect.top + rect.height / 2)) / GAZE_REACH_PX, -1, 1);
    const x = (dx * GAZE_TRAVEL_X).toFixed(2);
    const y = (dy * GAZE_TRAVEL_Y).toFixed(2);
    gaze.style.transform = `translate(${x}px, ${y}px)`;
}

/**
 * Schedule the gaze update unless an animation frame is already pending.
 * @returns {void}
 */
function bookGaze() {
    if (gazeFrame) {
        return;
    }
    gazeFrame = window.requestAnimationFrame(applyGaze);
}

/**
 * Record the pointer position and schedule a gaze update.
 * @param {PointerEvent} event - The pointer move that came in.
 * @returns {void}
 */
function handlePointerMove(event) {
    pendingPointer.x = event.clientX;
    pendingPointer.y = event.clientY;
    pointerSeen = true;
    bookGaze();
}

/**
 * Aim the eyes again after a scroll. The pointer has not moved, but the hero has
 * moved under it, so the offset the pupils are holding is aimed at where the
 * pointer used to be relative to the drawing.
 * @returns {void}
 */
function handleScroll() {
    if (!pointerSeen) {
        return;
    }
    bookGaze();
}

/**
 * Play the bored yawn, once, and take it off again afterwards.
 * @returns {void}
 */
function playIdleDoodle() {
    if (prefersReducedMotion()) {
        return;
    }
    const hero = heroElement();
    if (!hero || !homeIsVisible()) {
        // Nothing to yawn at. Any activity re-arms the timer from scratch.
        return;
    }
    window.clearTimeout(doodleTimer);
    bored = true;
    hero.classList.add("is-bored");
    doodleTimer = window.setTimeout(() => {
        bored = false;
        hero.classList.remove("is-bored");
    }, IDLE_DOODLE_MS);
}

/**
 * Reset the idle timer after page activity.
 * @returns {void}
 */
function restartIdleTimer() {
    window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(playIdleDoodle, IDLE_DELAY_MS);
}

/**
 * Handle any activity: cut a yawn already in progress short, and reset the wait
 * for the next one.
 * @returns {void}
 */
function handleActivity() {
    if (bored) {
        bored = false;
        window.clearTimeout(doodleTimer);
        heroElement()?.classList.remove("is-bored");
    }
    restartIdleTimer();
}

/**
 * Play the blink and hair-shake animation after a user changes the theme.
 * @param {Event} event - The themechange announcement, a CustomEvent.
 * @returns {void}
 */
function handleThemeChange(event) {
    // Theme.init() emits a boot event without a user action.
    if (/** @type {CustomEvent} */ (event).detail?.boot) {
        return;
    }
    if (prefersReducedMotion()) {
        return;
    }
    const hero = heroElement();
    if (!hero || !homeIsVisible()) {
        return;
    }
    window.clearTimeout(wakeTimer);
    // Remove the class and force layout so another toggle restarts the animation.
    hero.classList.remove("is-waking");
    void hero.getBoundingClientRect();
    hero.classList.add("is-waking");
    wakeTimer = window.setTimeout(() => hero.classList.remove("is-waking"), WAKE_MS);
}

/**
 * Bind hero gaze, idle yawn, and theme-change reactions once.
 * Each animation checks the current motion preference. Devices without
 * a fine pointer skip gaze tracking.
 * @returns {void}
 */
export function initAlive() {
    if (started) {
        return;
    }
    started = true;

    if (hasFinePointer()) {
        window.addEventListener("pointermove", handlePointerMove, { passive: true });
        window.addEventListener("scroll", handleScroll, { passive: true });
    }
    ACTIVITY_EVENTS.forEach((name) => {
        window.addEventListener(name, handleActivity, { passive: true });
    });
    document.addEventListener("themechange", handleThemeChange);
    restartIdleTimer();
}
