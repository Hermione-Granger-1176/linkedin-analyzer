/**
 * Vector chart blocks for the PDF export.
 *
 * The on-screen charts are canvas pixels, which is the one thing a printed page
 * must not be: a raster chart is fixed at the resolution it was captured at and
 * falls apart as soon as the reader zooms. The same series are re-plotted here
 * out of lines, rectangles and circles, so they stay sharp at any magnification.
 *
 * Every builder returns blocks in the shape `pdf-document.js` paginates:
 * measured rows that know how to draw themselves at a given corner. A plot
 * reserves its whole area as one tall row, so it is never sliced by a page
 * break; a bar or list is one row per entry and asks to be kept together, so it
 * moves whole rather than leaving a headless tail on the next page, and flows
 * row by row only once it is taller than a page can hold.
 */

import { DAY_LABELS } from "../analytics/constants.js";

import {
    BASELINE_RATIO,
    CONTENT_WIDTH,
    lineHeightMm,
    mixColors,
    spacerRow,
} from "./pdf-layout.js";

// Height of a line plot, and of a heatmap plot, in millimetres. Sized to be read
// at print size rather than to make a dashboard fit one page: a dashboard flows
// onto a second sheet like every other section, so there is nothing to buy by
// squeezing them. A line plot leaves 43mm between its axes, roughly a quarter of
// the 164mm it spans, which is enough for the dots of a year of months to
// separate; at 23mm a timeline read as a wavy line. A heatmap cell is 6.83mm
// wide whatever happens, being a full day divided by 24, and 5mm of height keeps
// it near enough square to read as a grid rather than as ribbons.
const PLOT_HEIGHT = 56;
const HEATMAP_HEIGHT = 44;

const TITLE_SIZE = 11;
const AXIS_SIZE = 6.5;
const LABEL_SIZE = 7.5;

const LINE_PADDING = Object.freeze({ top: 5, right: 3, bottom: 8, left: 11 });
const HEATMAP_PADDING = Object.freeze({ top: 3, right: 2, bottom: 6, left: 11 });

// Ink per chart type, matching the screens: the timeline and the heatmap are
// blue, topic bars purple. Fixed here rather than taken from a chart's config,
// so a dashboard cannot ask for a color the site never draws that chart in.
const LINE_ACCENT = "--accent-blue";
const BAR_ACCENT = "--accent-purple";
const HEATMAP_ACCENT = "--accent-blue";

// The steps a value axis is allowed to count in: a whole 1, 2 or 5 at some
// magnitude, which is what a reader adds up without doing arithmetic. AXIS_TICKS
// is the number of gaps a step is chosen against, not a promise: the step it
// lands on may divide the scale into one more than that, which is worth more
// than rounding the maximum up to keep the count exact.
const AXIS_TICKS = 4;
const AXIS_STEP_MULTIPLES = Object.freeze([1, 2, 5]);
// Past this many points the value labels above the dots collide, so they are
// dropped and the gridline scale carries the reading instead.
const MAX_VALUE_LABELS = 14;
// How far a value label sits above its dot, and how far the gridline is broken
// either side of it.
const VALUE_LABEL_GAP = 1.6;
const VALUE_LABEL_PAD = 0.8;
// Room for a whole label such as "Jan 2024", or the weekly "Jan 05", rather
// than for the first word of one: on paper there is no tooltip to recover the
// rest from.
const MIN_LABEL_SPACING = 16;

const ROW_HEIGHT = 6.4;
const BAR_HEIGHT = 4.2;
const BAR_LABEL_FRACTION = 0.38;
const BAR_VALUE_WIDTH = 10;
const BAR_MIN_WIDTH = 0.6;
const BAR_RADIUS = 0.5;
const LIST_VALUE_WIDTH = 24;
const LIST_TEXT_INSET = 2;
// Where a list row's text sits inside its row. The same drop as a bar's height,
// which is how the two kinds of row line up, but a list row draws no bar and
// naming it after one sent a reader looking for the chart it belonged to.
const LIST_TEXT_BASELINE = BAR_HEIGHT;
// A list row is two columns rather than two strings sharing one width: the
// primary takes the larger share, the secondary what is left over.
const LIST_PRIMARY_FRACTION = 0.55;
const LIST_COLUMN_GAP = 3;

