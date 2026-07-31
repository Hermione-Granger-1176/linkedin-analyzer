/**
 * Palette reader for the PDF export.
 *
 * The exported document is always light, warm-palette, regardless of the theme
 * the user is looking at. Rather than duplicating hex values in JavaScript --
 * which would silently drift from the stylesheet -- the colors are read back
 * out of the light palette at export time by mounting a detached element that
 * carries the `.theme-light` class.
 */

// Tokens the layout engine draws with. Each is a custom property defined by the
// light palette in styles/foundations/variables.css.
const PDF_PALETTE_TOKENS = Object.freeze([
    "--bg-primary",
    "--bg-secondary",
    "--bg-tertiary",
    "--text-primary",
    "--text-secondary",
    "--text-muted",
    "--border-color",
    "--border-light",
    "--accent-blue",
    "--accent-blue-light",
    "--accent-blue-bg",
    "--accent-yellow",
    "--accent-yellow-light",
    "--accent-yellow-bg",
    "--accent-red",
    "--accent-red-light",
    "--accent-red-bg",
    "--accent-green",
    "--accent-green-light",
    "--accent-green-bg",
    "--accent-purple",
    "--accent-purple-light",
    "--accent-purple-bg",
]);

// jsdom does not implement custom-property resolution, and a browser that fails
// to apply the stylesheet would otherwise produce an all-black document. These
// mirror the light values in variables.css.
const FALLBACK_PALETTE = Object.freeze({
    "--bg-primary": Object.freeze({ r: 255, g: 253, b: 247 }),
    "--bg-secondary": Object.freeze({ r: 253, g: 250, b: 245 }),
    "--bg-tertiary": Object.freeze({ r: 255, g: 248, b: 230 }),
    "--text-primary": Object.freeze({ r: 28, g: 25, b: 23 }),
    "--text-secondary": Object.freeze({ r: 87, g: 83, b: 78 }),
    "--text-muted": Object.freeze({ r: 168, g: 162, b: 158 }),
    "--border-color": Object.freeze({ r: 68, g: 64, b: 60 }),
    "--border-light": Object.freeze({ r: 214, g: 211, b: 209 }),
    "--accent-blue": Object.freeze({ r: 66, g: 133, b: 244 }),
    "--accent-blue-light": Object.freeze({ r: 210, g: 227, b: 252 }),
    "--accent-blue-bg": Object.freeze({ r: 240, g: 243, b: 247 }),
    "--accent-yellow": Object.freeze({ r: 251, g: 188, b: 5 }),
    "--accent-yellow-light": Object.freeze({ r: 255, g: 245, b: 200 }),
    "--accent-yellow-bg": Object.freeze({ r: 254, g: 243, b: 211 }),
    "--accent-red": Object.freeze({ r: 249, g: 74, b: 54 }),
    "--accent-red-light": Object.freeze({ r: 254, g: 215, b: 210 }),
    "--accent-red-bg": Object.freeze({ r: 254, g: 235, b: 228 }),
    "--accent-green": Object.freeze({ r: 41, g: 181, b: 113 }),
    "--accent-green-light": Object.freeze({ r: 200, g: 240, b: 220 }),
    "--accent-green-bg": Object.freeze({ r: 223, g: 242, b: 227 }),
    "--accent-purple": Object.freeze({ r: 155, g: 81, b: 224 }),
    "--accent-purple-light": Object.freeze({ r: 232, g: 218, b: 246 }),
    "--accent-purple-bg": Object.freeze({ r: 245, g: 236, b: 245 }),
});

// The paper the tinted tokens are composited onto. Alpha in the stylesheet is
// relative to the page background, and jsPDF has no alpha for plain fills.
const COMPOSITE_BASE = Object.freeze({ r: 255, g: 253, b: 247 });

const RGB_PATTERN = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.%]+)\s*)?\)$/i;
const HEX_PATTERN = /^#([\da-f]{3}|[\da-f]{6})$/i;

/**
 * Clamp a channel to the 0-255 byte range jsPDF expects.
 * @param {number} value - Raw channel value
 * @returns {number} Integer between 0 and 255
 */
function clampChannel(value) {
    return Math.min(255, Math.max(0, Math.round(value)));
}

/**
 * Parse an alpha component, which CSS may serialize as a fraction or percentage.
 * @param {string|undefined} raw - Captured alpha text
 * @returns {number} Alpha between 0 and 1
 */
