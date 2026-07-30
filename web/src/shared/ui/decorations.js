/* RoughJS background decorations */

import rough from "roughjs/bundled/rough.esm.js";

export function initDecorations() {
    "use strict";

    const canvas = /** @type {HTMLCanvasElement|null} */ (document.getElementById("roughCanvas"));
    if (!canvas || !rough) {
        return;
    }

    // Fixed position canvas covers viewport
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const rc = rough.canvas(canvas);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        return;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const styles = getComputedStyle(document.documentElement);
    /* v8 ignore next 5 */
    const colors = {
        blue: styles.getPropertyValue("--decoration-blue").trim() || "rgba(46, 66, 209, 0.12)",
        yellow: styles.getPropertyValue("--decoration-yellow").trim() || "rgba(251, 188, 5, 0.10)",
        purple: styles.getPropertyValue("--decoration-purple").trim() || "rgba(202, 59, 226, 0.10)",
    };

    // Top-right decoration
    rc.circle(canvas.width - 120, 180, 220, {
        fill: colors.blue,
        fillStyle: "solid",
        stroke: "transparent",
        roughness: 2,
    });

    // Bottom-left decoration
    rc.circle(80, canvas.height - 100, 190, {
        fill: colors.purple,
        fillStyle: "solid",
        stroke: "transparent",
        roughness: 2,
    });

    // Bottom-right decoration
    rc.circle(canvas.width - 240, canvas.height - 80, 120, {
        fill: colors.yellow,
        fillStyle: "solid",
        stroke: "transparent",
        roughness: 2,
    });
}
