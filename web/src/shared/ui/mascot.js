/* Pip mascot interactions: an ink splat where a button was clicked, and the
   short moments that close a finished job off. A cheer when a clean export
   lands, a staple when a PDF is built, and an eraser sweep once the stored
   uploads have been wiped. All of it is decoration, so all of it sits out
   entirely when the visitor asked for reduced motion. */

import { DataCache } from "../../platform/persistence/data-cache.js";
import { DomEvents } from "../dom-events.js";

import { playOneShot, prefersReducedMotion } from "./motion.js";

const SPLAT_TARGETS = ".primary-btn, .download-btn";
const SPLAT_PATH =
    "M13 1 q5 5 6 10 q4 1 4 4 q-1 3 -5 2 q-2 5 -6 6 q-5 0 -7 -5 q-4 1 -4 -3 q0 -3 4 -4 q0 -6 8 -10 Z";
/* Comfortably past the 0.55s splat animation. */
const SPLAT_LIFETIME_MS = 800;
/* The event upload.js broadcasts once a wipe has actually gone through. */
const STORAGE_CLEARED = "storageCleared";

/* Each one-shot pose: the element it is drawn in, the class its animations hang
   off, and how long it stays on screen. All three share the 1.4s pip-moment-in
   envelope in components/mascot.css and sit just past it, so each pose is fully
   faded out before the timer takes it away. */
const CHEER = Object.freeze({ id: "cleanCheer", activeClass: "is-cheering", durationMs: 1700 });
const STAPLE = Object.freeze({ id: "pdfStaple", activeClass: "is-stapling", durationMs: 1700 });
const ERASER = Object.freeze({ id: "clearEraser", activeClass: "is-erasing", durationMs: 1700 });

/** @type {Map<string, number>} */
const momentTimers = new Map();
let initialized = false;

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
    // A click the keyboard raised carries no pointer position and reports 0,0,
    // which would drop the splat off in the button's top left corner. There is
    // no place the visitor aimed at, so the middle of the button it is.
    const fromKeyboard = event.detail === 0;
    const x = fromKeyboard ? rect.width / 2 : event.clientX - rect.left;
    const y = fromKeyboard ? rect.height / 2 : event.clientY - rect.top;
    splat.style.left = `${x}px`;
    splat.style.top = `${y}px`;
    // A route button hides its own screen on the way out, and an animation in a
    // display:none subtree never ends, so the splat would sit there for good.
    // The backstop clears it either way, and a splat that did get to finish
    // takes its own backstop off on the way out.
    const backstop = window.setTimeout(() => splat.remove(), SPLAT_LIFETIME_MS);
    splat.addEventListener(
        "animationend",
        () => {
            window.clearTimeout(backstop);
            splat.remove();
        },
        { once: true },
    );
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
 * Show one of the moments, from its class, for as long as it is worth showing.
 * @param {{id: string, activeClass: string, durationMs: number}} moment - The pose to play.
 * @returns {void}
 */
function playMoment(moment) {
    if (prefersReducedMotion()) {
        return;
    }
    const { id, activeClass, durationMs } = moment;
    const pose = document.getElementById(id);
    if (!pose) {
        return;
    }

    momentTimers.set(
        id,
        playOneShot({
            element: pose,
            durationMs,
            previousTimer: momentTimers.get(id),
            apply: () => pose.classList.add(activeClass),
            reset: () => pose.classList.remove(activeClass),
            // The id it was filed under is spent, and clearing a spent timer id
            // could land on whatever the environment handed out next.
            done: () => momentTimers.delete(id),
        }),
    );
}

/**
 * Play the fist pump next to the clean download button, then put Pip away.
 * Called when an Excel export has actually been generated and downloaded.
 * @returns {void}
 */
export function celebrateDownload() {
    playMoment(CHEER);
}

/**
 * Staple the pages together under the export button, then put Pip away.
 * Called when a PDF has actually been built and downloaded.
 * @returns {void}
 */
export function celebrateStaple() {
    playMoment(STAPLE);
}

/**
 * Rub the Files card clean, then put Pip away. Driven by the storage event
 * rather than by the button, so the sweep only ever follows a wipe that went
 * through: a clear that failed leaves its own message in the card instead.
 * @returns {void}
 */
function celebrateClear() {
    playMoment(ERASER);
}

/**
 * Bind the mascot's event-driven decoration for the life of the page. Binding
 * is one-shot: a second call would leave two splats behind every click, and two
 * eraser sweeps behind every wipe.
 * @returns {void}
 */
export function initMascot() {
    if (initialized) {
        return;
    }
    initialized = true;
    document.addEventListener("click", handleClick);
    // Reading the wipe off the app-wide notification keeps the moment out of the
    // upload flow entirely: the sweep starts after the clearing is already done,
    // and a listener that threw would be caught and reported by the notifier
    // rather than left to break the clear.
    DataCache.subscribe((event) => {
        if (event.type === STORAGE_CLEARED) {
            celebrateClear();
        }
    });
}
