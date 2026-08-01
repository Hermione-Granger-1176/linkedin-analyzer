/* The alive layer: the three things hero Pip does on his own, without anyone
   asking him to. His eyes follow the pointer, he gets visibly bored when the
   page has been still for a while, and he flinches when the lights change.

   All three are decoration on a drawing that is already aria-hidden, so all
   three sit out under reduced motion. The preference is read when a move would
   play rather than once at startup, so a visitor who turns it on or off part way
   through the session is obeyed from the next move onwards; the timers behind a
   move keep running either way, they just stop producing anything visible. The
   gaze also sits out on touch, where there is no pointer to follow, and that one
   is settled at startup because it is a property of the device, not a choice.

   The one-shots are finite CSS animations, and each one is taken off by a timer
   rather than by animationend: an animation that starts inside a hidden subtree
   never ends, and a class left on for good would leave the screenshot harness
   waiting for a move that is never going to finish. */

import { prefersReducedMotion } from "./motion.js";

const HERO_SELECTOR = ".pip-hero";
const GAZE_SELECTOR = ".pip-gaze";
const HOME_SCREEN_ID = "screen-home";

/* Pip is bored after this long with nothing happening on the page. */
const IDLE_DELAY_MS = 20000;
/* Each one-shot's class comes off a little after its animation is due to end,
   so the move always plays out and never outstays it. Keep these in step with
   the pip-idle-yawn and pip-wake-* durations in components/mascot.css. */
const IDLE_DOODLE_MS = 2600;
const WAKE_MS = 800;

/* How far the eyes travel, in viewBox units. Sideways there is most of a face to
   move across, so the cap is what keeps the glance a glance. Upwards there is
   only about 1.3 units of clearance before an eye meets the brow inked above it,
   which reads as a scowl rather than a look, so the vertical cap is the drawing's
   headroom rather than a matching number. */
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
/* Whether the yawn is on right now. Activity arrives a few hundred times a
   minute, and this is what keeps all but the interesting one out of the DOM. */
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
 * Point the pupils at the last pointer position we were given. Runs inside an
 * animation frame, so a storm of pointermove events still only moves the eyes
 * once per painted frame.
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
    // A hidden hero measures zero on at least one side, and a box with no width
    // or no height puts the centre somewhere Pip is not. Drop the last offset on
    // the way out, so he is looking straight ahead when he comes back.
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
 * Book the frame that aims the eyes, unless one is already booked.
 * @returns {void}
 */
function bookGaze() {
    if (gazeFrame) {
        return;
    }
    gazeFrame = window.requestAnimationFrame(applyGaze);
}

/**
 * Note where the pointer is and book a frame to move the eyes there.
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
 * Start the boredom clock over. Called for every sign of life on the page.
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
 * React to the lights going on or off: a hard double blink and a shake of the
 * hair, over inside a second.
 * @param {CustomEvent} event - The themechange announcement.
 * @returns {void}
 */
function handleThemeChange(event) {
    // Theme.init() announces the theme it settled on at boot, which is nobody
    // reaching for the switch, and it says so in the event it sends.
    if (event.detail?.boot) {
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
    // Reapply from a clean slate so a second toggle replays the flinch rather
    // than leaving the class sitting there doing nothing.
    hero.classList.remove("is-waking");
    void hero.getBoundingClientRect();
    hero.classList.add("is-waking");
    wakeTimer = window.setTimeout(() => hero.classList.remove("is-waking"), WAKE_MS);
}

/**
 * Give hero Pip his own life: eyes that follow the pointer, a yawn when the page
 * has gone quiet, and a flinch at the theme switch. Binding is one-shot, because
 * a second call would double every listener. The listeners go on whatever the
 * motion preference says, since each move checks it for itself when the time
 * comes; a device without a fine pointer keeps the last two.
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
