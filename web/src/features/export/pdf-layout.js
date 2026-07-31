/**
 * Page geometry and color arithmetic shared by the PDF layout engine.
 *
 * The document module owns blocks and pagination, and the chart module owns
 * plotting; both need the same millimetre grid and the same rules about which
 * ink reads on which fill. Those live here so neither has to import the other.
 */

/** A4 page geometry and margins, in millimetres. */
export const PAGE = Object.freeze({
    width: 210,
    height: 297,
    marginX: 16,
    marginTop: 18,
    marginBottom: 22,
});

/** Width available to content, in millimetres. */
export const CONTENT_WIDTH = PAGE.width - PAGE.marginX * 2;

/** Height available to content on one page, in millimetres. */
export const USABLE_HEIGHT = PAGE.height - PAGE.marginTop - PAGE.marginBottom;

const PT_TO_MM = 25.4 / 72;
const LINE_FACTOR = 1.32;

/** Fraction of the line box the text baseline sits at. */
export const BASELINE_RATIO = 0.78;

/**
 * @typedef {{r: number, g: number, b: number}} Rgb
 * @typedef {Readonly<Record<string, Rgb>>} Palette
 * @typedef {{height: number, draw: (x: number, y: number) => void}} Row
 */

/**
 * Convert a point size to the millimetre height of one line.
 * @param {number} fontSize - Font size in points
 * @returns {number} Line height in millimetres
 */
export function lineHeightMm(fontSize) {
    return fontSize * PT_TO_MM * LINE_FACTOR;
}

/**
 * Sum the heights of a run of rows.
 * @param {Array<{height: number}>} rows - Measured rows
 * @returns {number} Total height in millimetres
 */
export function totalRowHeight(rows) {
    return rows.reduce((sum, row) => sum + row.height, 0);
}

/**
 * A row that reserves height without drawing, so a card's chrome extends past
 * its last line of text.
 * @param {number} height - Height in millimetres
 * @returns {Row} Spacer row
 */
export function spacerRow(height) {
    return { height, draw: () => {} };
}

/**
 * Relative luminance of a palette color, per WCAG 2.
 * @param {Rgb} color - Palette color
 * @returns {number} Luminance between 0 and 1
 */
function relativeLuminance(color) {
    const channel = (value) => {
        const scaled = value / 255;
        return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/**
 * Contrast ratio between two palette colors, per WCAG 2.
 * @param {Rgb} left - First color
 * @param {Rgb} right - Second color
 * @returns {number} Ratio between 1 and 21
 */
export function contrastRatio(left, right) {
    const first = relativeLuminance(left);
    const second = relativeLuminance(right);
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/**
 * Pick whichever of the palette's two text colors reads on this fill.
 *
 * Text used to be colored by the name of the accent it sat on rather than by
 * what that produced: a card title in `--accent-yellow` on a tint of
 * `--accent-yellow` is 1.54:1, and the white roundel digit on the raw accent is
 * 1.71:1. Neither is visible on paper. Measuring instead keeps every one of them
 * legible whatever the tokens are later set to.
 * @param {Palette} palette - Palette from readPdfPalette()
 * @param {Rgb} background - Fill the text sits on
 * @returns {Rgb} The more readable text color
 */
export function readableOn(palette, background) {
    const ink = palette["--text-primary"];
    const reversed = palette["--text-on-accent"];
    return contrastRatio(ink, background) >= contrastRatio(reversed, background) ? ink : reversed;
}

/**
 * Blend two colors, standing in for the alpha the page cannot use.
 *
 * jsPDF fills are opaque, so a heatmap cell at a tenth intensity has to be
 * mixed against the paper here rather than drawn translucent over it. Clamping
 * leaves NaN as NaN, so an amount that is not a finite number blends to nothing
 * rather than reaching setFillColor() as three NaN channels.
 * @param {Rgb} from - Color at amount 0
 * @param {Rgb} to - Color at amount 1
 * @param {number} amount - Blend position, clamped to [0, 1]
 * @returns {Rgb} Blended color
 */
export function mixColors(from, to, amount) {
    const t = Number.isFinite(amount) ? Math.min(1, Math.max(0, amount)) : 0;
    const channel = (a, b) => Math.round(a + (b - a) * t);
    return { r: channel(from.r, to.r), g: channel(from.g, to.g), b: channel(from.b, to.b) };
}