const HOURS_PER_DAY = 24;
const HOUR_LABEL_STEP = 3;

/**
 * @typedef {import("./pdf-layout.js").Rgb} Rgb
 * @typedef {import("./pdf-layout.js").Row} Row
 * @typedef {{kind: string, rows: Row[], keepTogether?: boolean, keepWithNext?: boolean, spacingAfter?: number}} Block
 */

/**
 * Room to leave above the tallest value in a series.
 *
 * Mirrors the on-screen chart: without the headroom a flat or sparse series is
 * drawn as a block pinned to the top edge and stops reading as a chart.
 * @param {number} peak - Largest value in the series
 * @returns {number} Height the scale has to cover
 */
function axisClearance(peak) {
    if (peak <= 1) {
        return 2;
    }
    if (peak <= 4) {
        return peak + 1;
    }
    return Math.ceil(peak * 1.12);
}

/**
 * Round a step up to the next whole 1, 2 or 5 at its own magnitude.
 * @param {number} raw - Step the data would like
 * @returns {number} Step a reader can count in
 */
function niceStep(raw) {
    const magnitude = 10 ** Math.max(0, Math.floor(Math.log10(raw)));
    for (const multiple of AXIS_STEP_MULTIPLES) {
        const step = multiple * magnitude;
        if (step >= raw) {
            return step;
        }
    }
    return 10 * magnitude;
}

/**
 * Pick the gridline values a series is read against.
 *
 * The step is chosen first and the maximum follows from it, so every tick is a
 * round number and the topmost is still the maximum the plot scales by. Picking
 * a pleasant maximum first and dividing it instead is what printed scales of
 * 0/94/188/282/377 and 0/18/36/54/73, where only the two ends meant anything.
 * @param {number} peak - Largest value in the series
 * @returns {number[]} Gridline values, ascending, ending at the axis maximum
 */
export function axisScale(peak) {
    const clearance = axisClearance(peak);
    const step = niceStep(clearance / (AXIS_TICKS + 1));
    const ticks = Math.ceil(clearance / step);
    return Array.from({ length: ticks + 1 }, (_, index) => index * step);
}

/**
 * Choose which x-axis labels to draw so neighbours cannot overlap.
 *
 * Indices rather than labels: the caller still needs each point's own position
 * to place the text it keeps.
 * @param {number} count - Number of points
 * @param {number} width - Plot width in millimetres
 * @returns {Set<number>} Indices to label
 */
export function pickLabelIndices(count, width) {
    const kept = new Set();
    if (count <= 0) {
        return kept;
    }
    const affordable = Math.max(2, Math.floor(width / MIN_LABEL_SPACING));
    const every = Math.max(1, Math.ceil(count / affordable));
    for (let index = 0; index < count; index += every) {
        kept.add(index);
    }
    // The final point anchors where the series ends, so it is always labeled,
    // evicting the one before it when the step left the two too close to sit
    // side by side. Measured in millimetres, like the spacing every other pair
    // gets: over ten years of months the last two indices were six steps apart
    // and still only 8mm, which printed "Dec 2025" and "Jun 2026" over each
    // other as "Dec 202Jun 2026".
    const last = count - 1;
    if (!kept.has(last)) {
        const previous = last - (last % every);
        if (((last - previous) * width) / count < MIN_LABEL_SPACING) {
            kept.delete(previous);
        }
        kept.add(last);
    }
    return kept;
}

/**
 * Truncate a label to the width it has, marking it when it had to be cut.
 *
 * Cut at a character rather than at a word: wrapping breaks on spaces, so one
 * character over the line threw away every word after the first. On one list
 * "Bartholomewkonstantinos9 Vandenbroucke-Steenhuyse-Papadopoulos-Rajagopalachari"
 * printed whole while "Bartholomewkonstantinos13 …" printed as its first token
 * and 53mm of empty row, one digit apart.
 * @param {object} painter - Drawing helpers
 * @param {string|null|undefined} value - Raw label
 * @param {number} width - Available width in millimetres
 * @param {number} size - Font size in points
 * @returns {string} Label that fits
 */
