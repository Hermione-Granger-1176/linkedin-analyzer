/**
 * Hand-drawn pointer arrow variants for the tutorial overlay.
 *
 * A step may name a variant explicitly; otherwise one is picked by hashing the
 * step's identity so the same step always draws the same arrow. Pure: the
 * result depends only on the arguments.
 */

import { hashString } from "./geometry.js";

/**
 * @typedef {{name: string, style: string, body: string, echo: string, head: string}} ArrowVariant
 */

/** @type {readonly ArrowVariant[]} */
const ARROW_VARIANTS = Object.freeze([
    {
        name: "classic",
        style: "solid",
        body: "M 13 78 C 24 58 45 37 74 20",
        echo: "M 18 77 C 29 58 47 42 70 26",
        head: "M 63 17 L 81 20 L 70 34",
    },
    {
        name: "hook",
        style: "solid",
        body: "M 12 75 C 21 57 35 48 50 50 C 64 52 74 40 82 22",
        echo: "M 16 74 C 24 58 37 51 50 53",
        head: "M 70 19 L 84 22 L 77 34",
    },
    {
        name: "dash",
        style: "dashed",
        body: "M 14 76 C 24 61 39 49 55 41 C 65 35 74 27 82 17",
        echo: "M 19 76 C 30 62 45 51 60 42",
        head: "M 71 14 L 84 17 L 77 29",
    },
    {
        name: "swoop",
        style: "solid",
        body: "M 10 79 C 28 68 26 55 40 48 C 54 41 67 30 79 18",
        echo: "M 16 78 C 31 68 32 56 44 49",
        head: "M 68 14 L 81 18 L 75 30",
    },
]);

/**
 * Pick an arrow variant for the current step.
 * @param {object} step - Step config
 * @param {string} routeName - Active route name
 * @param {number} currentIndex - Current step index
 * @returns {ArrowVariant}
 */
export function resolvePointerVariant(step, routeName, currentIndex) {
    const preferredName = String(step && step.arrowStyle ? step.arrowStyle : "")
        .trim()
        .toLowerCase();
    const preferred = preferredName
        ? ARROW_VARIANTS.find((variant) => variant.name === preferredName)
        : null;
    if (preferred) {
        return preferred;
    }

    const key = [routeName, step && step.id ? step.id : "", String(currentIndex)].join(":");
    const hash = hashString(key);
    return ARROW_VARIANTS[hash % ARROW_VARIANTS.length];
}
