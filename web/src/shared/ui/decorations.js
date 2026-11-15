/* RoughJS background decorations */

import rough from "roughjs/bundled/rough.esm.js";

/**
 * Build the RoughJS options for one background circle.
 * Light paints a solid tinted blob; dark draws the same circle as a faint chalk
 * outline.
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

/* Handle of the pending animation frame for a resize repaint, or 0 when none is pending. */
let resizeFrame = 0;

/** Size the decoration canvas to the viewport and redraw it for the current theme. */
function draw() {
    const canvas = /** @type {HTMLCanvasElement|null} */ (document.getElementById("roughCanvas"));
    if (!canvas) {
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
    const colors = {
        blue: styles.getPropertyValue("--decoration-blue").trim(),
        yellow: styles.getPropertyValue("--decoration-yellow").trim(),
        purple: styles.getPropertyValue("--decoration-purple").trim(),
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
 * Repaint after a resize, at most once per animation frame.
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
 * Draw theme-colored background decorations and register update listeners.
 * Redraw on theme changes and viewport resize. Repeated initialization
 * does not add duplicate listeners.
 */
export function initDecorations() {
    document.addEventListener("themechange", draw);
    window.addEventListener("resize", handleResize, { passive: true });
    draw();
}