function fitLabel(painter, value, width, size) {
    // A field the data never filled in is left blank rather than cut down to a
    // bare ellipsis standing for nothing.
    const text = value ?? "";
    const family = painter.fonts.body;
    if (painter.measure(text, family, size) <= width) {
        return text;
    }

    // Halved rather than walked back a character at a time: a company name or a
    // headline runs to hundreds of characters, and every probe measures a
    // string.
    let kept = 0;
    let limit = text.length;
    while (kept < limit) {
        const middle = Math.ceil((kept + limit) / 2);
        if (painter.measure(`${text.slice(0, middle)}…`, family, size) <= width) {
            kept = middle;
        } else {
            limit = middle - 1;
        }
    }
    return `${text.slice(0, kept).trimEnd()}…`;
}

/**
 * Build the heading block a chart is introduced by.
 * @param {object} painter - Drawing helpers
 * @param {string} title - Chart title
 * @returns {Block} Block
 */
function buildChartTitleBlock(painter, title) {
    const { palette, fonts } = painter;
    return {
        kind: "chart-title",
        keepTogether: true,
        keepWithNext: true,
        spacingAfter: 1.5,
        rows: [
            {
                height: lineHeightMm(TITLE_SIZE) + 2,
                draw: (x, y) => {
                    painter.text(
                        title,
                        x,
                        y + lineHeightMm(TITLE_SIZE) * BASELINE_RATIO,
                        fonts.accent,
                        TITLE_SIZE,
                        palette["--text-primary"],
                    );
                },
            },
        ],
    };
}

/**
 * The drawable rectangle a padded plot of the given height leaves.
 *
 * The padding is what the axis labels are drawn into, so the plot itself is
 * always the row inset by it. Stated once so a third plot type inherits the
 * convention rather than restating the arithmetic.
 * @param {{top: number, right: number, bottom: number, left: number}} padding - Room the axes need
 * @param {number} height - Full row height
 * @returns {{left: number, top: number, width: number, height: number}} Plot area
 */
function plotArea(padding, height) {
    return {
        left: padding.left,
        top: padding.top,
        width: CONTENT_WIDTH - padding.left - padding.right,
        height: height - padding.top - padding.bottom,
    };
}

/**
 * Draw the horizontal gridlines and the values they stand for.
 * @param {object} painter - Drawing helpers
 * @param {{left: number, top: number, width: number, height: number}} plot - Plot area
 * @param {number[]} values - Gridline values from axisScale()
 */
function drawValueAxis(painter, plot, values) {
    const { palette, fonts } = painter;
    const maxValue = values[values.length - 1];
    for (const value of values) {
        const y = plot.top + plot.height - (value / maxValue) * plot.height;
        painter.fillRect(plot.left, y, plot.width, 0.2, palette["--border-light"]);
        painter.text(
            String(value),
            plot.left - 1.5,
            y + 1,
            fonts.body,
            AXIS_SIZE,
            palette["--text-muted"],
            { align: "right" },
        );
    }
}

/**
 * Build a line chart: gridded axis, filled area and plotted points.
 * @param {object} painter - Drawing helpers
 * @param {{title: string, points: Array<{label: string, value: number}>}} config - Chart configuration
 * @returns {Block[]} Title block and plot block
 */
