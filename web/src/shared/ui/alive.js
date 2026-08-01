/* The alive layer: the three things hero Pip does on his own, without anyone
   asking him to. His eyes follow the pointer, he gets visibly bored when the
   page has been still for a while, and he flinches when the lights change.

   All three are decoration on a drawing that is already aria-hidden, so all
   three sit out entirely under reduced motion, and the gaze also sits out on
   touch, where there is no pointer to follow.

   The one-shots are finite CSS animations, and each one is taken off by a timer
   rather than by animationend: an animation that starts inside a hidden subtree
   never ends, and a class left on for good would leave the screenshot harness
   waiting for a move that is never going to finish. */

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
/* Where the pointer was last seen. Only ever read on a frame that a pointermove
   booked, so it is a plain pair rather than something nullable. */
let pendingPointer = { x: 0, y: 0 };
/* Theme.init() announces the theme it settled on at boot, which is not a visitor
   reaching for the switch. The first announcement only arms the reaction. */
let themeSettled = false;

/**
 * Check whether the visitor asked for reduced motion.
 * @returns {boolean} True when the reduce preference is set.
 */
function prefersReducedMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

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
    // A hidden hero measures zero on every side, and aiming at the top left
    // corner of the viewport is not a glance worth drawing.
    if (rect.width === 0 && rect.height === 0) {
        return;
    }

    const dx = clamp((pointer.x - (rect.left + rect.width / 2)) / GAZE_REACH_PX, -1, 1);
    const dy = clamp((pointer.y - (rect.top + rect.height / 2)) / GAZE_REACH_PX, -1, 1);
    const x = (dx * GAZE_TRAVEL_X).toFixed(2);
    const y = (dy * GAZE_TRAVEL_Y).toFixed(2);
    gaze.style.transform = `translate(${x}px, ${y}px)`;
}

/**
 * Note where the pointer is and book a frame to move the eyes there.
 * @param {PointerEvent} event - The pointer move that came in.
 * @returns {void}
 */
function handlePointerMove(event) {
    pendingPointer = { x: event.clientX, y: event.clientY };
    if (gazeFrame) {
        return;
    }
    gazeFrame = window.requestAnimationFrame(applyGaze);
}

/**
 * Play the bored yawn, once, and take it off again afterwards.
 * @returns {void}
 */
function playIdleDoodle() {
    const hero = heroElement();
    if (!hero || !homeIsVisible()) {
        // Nothing to yawn at. Any activity re-arms the timer from scratch.
        return;
    }
    window.clearTimeout(doodleTimer);
    hero.classList.add("is-bored");
    doodleTimer = window.setTimeout(() => hero.classList.remove("is-bored"), IDLE_DOODLE_MS);
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
    const hero = heroElement();
    if (hero && hero.classList.contains("is-bored")) {
        window.clearTimeout(doodleTimer);
        hero.classList.remove("is-bored");
    }
    restartIdleTimer();
}

/**
 * React to the lights going on or off: a hard double blink and a shake of the
 * hair, over inside a second.
 * @returns {void}
 */
function handleThemeChange() {
    if (!themeSettled) {
        themeSettled = true;
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
 * a second call would double every listener. Reduced motion opts out of all of
 * it, and a device without a fine pointer keeps the last two.
 * @returns {void}
 */
export function initAlive() {
    if (started || prefersReducedMotion()) {
        return;
    }
    started = true;

    if (hasFinePointer()) {
        window.addEventListener("pointermove", handlePointerMove, { passive: true });
    }
    ACTIVITY_EVENTS.forEach((name) => {
        window.addEventListener(name, handleActivity, { passive: true });
    });
    document.addEventListener("themechange", handleThemeChange);
    restartIdleTimer();
}