function parseAlpha(raw) {
    if (raw === undefined) {
        return 1;
    }
    const numeric = raw.endsWith("%") ? Number.parseFloat(raw) / 100 : Number.parseFloat(raw);
    if (!Number.isFinite(numeric)) {
        return 1;
    }
    return Math.min(1, Math.max(0, numeric));
}

/**
 * Composite a translucent color over the PDF paper color.
 * @param {{r: number, g: number, b: number}} color - Source color
 * @param {number} alpha - Alpha between 0 and 1
 * @returns {{r: number, g: number, b: number}} Opaque color
 */
function flatten(color, alpha) {
    if (alpha >= 1) {
        return color;
    }
    return {
        r: clampChannel(color.r * alpha + COMPOSITE_BASE.r * (1 - alpha)),
        g: clampChannel(color.g * alpha + COMPOSITE_BASE.g * (1 - alpha)),
        b: clampChannel(color.b * alpha + COMPOSITE_BASE.b * (1 - alpha)),
    };
}

/**
 * Parse a CSS color string into opaque RGB channels.
 * Accepts `rgb()`, `rgba()` and three- or six-digit hex, and flattens any
 * transparency against the PDF paper color.
 * @param {string} value - CSS color text
 * @returns {{r: number, g: number, b: number}|null} Parsed color, or null when unrecognized
 */
export function parseCssColor(value) {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) {
        return null;
    }

    const rgbMatch = RGB_PATTERN.exec(text);
    if (rgbMatch) {
        const color = {
            r: clampChannel(Number.parseFloat(rgbMatch[1])),
            g: clampChannel(Number.parseFloat(rgbMatch[2])),
            b: clampChannel(Number.parseFloat(rgbMatch[3])),
        };
        return Object.freeze(flatten(color, parseAlpha(rgbMatch[4])));
    }

    const hexMatch = HEX_PATTERN.exec(text);
    if (hexMatch) {
        const digits = hexMatch[1];
        const expanded =
            digits.length === 3
                ? digits
                      .split("")
                      .map((digit) => digit + digit)
                      .join("")
                : digits;
        return Object.freeze({
            r: Number.parseInt(expanded.slice(0, 2), 16),
            g: Number.parseInt(expanded.slice(2, 4), 16),
            b: Number.parseInt(expanded.slice(4, 6), 16),
        });
    }

    return null;
}

/**
 * Read a token off a mounted probe element.
 * @param {CSSStyleDeclaration|null} computed - Computed style of the probe
 * @param {string} token - Custom property name
 * @returns {{r: number, g: number, b: number}|null} Parsed color, or null when unavailable
 */
function readToken(computed, token) {
    if (!computed || typeof computed.getPropertyValue !== "function") {
        return null;
    }
    return parseCssColor(computed.getPropertyValue(token));
}

/**
 * Read the light palette as RGB triples for jsPDF.
 *
 * Mounts a detached, invisible `.theme-light` element so the values come from
 * the stylesheet even when the app is in dark mode, then falls back to the
 * built-in light values for any token the environment cannot resolve.
 * @returns {Readonly<Record<string, Readonly<{r: number, g: number, b: number}>>>} Frozen palette keyed by custom property name
 */
export function readPdfPalette() {
    let probe = null;
    let computed = null;

    if (typeof document !== "undefined" && document.body) {
        probe = document.createElement("div");
        probe.className = "theme-light";
        probe.setAttribute("aria-hidden", "true");
        probe.style.position = "absolute";
        probe.style.left = "-9999px";
        probe.style.width = "0";
        probe.style.height = "0";
        probe.style.pointerEvents = "none";
        document.body.appendChild(probe);
        if (typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
            computed = window.getComputedStyle(probe);
        }
    }

    const palette = {};
    try {
        for (const token of PDF_PALETTE_TOKENS) {
            palette[token] = readToken(computed, token) || FALLBACK_PALETTE[token];
        }
    } finally {
        if (probe && probe.parentNode) {
            probe.parentNode.removeChild(probe);
        }
    }

    return Object.freeze(palette);
}

/** Token names the PDF palette exposes, in stylesheet order. */
export const PDF_PALETTE_TOKEN_NAMES = PDF_PALETTE_TOKENS;