export function buildLineChartBlocks(painter, config) {
    const { palette, fonts } = painter;
    // A value that is not a finite number scales nothing: it poisons the axis
    // maximum, and from there every gridline, every dot and every label on the
    // plot, until jsPDF is handed NaN coordinates and refuses the whole export
    // rather than the one chart. Nothing sends one today, which is exactly the
    // case mixColors() already answers for a blend amount.
    const points = (Array.isArray(config.points) ? config.points : []).filter((point) =>
        Number.isFinite(point.value),
    );
    const accent = palette[LINE_ACCENT];
    const areaFill = mixColors(palette["--bg-primary"], accent, 0.18);

    const plot = plotArea(LINE_PADDING, PLOT_HEIGHT);
    const gridlines = axisScale(Math.max(1, ...points.map((point) => point.value)));
    const maxValue = gridlines[gridlines.length - 1];
    const slice = plot.width / points.length;
    const labeled = pickLabelIndices(points.length, plot.width);
    const showValues = points.length <= MAX_VALUE_LABELS;
    const valueLabelHeight = lineHeightMm(AXIS_SIZE);

    const plotRow = {
        height: PLOT_HEIGHT,
        draw: (x, y) => {
            const area = { ...plot, left: x + plot.left, top: y + plot.top };
            const baseline = area.top + area.height;

            const placed = points.map((point, index) => ({
                x: area.left + slice * index + slice / 2,
                y: baseline - (point.value / maxValue) * area.height,
                axisLabel: labeled.has(index) ? String(point.label) : "",
                valueLabel: showValues && point.value !== 0 ? String(point.value) : "",
            }));

            drawValueAxis(painter, area, gridlines);

            // The gridline is broken behind each value label rather than the
            // label moved off it: nudged clear of one rule a number only lands
            // nearer the next, and it has to stay over the dot it belongs to.
            // Knocked out before the area is filled, so a label that falls
            // inside the fill is covered by it instead of left in a white box.
            placed.forEach(({ x: pointX, y: pointY, valueLabel }) => {
                if (!valueLabel) {
                    return;
                }
                const width =
                    painter.measure(valueLabel, fonts.body, AXIS_SIZE) + VALUE_LABEL_PAD * 2;
                painter.fillRect(
                    pointX - width / 2,
                    pointY - VALUE_LABEL_GAP - valueLabelHeight * BASELINE_RATIO,
                    width,
                    valueLabelHeight,
                    palette["--bg-primary"],
                );
            });

            // One point has no span to fill or to connect along, and is left to
            // the dot below; two coordinates are the least a polygon or a
            // polyline can be built from.
            if (placed.length > 1) {
                const spine = placed.map(({ x: pointX, y: pointY }) => ({ x: pointX, y: pointY }));
                painter.polygon(
                    [
                        { x: placed[0].x, y: baseline },
                        ...spine,
                        { x: placed[placed.length - 1].x, y: baseline },
                    ],
                    areaFill,
                );
                painter.polyline(spine, accent, 0.5);
            }

            painter.fillRect(area.left, baseline, area.width, 0.3, palette["--border-color"]);

            placed.forEach(({ x: pointX, y: pointY, axisLabel, valueLabel }) => {
                painter.fillCircle(pointX, pointY, 0.7, accent);
                if (valueLabel) {
                    painter.text(
                        valueLabel,
                        pointX,
                        pointY - VALUE_LABEL_GAP,
                        fonts.body,
                        AXIS_SIZE,
                        palette["--text-secondary"],
                        { align: "center" },
                    );
                }
                if (axisLabel) {
                    // Whole label: a weekly point reads "Jan 05" and a growth
                    // point "Jan 2024", so a first word alone would repeat the
                    // month across the axis or drop the year entirely. Held
                    // inside the plot rather than centered come what may: the
                    // last point sits half a slice from the right edge, which
                    // over a decade of months is a third of a millimetre, and
                    // the label ran out over the margin.
                    const half = painter.measure(axisLabel, fonts.body, AXIS_SIZE) / 2;
                    const center = Math.min(
                        Math.max(pointX, area.left + half),
                        area.left + area.width - half,
                    );
                    painter.text(
                        axisLabel,
                        center,
                        baseline + 4,
                        fonts.body,
                        AXIS_SIZE,
                        palette["--text-muted"],
                        { align: "center" },
                    );
                }
            });
        },
    };

    return [
        buildChartTitleBlock(painter, config.title),
        { kind: "line-chart", keepTogether: true, spacingAfter: 5, rows: [plotRow] },
    ];
}

/**
 * Build a horizontal bar chart, one measured row per bar.
 * @param {object} painter - Drawing helpers
 * @param {{title: string, items: Array<{topic: string, count: number}>}} config - Chart configuration
 * @returns {Block[]} Title block and bar block
 */
