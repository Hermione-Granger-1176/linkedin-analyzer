/* Insight card icons and accents, shared by the card component */

const ACCENT_CLASSES = new Set([
    "accent-yellow",
    "accent-purple",
    "accent-blue",
    "accent-green",
    "accent-red",
]);
const DEFAULT_ACCENT = "accent-blue";

/**
 * Resolve the CSS class allowed for an insight card accent.
 * @param {unknown} accent - Worker-provided accent class.
 * @returns {string} A known accent class.
 */
export function resolveAccentClass(accent) {
    return typeof accent === "string" && ACCENT_CLASSES.has(accent) ? accent : DEFAULT_ACCENT;
}

/**
 * SVG markup for insight card icons, keyed by icon name.
 * @type {Readonly<Record<string, string>>}
 */
const INSIGHT_ICONS = Object.freeze({
    rooster: "<svg viewBox=\"0 0 64 64\" aria-hidden=\"true\"><circle cx=\"32\" cy=\"32\" r=\"16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/><path d=\"M24 20 Q28 12 32 18 Q36 12 40 20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/><path d=\"M40 32 L50 28\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/><path d=\"M22 44 Q32 52 42 44\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/></svg>",
    owl: "<svg viewBox=\"0 0 64 64\" aria-hidden=\"true\"><circle cx=\"32\" cy=\"32\" r=\"18\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/><circle cx=\"26\" cy=\"30\" r=\"4\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/><circle cx=\"38\" cy=\"30\" r=\"4\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/><path d=\"M30 40 L32 42 L34 40\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/></svg>",
    rocket: "<svg viewBox=\"0 0 64 64\" aria-hidden=\"true\"><path d=\"M32 6 C44 12 52 24 52 34 C52 46 42 54 32 58 C22 54 12 46 12 34 C12 24 20 12 32 6 Z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/><circle cx=\"32\" cy=\"30\" r=\"6\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/><path d=\"M26 58 L22 62 L30 60\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/><path d=\"M38 58 L42 62 L34 60\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/></svg>",
    sloth: "<svg viewBox=\"0 0 64 64\" aria-hidden=\"true\"><circle cx=\"32\" cy=\"32\" r=\"18\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/><circle cx=\"26\" cy=\"30\" r=\"3\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/><circle cx=\"38\" cy=\"30\" r=\"3\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/><path d=\"M28 40 Q32 44 36 40\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/><path d=\"M20 24 Q32 18 44 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/></svg>",
    monkey: "<svg viewBox=\"0 0 64 64\" aria-hidden=\"true\"><circle cx=\"32\" cy=\"32\" r=\"16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/><circle cx=\"18\" cy=\"30\" r=\"6\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/><circle cx=\"46\" cy=\"30\" r=\"6\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/><circle cx=\"26\" cy=\"30\" r=\"3\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/><circle cx=\"38\" cy=\"30\" r=\"3\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/><path d=\"M26 40 Q32 44 38 40\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/></svg>",
    handshake: "<svg viewBox=\"0 0 64 64\" aria-hidden=\"true\"><path d=\"M10 36 L24 24 L34 34\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/><path d=\"M54 36 L40 24 L30 34\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/><path d=\"M24 24 L32 18 L40 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/></svg>",
    trophy: "<svg viewBox=\"0 0 64 64\" aria-hidden=\"true\"><path d=\"M20 12 H44 V24 C44 32 38 38 32 38 C26 38 20 32 20 24 Z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/><path d=\"M16 12 H8 C8 24 14 30 20 30\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/><path d=\"M48 12 H56 C56 24 50 30 44 30\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/><path d=\"M28 38 V48 H36 V38\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/><path d=\"M24 52 H40\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/></svg>",
    calendar: "<svg viewBox=\"0 0 64 64\" aria-hidden=\"true\"><rect x=\"12\" y=\"16\" width=\"40\" height=\"36\" rx=\"4\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/><path d=\"M12 26 H52\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/><path d=\"M22 12 V20 M42 12 V20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/><path d=\"M22 36 L28 42 L40 30\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/></svg>",
    flame: "<svg viewBox=\"0 0 64 64\" aria-hidden=\"true\"><path d=\"M32 10 C36 18 26 22 30 30 C32 34 40 34 40 42 C40 50 34 54 32 54 C26 54 22 48 22 42 C22 34 28 30 26 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/></svg>",
    compass: "<svg viewBox=\"0 0 64 64\" aria-hidden=\"true\"><circle cx=\"32\" cy=\"32\" r=\"20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/><path d=\"M40 24 L34 34 L24 40 L30 30 Z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/></svg>",
    scale: "<svg viewBox=\"0 0 64 64\" aria-hidden=\"true\"><path d=\"M32 12 V52 M18 52 H46\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/><path d=\"M14 20 H50 M14 20 L8 34 H20 Z M50 20 L44 34 H56 Z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/></svg>",
});

/**
 * Return SVG markup for a named insight icon.
 * @param {string} name - The icon name.
 * @returns {string} The SVG markup string.
 */
export function insightIcon(name) {
    return INSIGHT_ICONS[name] || INSIGHT_ICONS.calendar;
}
