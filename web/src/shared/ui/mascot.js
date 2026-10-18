/* Pip mascot interactions: click splats, the clean-export cheer, the PDF staple,
   and the upload eraser. These animations are decorative and disabled when
   reduced motion is requested. */

import { DataCache } from "../../platform/persistence/data-cache.js";
import { DomEvents } from "../dom-events.js";

import { playOneShot, prefersReducedMotion } from "./motion.js";

const SPLAT_TARGETS = ".primary-btn, .download-btn";
const SPLAT_PATH =
    "M13 1 q5 5 6 10 q4 1 4 4 q-1 3 -5 2 q-2 5 -6 6 q-5 0 -7 -5 q-4 1 -4 -3 q0 -3 4 -4 q0 -6 8 -10 Z";
/* Remove the splat after its 0.55s CSS animation. */
const SPLAT_LIFETIME_MS = 800;
/* The event upload.js broadcasts once a wipe has actually gone through. */
const STORAGE_CLEARED = "storageCleared";

/* One-shot pose configuration. Keep the durations slightly beyond the 1.4s
   pip-moment-in animation in components/mascot.css. */
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
    // Keyboard clicks report coordinates 0,0. Center the splat on the button
    // because those clicks have no pointer position.
    const fromKeyboard = event.detail === 0;
    const x = fromKeyboard ? rect.width / 2 : event.clientX - rect.left;
    const y = fromKeyboard ? rect.height / 2 : event.clientY - rect.top;
    splat.style.left = `${x}px`;
    splat.style.top = `${y}px`;
    // Hidden screens do not emit animationend. The timeout removes the splat
    // even after navigation. A completed animation cancels that timeout.
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
            // Clear the stored timer ID after it fires so a later call cannot
            // cancel a timer that reuses that ID.
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
    // Start the eraser animation after storage announces a completed clear.
    // The notifier handles listener failures so decoration cannot fail the clear.
    DataCache.subscribe((/** @type {{type?: unknown}} */ event) => {
        if (event.type === STORAGE_CLEARED) {
            celebrateClear();
        }
    });
}