export function buildBarChartBlocks(painter, config) {
    const { palette, fonts } = painter;
    // Counts are filtered the way a line chart's values are, and for the same
    // reason: one that is not a finite number makes every bar width NaN.
    const items = (Array.isArray(config.items) ? config.items : []).filter((item) =>
        Number.isFinite(item.count),
    );
    const accent = palette[BAR_ACCENT];
    const tint = mixColors(palette["--bg-primary"], accent, 0.55);

    const labelWidth = CONTENT_WIDTH * BAR_LABEL_FRACTION;
    const trackLeft = labelWidth + 2;
    const trackWidth = CONTENT_WIDTH - trackLeft - BAR_VALUE_WIDTH;
    const maxValue = Math.max(1, ...items.map((item) => item.count));

    const rows = items.map((item) => {
        const label = fitLabel(painter, item.topic, labelWidth, LABEL_SIZE);
        // A count that rounds to nothing still gets a visible stub, so a row is
        // never a label with blank paper beside it.
        const width = Math.max(BAR_MIN_WIDTH, (item.count / maxValue) * trackWidth);
        // A radius wider than half the bar it rounds is drawn as a lozenge that
        // overshoots its own track, which the stub width is narrow enough to hit.
        const radius = Math.min(BAR_RADIUS, width / 2);
        return {
            height: ROW_HEIGHT,
            draw: (x, y) => {
                painter.text(
                    label,
                    x + labelWidth,
                    y + BAR_HEIGHT - 0.6,
                    fonts.body,
                    LABEL_SIZE,
                    palette["--text-secondary"],
                    { align: "right" },
                );
                painter.fillRect(x + trackLeft, y, width, BAR_HEIGHT, tint, radius);
                painter.fillRect(x + trackLeft, y, 0.6, BAR_HEIGHT, accent, 0.3);
                painter.text(
                    String(item.count),
                    x + trackLeft + width + 1.5,
                    y + BAR_HEIGHT - 0.6,
                    fonts.body,
                    LABEL_SIZE,
                    palette["--text-muted"],
                );
            },
        };
    });
    rows.push(spacerRow(2));

    return [
        buildChartTitleBlock(painter, config.title),
        // Kept together while it fits a page: split, the tail arrives overleaf as
        // bars with no title and nothing to say what they count. A chart too tall
        // for any page still flows, which is the pagination contract.
        { kind: "bar-chart", keepTogether: true, spacingAfter: 4, rows },
    ];
}

/**
 * Build the day-by-hour activity heatmap.
 * @param {object} painter - Drawing helpers
 * @param {{title: string, grid: number[][]}} config - Chart configuration
 * @returns {Block[]} Title block and plot block
 */
export function buildHeatmapBlocks(painter, config) {
    const { palette, fonts } = painter;
    const grid = Array.isArray(config.grid) ? config.grid : [];
    const accent = palette[HEATMAP_ACCENT];
    const paper = palette["--bg-primary"];

    const plot = plotArea(HEATMAP_PADDING, HEATMAP_HEIGHT);
    const cellWidth = plot.width / HOURS_PER_DAY;
    const cellHeight = plot.height / DAY_LABELS.length;
    const maxValue = Math.max(1, ...grid.flat());

    const plotRow = {
        height: HEATMAP_HEIGHT,
        draw: (x, y) => {
            const left = x + plot.left;
            const top = y + plot.top;

            DAY_LABELS.forEach((dayLabel, day) => {
                const values = grid[day] || [];
                painter.text(
                    dayLabel,
                    left - 1.5,
                    top + day * cellHeight + cellHeight * 0.68,
                    fonts.body,
                    AXIS_SIZE,
                    palette["--text-muted"],
                    { align: "right" },
                );
                for (let hour = 0; hour < HOURS_PER_DAY; hour += 1) {
                    const value = values[hour] || 0;
                    // An empty cell still takes a whisper of ink, so the grid
                    // reads as a grid rather than as marks on blank paper.
                    const intensity = value ? 0.15 + 0.85 * (value / maxValue) : 0.05;
                    painter.fillRect(
                        left + hour * cellWidth,
                        top + day * cellHeight,
                        cellWidth,
                        cellHeight,
                        mixColors(paper, accent, intensity),
                    );
                }
            });

            for (let hour = 0; hour <= HOURS_PER_DAY; hour += 1) {
                painter.fillRect(
                    left + hour * cellWidth,
                    top,
                    0.15,
                    plot.height,
                    palette["--border-light"],
                );
            }
            for (let day = 0; day <= DAY_LABELS.length; day += 1) {
                painter.fillRect(
                    left,
                    top + day * cellHeight,
                    plot.width,
                    0.15,
                    palette["--border-light"],
                );
            }
            for (let hour = 0; hour < HOURS_PER_DAY; hour += HOUR_LABEL_STEP) {
                painter.text(
                    String(hour).padStart(2, "0"),
                    left + hour * cellWidth,
                    top + plot.height + 3.4,
                    fonts.body,
                    AXIS_SIZE,
                    palette["--text-muted"],
                );
            }
        },
    };

    return [
        buildChartTitleBlock(painter, config.title),
        { kind: "heatmap", keepTogether: true, spacingAfter: 5, rows: [plotRow] },
    ];
}

