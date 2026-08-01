/* RoughJS background decorations */

import rough from "roughjs/bundled/rough.esm.js";

/**
 * Build the RoughJS options for one background circle.
 * Light paints a solid tinted blob; dark draws the same circle as a faint chalk
 * outline, because a tinted fill over a near-black ground only reads as a smudge.
 * @param {string} color - Resolved decoration color
 * @param {boolean} outline - Draw a chalk outline instead of a solid fill
 * @returns {object} Options for rough.canvas().circle()
 */
function circleOptions(color, outline) {
    if (outline) {
        return { stroke: color, strokeWidth: 1.8, roughness: 2.2 };
    }
    return { fill: color, fillStyle: "solid", stroke: "transparent", roughness: 2 };
}

/* The frame a resize has booked, so a drag repaints once per frame rather than
   once per event. */
let resizeFrame = 0;

/** Size the decoration canvas to the viewport and redraw it for the current theme. */
function draw() {
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
    const outline = document.documentElement.getAttribute("data-theme") === "dark";

    // Top-right decoration
    rc.circle(canvas.width - 120, 180, 220, circleOptions(colors.blue, outline));

    // Bottom-left decoration
    rc.circle(80, canvas.height - 100, 190, circleOptions(colors.purple, outline));

    // Bottom-right decoration
    rc.circle(canvas.width - 240, canvas.height - 80, 120, circleOptions(colors.yellow, outline));
}

/**
 * Repaint after a resize, at most once per animation frame. A resize drag fires
 * a long stream of events, and only the size the last of them leaves behind is
 * worth a repaint.
 * @returns {void}
 */
function handleResize() {
    if (resizeFrame) {
        return;
    }
    resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = 0;
        draw();
    });
}

/**
 * Draw the background decorations and keep them in step with the theme and the
 * viewport. The colors and the fill-versus-outline treatment both come from the
 * active theme, so a toggle has to repaint the canvas or the doodles keep the
 * palette they were born with, and the canvas is sized to the window, so a
 * resize has to repaint it or the doodles stay at the old size, stretched.
 * Registering the same listener twice is ignored, so calling this more than once
 * never stacks up redraws.
 */
export function initDecorations() {
    document.addEventListener("themechange", draw);
    window.addEventListener("resize", handleResize, { passive: true });
    draw();
}