/**
 * Build a ranked list, used where the site shows one rather than a chart.
 * @param {object} painter - Drawing helpers
 * @param {{title: string, items: Array<{primary: string, secondary?: string, value?: string}>}} config - List configuration
 * @returns {Block[]} Title block and list block
 */
export function buildListBlocks(painter, config) {
    const { palette, fonts } = painter;
    const items = Array.isArray(config.items) ? config.items : [];
    const valueLeft = CONTENT_WIDTH - LIST_VALUE_WIDTH;

    // The two are drawn from opposite ends of one baseline, so fitting both to
    // the whole width let them overprint: "Wolfgang-Maximilian von
    // Habsburg-Lothringen de la Cruz PhD MBA" against "Head of People Operations
    // and Culture @ Globex Worldwide Holdings International" overlapped by 36mm.
    // A column each, with a gap between them, is what keeps them apart whatever
    // the data says.
    const textWidth = valueLeft - LIST_TEXT_INSET * 2;
    const primaryWidth = textWidth * LIST_PRIMARY_FRACTION;
    const secondaryWidth = textWidth - primaryWidth - LIST_COLUMN_GAP;

    const rows = items.map((item, index) => {
        const zebra = index % 2 === 0 ? palette["--bg-tertiary"] : palette["--bg-primary"];
        const primary = fitLabel(painter, item.primary, primaryWidth, LABEL_SIZE);
        const secondary = item.secondary
            ? fitLabel(painter, item.secondary, secondaryWidth, LABEL_SIZE - 1)
            : "";
        // Fitted for the same reason the two above are: drawn from the right
        // edge, a value wider than its column reaches back across the secondary
        // one.
        const value = item.value
            ? fitLabel(painter, item.value, LIST_VALUE_WIDTH - LIST_TEXT_INSET, LABEL_SIZE)
            : "";
        return {
            height: ROW_HEIGHT,
            draw: (x, y) => {
                painter.fillRect(x, y, CONTENT_WIDTH, ROW_HEIGHT, zebra, 0.4);
                painter.text(
                    primary,
                    x + LIST_TEXT_INSET,
                    y + LIST_TEXT_BASELINE,
                    fonts.body,
                    LABEL_SIZE,
                    palette["--text-primary"],
                );
                if (secondary) {
                    painter.text(
                        secondary,
                        x + valueLeft - LIST_TEXT_INSET,
                        y + LIST_TEXT_BASELINE,
                        fonts.body,
                        LABEL_SIZE - 1,
                        palette["--text-muted"],
                        { align: "right" },
                    );
                }
                if (value) {
                    painter.text(
                        value,
                        x + CONTENT_WIDTH - LIST_TEXT_INSET,
                        y + LIST_TEXT_BASELINE,
                        fonts.body,
                        LABEL_SIZE,
                        palette["--text-secondary"],
                        { align: "right" },
                    );
                }
            },
        };
    });
    rows.push(spacerRow(2));

    return [
        buildChartTitleBlock(painter, config.title),
        // Kept together on the same terms as a bar chart: a headless run of names
        // overleaf says nothing about what ranked them.
        { kind: "list", keepTogether: true, spacingAfter: 4, rows },
    ];
}
