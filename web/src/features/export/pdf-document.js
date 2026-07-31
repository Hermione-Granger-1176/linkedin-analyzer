/**
 * A4 layout engine for the PDF export.
 *
 * The document is not a screenshot: it is measured and drawn from scratch. Text
 * is wrapped into rows first, rows are grouped into blocks, and blocks are then
 * placed onto pages. A block that asks to be kept together never straddles a
 * page break unless it is taller than a page, in which case it flows row by row
 * so an unusually long message wraps rather than looping forever.
 *
 * Sections that mirror a screen of the site are dashboards. The first follows
 * the title on page one and every later one opens a page of its own, so a reader
 * leafing through the file finds the same divisions they navigate on screen.
 */

import {
    buildBarChartBlocks,
    buildHeatmapBlocks,
    buildLineChartBlocks,
    buildListBlocks,
} from "./pdf-charts.js";
import {
    BASELINE_RATIO,
    CONTENT_WIDTH,
    PAGE,
    USABLE_HEIGHT,
    lineHeightMm,
    readableOn,
    spacerRow,
    totalRowHeight,
} from "./pdf-layout.js";

const CARD_PADDING = 3.6;
const CARD_GUTTER = 8.5;
const RULE_WIDTH = 1.6;
const ROUNDEL_RADIUS = 2.3;
const CARD_RADIUS = 1.6;
const RULE_RADIUS = 0.6;

/** Width available to text inside a gutter-indented card, in millimetres. */
const CARD_TEXT_WIDTH = CONTENT_WIDTH - CARD_GUTTER - CARD_PADDING;

// Insight titles wrap short of the card edge so a long one does not crowd the
// rounded corner.
const TITLE_RIGHT_SLACK = 10;

const CHIP_WIDTH = 15;
const CHIP_HEIGHT = 4.6;
const CHIP_DATE_GAP = 2.5;
const MESSAGE_RULE_WIDTH = 0.9;
const MESSAGE_RULE_INSET = 1.5;
const MESSAGE_TAIL_PADDING = 2.6;

const STAT_COLUMNS = 2;
const STAT_GAP = 5;
const STAT_TILE_HEIGHT = 19;

// Tiles per row for a dashboard's stat grid, by how many tiles there are. A
// fixed three drew four stats as 3 + 1, leaving two thirds of the second row
// blank; each entry here divides its own count exactly, so every row a grid
// opens is a full one. Past six tiles the grid goes back to three a row.
const DASHBOARD_STAT_COLUMNS = Object.freeze([1, 2, 3, 2, 5, 3]);
const DEFAULT_DASHBOARD_STAT_COLUMNS = 3;

// Stat values that report an absence rather than a measurement. A dashboard
// with nothing but these and no chart data is not printed at all.
const BLANK_STAT_VALUES = Object.freeze(["", "0", "-"]);

// Headline size first, then the two steps down a long value is allowed to take
// before it is cut instead.
const STAT_VALUE_SIZES = Object.freeze([17, 13, 10]);

const MONTHS = Object.freeze([
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
]);

// Insight accents map onto the same tokens the cards use on screen.
const ACCENT_TOKENS = Object.freeze({
    "accent-yellow": "--accent-yellow",
    "accent-purple": "--accent-purple",
    "accent-blue": "--accent-blue",
    "accent-green": "--accent-green",
    "accent-red": "--accent-red",
});
const DEFAULT_ACCENT = "--accent-blue";

/**
 * @typedef {{r: number, g: number, b: number}} Rgb
 * @typedef {Readonly<Record<string, Rgb>>} Palette
 * @typedef {{height: number, draw: (x: number, y: number) => void}} Row
 * @typedef {{x: number, y: number}} Point
 * @typedef {{kind: string, rows: Row[], keepTogether?: boolean, keepWithNext?: boolean, pageBreakBefore?: boolean, spacingAfter?: number, continuation?: string, drawChrome?: (x: number, y: number, height: number) => void}} Block
 * @typedef {{block: Block, rows: Row[], y: number}} Segment
 * @typedef {{palette: Palette, fonts: {body: string, accent: string}, wrap: (text: string, width: number, family: string, size: number) => string[], measure: (text: string, family: string, size: number) => number, text: (value: string, x: number, baseline: number, family: string, size: number, color: Rgb, options?: object) => void, fillRect: (x: number, y: number, width: number, height: number, color: Rgb, radius?: number) => void, fillCircle: (x: number, y: number, radius: number, color: Rgb) => void, polygon: (points: Point[], color: Rgb) => void, polyline: (points: Point[], color: Rgb, width: number) => void}} Painter
 * @typedef {{label: string, value: string}} Stat
 * @typedef {{title: string, subtitle?: string, stats: Stat[], charts: object[]}} Dashboard
 * @typedef {{generatedAt: Date, rangeLabel: string, dashboards: Dashboard[], insights: object[], tip: string|null, allTime: Stat[], threads: object[]}} DocumentModel
 */

/**
 * Format a date the way the header and message stamps read it.
 * @param {Date|number} value - Date or epoch milliseconds
 * @returns {string} Day, month name and year
 */
export function formatLongDate(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        return "";
    }
    return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/**
 * Room the next block that has any rows actually needs on this page.
 *
 * A block that moves whole needs all of it: reserving one row of a
 * `keepTogether` block reserves nothing, since the block cannot start in the
 * space that row was granted. A 6.4mm reservation against a 66mm list is how
 * "Fading conversations" came to sit alone at the foot of a page with its ten
 * rows overleaf. A block that flows row by row still only needs its first row,
 * because that is all of it that has to share the page.
 * @param {Block[]} blocks - Blocks in document order
 * @param {number} from - Index to start looking from
 * @param {number} usableHeight - Height available on one page
 * @returns {number} Height to reserve, or zero when nothing follows
 */
function leadingRequirement(blocks, from, usableHeight) {
    for (let index = from; index < blocks.length; index += 1) {
        const next = blocks[index];
        if (!next.rows.length) {
            continue;
        }
        const height = totalRowHeight(next.rows);
        return next.keepTogether && height <= usableHeight ? height : next.rows[0].height;
    }
    return 0;
}

/**
 * Place measured blocks onto pages.
 *
 * Pure: it only reads row heights, so it can be exercised without a document.
 * A `keepTogether` block that fits within a page moves to the next page rather
 * than splitting; anything taller flows row by row. Every placed row ends inside
 * the usable area: a row that could not is dropped rather than drawn past it.
 *
 * A block that is both `keepTogether` and `keepWithNext` additionally reserves
 * the room whatever follows it needs to start here: all of a block that moves
 * whole, the first row of one that flows. On the row-by-row path the flag does
 * not apply. A heading is only a heading if something comes after it on the same
 * page; without this, "All time", a person's name and every chart title were
 * routinely left alone at the foot of a page with their content overleaf.
 *
 * `pageBreakBefore` opens a dashboard on fresh paper. It is honoured only once
 * the page has something on it, so a run of empty sections cannot leave blank
 * sheets behind.
 * @param {Block[]} blocks - Blocks in document order
 * @param {number} usableHeight - Height available on one page
 * @returns {Segment[][]} Placed segments per page
 */
export function paginateBlocks(blocks, usableHeight) {
    const pages = [];
    let page = [];
    let cursor = 0;

    const nextPage = () => {
        pages.push(page);
        page = [];
        cursor = 0;
    };

    for (const [index, block] of blocks.entries()) {
        if (!block.rows.length) {
            continue;
        }

        if (block.pageBreakBefore && page.length) {
            nextPage();
        }

        const spacingAfter = block.spacingAfter || 0;
        const height = totalRowHeight(block.rows);

        if (block.keepTogether && height <= usableHeight) {
            let required = height;
            if (block.keepWithNext) {
                // Falls back to the block's own height when the pair cannot
                // share a page at all, so an unsatisfiable request cannot loop
                // pages.
                const withNext =
                    height + spacingAfter + leadingRequirement(blocks, index + 1, usableHeight);
                if (withNext <= usableHeight) {
                    required = withNext;
                }
            }
            if (cursor > 0 && cursor + required > usableHeight) {
                nextPage();
            }
            page.push({ block, rows: block.rows, y: cursor });
            cursor += height + spacingAfter;
            continue;
        }

        let pending = [];
        let start = cursor;
        for (const row of block.rows) {
            // A row is one indivisible drawing unit, so a row taller than the
            // whole content area cannot be placed without painting through the
            // footer and off the sheet. No row builder produces one - every row
            // is line-height based - but dropping it keeps "nothing outside the
            // margins" true rather than merely likely.
            if (row.height > usableHeight) {
                continue;
            }
            if (cursor > 0 && cursor + row.height > usableHeight) {
                if (pending.length) {
                    page.push({ block, rows: pending, y: start });
                    pending = [];
                }
                nextPage();
                start = 0;
            }
            pending.push(row);
            cursor += row.height;
        }
        if (pending.length) {
            page.push({ block, rows: pending, y: start });
        }
        cursor += spacingAfter;
    }

    if (page.length) {
        pages.push(page);
    }
    return pages;
}

/**
 * Build the drawing context the row painters close over.
 * @param {object} doc - jsPDF document
 * @param {Palette} palette - Palette from readPdfPalette()
 * @param {{body: string, accent: string}} fonts - Registered font families
 * @returns {Painter} Drawing helpers
 */
export function createPainter(doc, palette, fonts) {
    /**
     * Select a family, style and size.
     * @param {string} family - Registered family name
     * @param {number} size - Font size in points
     */
    const useFont = (family, size) => {
        doc.setFont(family, "normal");
        doc.setFontSize(size);
    };

    /**
     * Wrap text to the given width at the given font size.
     * @param {string} text - Raw text
     * @param {number} width - Available width in millimetres
     * @param {string} family - Registered family name
     * @param {number} size - Font size in points
     * @returns {string[]} Wrapped lines
     */
    const wrap = (text, width, family, size) => {
        useFont(family, size);
        const lines = doc.splitTextToSize(String(text || ""), width);
        return lines.length ? lines : [""];
    };

    /**
     * Measure one line of text.
     *
     * Wrapping answers "how many lines", which is the wrong question for a
     * label that has to be cut to a width or kept inside a plot: both need the
     * width of the string itself, and a wrap point is a word boundary rather
     * than the place the room ran out.
     * @param {string} text - Line text
     * @param {string} family - Registered family name
     * @param {number} size - Font size in points
     * @returns {number} Width in millimetres
     */
    const measure = (text, family, size) => {
        useFont(family, size);
        return doc.getTextWidth(String(text || ""));
    };

    /**
     * Draw one line of text.
     * @param {string} value - Line text
     * @param {number} x - Left edge in millimetres
     * @param {number} baseline - Baseline in millimetres
     * @param {string} family - Registered family name
     * @param {number} size - Font size in points
     * @param {Rgb} color - Text color
     * @param {object} [options] - jsPDF text options
     */
    const drawText = (value, x, baseline, family, size, color, options) => {
        useFont(family, size);
        doc.setTextColor(color.r, color.g, color.b);
        doc.text(value, x, baseline, options);
    };

    /**
     * Fill a rectangle, optionally rounded.
     * @param {number} x - Left edge
     * @param {number} y - Top edge
     * @param {number} width - Width
     * @param {number} height - Height
     * @param {Rgb} color - Fill color
     * @param {number} [radius] - Corner radius
     */
    const fillRect = (x, y, width, height, color, radius = 0) => {
        doc.setFillColor(color.r, color.g, color.b);
        if (radius > 0) {
            doc.roundedRect(x, y, width, height, radius, radius, "F");
            return;
        }
        doc.rect(x, y, width, height, "F");
    };

    /**
     * Fill a circle.
     * @param {number} x - Centre x
     * @param {number} y - Centre y
     * @param {number} radius - Radius
     * @param {Rgb} color - Fill color
     */
    const fillCircle = (x, y, radius, color) => {
        doc.setFillColor(color.r, color.g, color.b);
        doc.circle(x, y, radius, "F");
    };

    /**
     * Turn absolute points into the relative steps jsPDF paths are built from.
     * @param {Point[]} points - Path vertices
     * @returns {number[][]} Deltas from each vertex to the next
     */
    const toDeltas = (points) =>
        points
            .slice(1)
            .map((point, index) => [point.x - points[index].x, point.y - points[index].y]);

    /**
     * Fill a closed path, used for a chart's area under its line.
     * @param {Point[]} points - Path vertices
     * @param {Rgb} color - Fill color
     */
    const polygon = (points, color) => {
        doc.setFillColor(color.r, color.g, color.b);
        doc.lines(toDeltas(points), points[0].x, points[0].y, [1, 1], "F", true);
    };

    /**
     * Stroke an open path, used for a chart's plotted line.
     * @param {Point[]} points - Path vertices
     * @param {Rgb} color - Stroke color
     * @param {number} width - Stroke width in millimetres
     */
    const polyline = (points, color, width) => {
        doc.setDrawColor(color.r, color.g, color.b);
        doc.setLineWidth(width);
        doc.lines(toDeltas(points), points[0].x, points[0].y, [1, 1], "S", false);
    };

    return {
        palette,
        fonts,
        wrap,
        measure,
        text: drawText,
        fillRect,
        fillCircle,
        polygon,
        polyline,
    };
}

/**
 * Resolve an insight's accent to a palette color.
 * @param {Palette} palette - Palette from readPdfPalette()
 * @param {string} accent - Accent class from the insight
 * @param {string} [suffix] - Token suffix, such as "-bg"
 * @returns {Rgb} Accent color
 */
function accentColor(palette, accent, suffix = "") {
    const token = ACCENT_TOKENS[accent] || DEFAULT_ACCENT;
    return palette[`${token}${suffix}`] || palette[token];
}

/**
 * Build one row per wrapped line of secondary body text.
 * @param {Painter} painter - Drawing helpers
 * @param {string[]} lines - Wrapped lines
 * @param {number} size - Font size in points
 * @param {number} [leadIn] - Extra height reserved above the first line
 * @returns {Row[]} Measured rows
 */
function bodyRows(painter, lines, size, leadIn = 0) {
    const { palette, fonts } = painter;
    return lines.map((line, index) => {
        const top = index === 0 ? leadIn : 0;
        return {
            height: lineHeightMm(size) + top,
            draw: (x, y) => {
                painter.text(
                    line,
                    x + CARD_GUTTER,
                    y + top + lineHeightMm(size) * BASELINE_RATIO,
                    fonts.body,
                    size,
                    palette["--text-secondary"],
                );
            },
        };
    });
}

/**
 * Build the chrome painter a tinted card with an accent rule uses.
 * @param {Painter} painter - Drawing helpers
 * @param {Rgb} tint - Card fill
 * @param {Rgb} rule - Left rule color
 * @returns {(x: number, y: number, height: number) => void} Chrome painter
 */
function cardChrome(painter, tint, rule) {
    return (x, y, height) => {
        painter.fillRect(x, y, CONTENT_WIDTH, height, tint, CARD_RADIUS);
        painter.fillRect(x, y, RULE_WIDTH, height, rule, RULE_RADIUS);
    };
}

/**
 * Build the title block.
 * @param {Painter} painter - Drawing helpers
 * @param {DocumentModel} data - Document model
 * @returns {Block} Block
 */
function buildHeaderBlock(painter, data) {
    const { palette, fonts } = painter;
    const titleSize = 26;
    const metaSize = 10.5;
    const rows = [
        {
            height: lineHeightMm(titleSize) + 2,
            draw: (x, y) => {
                painter.text(
                    "LinkedIn Insights",
                    x,
                    y + lineHeightMm(titleSize) * BASELINE_RATIO,
                    fonts.accent,
                    titleSize,
                    palette["--text-primary"],
                );
            },
        },
        {
            height: lineHeightMm(metaSize) + 3.5,
            draw: (x, y) => {
                painter.text(
                    `${data.rangeLabel}  ·  Generated ${formatLongDate(data.generatedAt)}`,
                    x,
                    y + lineHeightMm(metaSize) * BASELINE_RATIO,
                    fonts.body,
                    metaSize,
                    palette["--text-secondary"],
                );
                painter.fillRect(
                    x,
                    y + lineHeightMm(metaSize) + 1.6,
                    CONTENT_WIDTH,
                    0.5,
                    palette["--border-light"],
                );
            },
        },
    ];

    return { kind: "header", keepTogether: true, spacingAfter: 6, rows };
}

/**
 * Build a section heading block.
 * @param {Painter} painter - Drawing helpers
 * @param {string} label - Heading text
 * @param {{pageBreakBefore?: boolean, subtitle?: string}} [options] - Placement and caption
 * @returns {Block} Block
 */
function buildSectionBlock(painter, label, options = {}) {
    const { palette, fonts } = painter;
    const size = 15;
    const captionSize = 9;

    const rows = [
        {
            height: lineHeightMm(size) + 3,
            draw: (x, y) => {
                painter.text(
                    label,
                    x,
                    y + lineHeightMm(size) * BASELINE_RATIO,
                    fonts.accent,
                    size,
                    palette["--text-primary"],
                );
                painter.fillRect(x, y + lineHeightMm(size) + 1, 22, 0.9, palette["--accent-yellow"]);
            },
        },
    ];

    const subtitle = options.subtitle || "";
    if (subtitle) {
        rows.push({
            height: lineHeightMm(captionSize) + 1.5,
            draw: (x, y) => {
                painter.text(
                    subtitle,
                    x,
                    y + lineHeightMm(captionSize) * BASELINE_RATIO,
                    fonts.body,
                    captionSize,
                    palette["--text-muted"],
                );
            },
        });
    }

    return {
        kind: "section",
        keepTogether: true,
        keepWithNext: true,
        pageBreakBefore: Boolean(options.pageBreakBefore),
        spacingAfter: 3,
        rows,
    };
}

/**
 * Build one insight card block.
 * @param {Painter} painter - Drawing helpers
 * @param {object} insight - Insight from the analytics worker
 * @param {number} index - One-based card number shown in the roundel
 * @returns {Block} Block
 */
function buildInsightBlock(painter, insight, index) {
    const { palette, fonts } = painter;
    const titleSize = 12.5;
    const bodySize = 10;
    const accent = accentColor(palette, insight.accent);
    const tint = accentColor(palette, insight.accent, "-bg");

    const titleLines = painter.wrap(
        insight.title,
        CARD_TEXT_WIDTH - TITLE_RIGHT_SLACK,
        fonts.body,
        titleSize,
    );
    const bodyLines = painter.wrap(insight.body, CARD_TEXT_WIDTH, fonts.body, bodySize);

    const rows = titleLines.map((line, lineIndex) => {
        const top = lineIndex === 0 ? CARD_PADDING : 0;
        return {
            height: lineHeightMm(titleSize) + top,
            draw: (x, y) => {
                if (lineIndex === 0) {
                    const roundelX = x + CARD_GUTTER - ROUNDEL_RADIUS - 1.4;
                    const roundelY = y + CARD_PADDING + ROUNDEL_RADIUS + 0.4;
                    painter.fillCircle(roundelX, roundelY, ROUNDEL_RADIUS, accent);
                    painter.text(
                        String(index),
                        roundelX,
                        roundelY + 1.2,
                        fonts.body,
                        7,
                        readableOn(palette, accent),
                        { align: "center" },
                    );
                }
                // The accent stays the card's rule and roundel, exactly as the
                // Insights screen uses it for the border and icon; the heading is
                // measured against the tint rather than taking the accent, which
                // on this palette lands on `--text-primary` just as it does on
                // screen.
                painter.text(
                    line,
                    x + CARD_GUTTER,
                    y + top + lineHeightMm(titleSize) * BASELINE_RATIO,
                    fonts.body,
                    titleSize,
                    readableOn(palette, tint),
                );
            },
        };
    });
    rows.push(...bodyRows(painter, bodyLines, bodySize, 1));
    rows.push(spacerRow(CARD_PADDING));

    return {
        kind: "insight",
        keepTogether: true,
        spacingAfter: 3.5,
        rows,
        drawChrome: cardChrome(painter, tint, accent),
    };
}

/**
 * Build the closing pro-tip panel.
 * @param {Painter} painter - Drawing helpers
 * @param {string} tip - Tip text
 * @returns {Block} Block
 */
function buildTipBlock(painter, tip) {
    const { palette, fonts } = painter;
    const labelSize = 11;
    const bodySize = 10.5;
    const lines = painter.wrap(tip, CARD_TEXT_WIDTH, fonts.body, bodySize);

    const rows = [
        {
            height: lineHeightMm(labelSize) + CARD_PADDING,
            draw: (x, y) => {
                painter.text(
                    "Pro tip",
                    x + CARD_GUTTER,
                    y + CARD_PADDING + lineHeightMm(labelSize) * BASELINE_RATIO,
                    fonts.accent,
                    labelSize,
                    palette["--text-primary"],
                );
            },
        },
    ];
    rows.push(...bodyRows(painter, lines, bodySize));
    rows.push(spacerRow(CARD_PADDING));

    return {
        kind: "tip",
        keepTogether: true,
        spacingAfter: 7,
        rows,
        drawChrome: cardChrome(painter, palette["--accent-yellow-bg"], palette["--accent-yellow"]),
    };
}

/**
 * Fit a stat's value to its tile, stepping the size down before truncating.
 *
 * All-time values are short numbers, but a dashboard tile carries whatever the
 * data says: "Top company" is a company name, and at the headline size a long
 * one ran off the tile and across its neighbour.
 * @param {Painter} painter - Drawing helpers
 * @param {string|null|undefined} value - Stat value
 * @param {number} width - Width available inside the tile
 * @returns {{text: string, size: number}} Text to draw and the size to draw it at
 */
function fitStatValue(painter, value, width) {
    // A tile whose value never arrived is left blank rather than cut down to an
    // ellipsis standing for nothing.
    const text = value ?? "";
    for (const size of STAT_VALUE_SIZES) {
        const [first, ...rest] = painter.wrap(text, width, painter.fonts.accent, size);
        if (!rest.length) {
            return { text: first, size };
        }
    }
    const smallest = STAT_VALUE_SIZES[STAT_VALUE_SIZES.length - 1];
    const [first] = painter.wrap(text, width, painter.fonts.accent, smallest);
    return { text: `${String(first).trimEnd()}…`, size: smallest };
}

/**
 * Choose how many tiles a dashboard's stat grid puts on a row.
 * @param {number} count - Number of stats
 * @returns {number} Tiles per row
 */
function dashboardStatColumns(count) {
    return DASHBOARD_STAT_COLUMNS[count - 1] ?? DEFAULT_DASHBOARD_STAT_COLUMNS;
}

/**
 * Build a grid of stat tiles, the shape the site's stat bars take on paper.
 * @param {Painter} painter - Drawing helpers
 * @param {Array<{label: string, value: string}>} stats - Stats in display order
 * @param {number} [columns] - Tiles per row
 * @returns {Block} Block
 */
function buildStatsBlock(painter, stats, columns = STAT_COLUMNS) {
    const { palette, fonts } = painter;
    const tileWidth = (CONTENT_WIDTH - STAT_GAP * (columns - 1)) / columns;
    const valueWidth = tileWidth - CARD_GUTTER - CARD_PADDING;
    const rows = [];

    for (let index = 0; index < stats.length; index += columns) {
        const tiles = stats.slice(index, index + columns).map((stat) => ({
            ...stat,
            fitted: fitStatValue(painter, stat.value, valueWidth),
        }));
        rows.push({
            height: STAT_TILE_HEIGHT + STAT_GAP,
            draw: (x, y) => {
                tiles.forEach((stat, column) => {
                    const tileX = x + column * (tileWidth + STAT_GAP);
                    painter.fillRect(
                        tileX,
                        y,
                        tileWidth,
                        STAT_TILE_HEIGHT,
                        palette["--bg-tertiary"],
                        2,
                    );
                    painter.fillRect(
                        tileX,
                        y,
                        RULE_WIDTH,
                        STAT_TILE_HEIGHT,
                        palette["--accent-blue"],
                        RULE_RADIUS,
                    );
                    painter.text(
                        stat.label,
                        tileX + CARD_GUTTER,
                        y + 6.4,
                        fonts.body,
                        9,
                        palette["--text-muted"],
                    );
                    painter.text(
                        stat.fitted.text,
                        tileX + CARD_GUTTER,
                        y + 14.6,
                        fonts.accent,
                        stat.fitted.size,
                        palette["--text-primary"],
                    );
                });
            },
        });
    }

    return { kind: "stats", keepTogether: true, spacingAfter: 4, rows };
}

/**
 * Build the header for one person's thread.
 * @param {Painter} painter - Drawing helpers
 * @param {object} thread - Selected thread
 * @returns {Block} Block
 */
function buildThreadHeaderBlock(painter, thread) {
    const { palette, fonts } = painter;
    const nameSize = 12.5;
    const metaSize = 8.5;
    const plural = thread.messageCount === 1 ? "message" : "messages";
    // A long name, a group thread listing several people, or the profile-URL
    // fallback all overrun the right margin if they are drawn unmeasured.
    const nameLines = painter.wrap(thread.name, CONTENT_WIDTH, fonts.body, nameSize);

    const rows = nameLines.map((line, index) => ({
        height: lineHeightMm(nameSize) + (index === 0 ? 2 : 0),
        draw: (x, y) => {
            painter.text(
                line,
                x,
                y + (index === 0 ? 2 : 0) + lineHeightMm(nameSize) * 0.72,
                fonts.body,
                nameSize,
                palette["--text-primary"],
            );
        },
    }));

    rows.push({
        height: lineHeightMm(metaSize) + 1.5,
        draw: (x, y) => {
            painter.text(
                `${thread.messageCount} ${plural}  ·  last on ${formatLongDate(thread.lastTimestamp)}`,
                x,
                y + lineHeightMm(metaSize) * BASELINE_RATIO,
                fonts.body,
                metaSize,
                palette["--text-muted"],
            );
        },
    });

    return {
        kind: "thread-header",
        keepTogether: true,
        keepWithNext: true,
        spacingAfter: 1.5,
        rows,
    };
}

/**
 * Resolve the chip a message's direction is drawn with.
 *
 * A one-conversation export gives the selector no way to tell the account owner
 * from the other person, and it says so rather than guessing; a neutral chip is
 * how that reads on the page.
 * @param {Palette} palette - Palette from readPdfPalette()
 * @param {'sent'|'received'|'unknown'} direction - Message direction
 * @returns {{rule: Rgb, fill: Rgb, label: string}} Chip styling
 */
function messageChip(palette, direction) {
    if (direction === "sent") {
        return {
            rule: palette["--accent-blue"],
            fill: palette["--accent-blue-bg"],
            label: "Sent",
        };
    }
    if (direction === "received") {
        return {
            rule: palette["--accent-green"],
            fill: palette["--accent-green-bg"],
            label: "Received",
        };
    }
    return {
        rule: palette["--text-muted"],
        fill: palette["--bg-tertiary"],
        label: "Message",
    };
}

/**
 * Build one message block, chip and all.
 * @param {Painter} painter - Drawing helpers
 * @param {{direction: 'sent'|'received'|'unknown', timestamp: number, body: string}} message - Message
 * @returns {Block} Block
 */
function buildMessageBlock(painter, message) {
    const { palette, fonts } = painter;
    const metaSize = 8;
    const bodySize = 9.5;
    const { rule, fill, label } = messageChip(palette, message.direction);

    const lines = painter.wrap(message.body, CARD_TEXT_WIDTH, fonts.body, bodySize);
    const rows = [
        {
            height: lineHeightMm(metaSize) + 3.2,
            draw: (x, y) => {
                painter.fillRect(
                    x + CARD_GUTTER,
                    y + 1,
                    CHIP_WIDTH,
                    CHIP_HEIGHT,
                    fill,
                    CHIP_HEIGHT / 2,
                );
                painter.text(
                    label,
                    x + CARD_GUTTER + CHIP_WIDTH / 2,
                    y + 4.3,
                    fonts.body,
                    metaSize - 0.5,
                    readableOn(palette, fill),
                    { align: "center" },
                );
                painter.text(
                    formatLongDate(message.timestamp),
                    x + CARD_GUTTER + CHIP_WIDTH + CHIP_DATE_GAP,
                    y + 4.3,
                    fonts.body,
                    metaSize,
                    palette["--text-muted"],
                );
            },
        },
    ];
    rows.push(...bodyRows(painter, lines, bodySize));
    rows.push(spacerRow(MESSAGE_TAIL_PADDING));

    return {
        kind: "message",
        keepTogether: true,
        spacingAfter: 1.2,
        rows,
        drawChrome: (x, y, height) => {
            painter.fillRect(x + MESSAGE_RULE_INSET, y, MESSAGE_RULE_WIDTH, height, rule, 0.45);
        },
    };
}

/**
 * Build the placeholder shown when there is nothing to report.
 * @param {Painter} painter - Drawing helpers
 * @returns {Block} Block
 */
function buildEmptyBlock(painter) {
    const { palette, fonts } = painter;
    const size = 11;

    return {
        kind: "empty",
        keepTogether: true,
        spacingAfter: 0,
        rows: [
            {
                height: lineHeightMm(size) + 4,
                draw: (x, y) => {
                    painter.text(
                        "No insights yet. Upload your LinkedIn export to fill this in.",
                        x,
                        y + 4 + lineHeightMm(size) * BASELINE_RATIO,
                        fonts.body,
                        size,
                        palette["--text-secondary"],
                    );
                },
            },
        ],
    };
}

/**
 * The chart builders a dashboard may name, keyed by the `type` it asks for.
 *
 * Data collection decides what a dashboard contains and the layout engine
 * decides how it is drawn, so a new chart on a screen becomes one more entry in
 * a dashboard's `charts` array rather than another branch down here.
 */
const CHART_BUILDERS = Object.freeze({
    line: buildLineChartBlocks,
    bar: buildBarChartBlocks,
    heatmap: buildHeatmapBlocks,
    list: buildListBlocks,
});

/**
 * Report whether a chart has anything to plot.
 *
 * A chart with no data is dropped rather than drawn as empty axes: on screen an
 * empty chart is a placeholder inviting an upload, and on a page the reader has
 * already exported there is nothing to invite.
 *
 * A heatmap is measured by its cells rather than by its rows: the analytics
 * worker always hands over a full week of hours, so a length test would call a
 * week with no activity in it data.
 * @param {object} chart - Chart configuration from the document model
 * @returns {boolean} True when the chart carries data
 */
function hasChartData(chart) {
    if (Array.isArray(chart.grid)) {
        return chart.grid.flat().some((value) => value > 0);
    }
    const series = chart.points || chart.items;
    return Array.isArray(series) && series.length > 0;
}

/**
 * Report whether a stat measured anything.
 *
 * A dashboard that found nothing still fills its tiles, with zeroes or with a
 * dash, so the count of stats says nothing about whether there is anything to
 * print.
 * @param {Stat} stat - Stat from a dashboard
 * @returns {boolean} True when the value reports something
 */
function hasStatValue(stat) {
    return !BLANK_STAT_VALUES.includes(String(stat.value ?? "").trim());
}

/**
 * Build one dashboard: its heading, its stat tiles and its charts.
 *
 * Emptiness is decided here rather than by whoever collected the data, so every
 * dashboard answers to the same rule: no chart with data and no stat with a
 * value is nothing to print, and the section does not appear. Without it the
 * messages dashboard printed a page of zeroes.
 * @param {Painter} painter - Drawing helpers
 * @param {Dashboard} dashboard - Dashboard from the document model
 * @param {boolean} pageBreakBefore - Whether it opens on a fresh page
 * @returns {Block[]} Blocks in document order, empty when there is nothing to show
 */
function buildDashboardBlocks(painter, dashboard, pageBreakBefore) {
    const stats = Array.isArray(dashboard.stats) ? dashboard.stats : [];
    const charts = (Array.isArray(dashboard.charts) ? dashboard.charts : []).filter(hasChartData);
    if (!charts.length && !stats.some(hasStatValue)) {
        return [];
    }

    const heading = buildSectionBlock(painter, dashboard.title, {
        pageBreakBefore,
        subtitle: dashboard.subtitle,
    });
    const body = [];
    if (stats.length) {
        body.push(buildStatsBlock(painter, stats, dashboardStatColumns(stats.length)));
    }
    for (const chart of charts) {
        const build = CHART_BUILDERS[chart.type];
        // A type no builder answers to is skipped: the rest of the export is
        // worth more to the reader than the one chart nobody knows how to draw.
        if (build) {
            body.push(...build(painter, chart));
        }
    }

    // Everything below the heading says what a page opening on it should be
    // called, so a dashboard long enough to run over is not read as charts under
    // no title at all. Carried on the blocks rather than inserted as one:
    // paginateBlocks stays a pure function of row heights, and the page painter
    // is the only thing that knows where a page began.
    const continuation = `${dashboard.title} (continued)`;
    return [heading, ...body.map((block) => ({ ...block, continuation }))];
}

/**
 * Turn the document model into measured blocks.
 * @param {Painter} painter - Drawing helpers
 * @param {DocumentModel} data - Document model from collectExportData()
 * @returns {Block[]} Blocks in document order
 */
export function buildBlocks(painter, data) {
    const insights = Array.isArray(data.insights) ? data.insights : [];
    const allTime = Array.isArray(data.allTime) ? data.allTime : [];
    const threads = Array.isArray(data.threads) ? data.threads : [];
    const dashboards = Array.isArray(data.dashboards) ? data.dashboards : [];

    const blocks = [buildHeaderBlock(painter, data)];

    // The first dashboard follows the title on page one; every later one opens
    // on its own page, the way each of these is its own screen on the site.
    // Counted by the dashboards that had something to show rather than by
    // position, so one that turned out to be empty does not leave the title
    // alone on a page of its own.
    let placed = 0;
    for (const dashboard of dashboards) {
        const dashboardBlocks = buildDashboardBlocks(painter, dashboard, placed > 0);
        if (dashboardBlocks.length) {
            blocks.push(...dashboardBlocks);
            placed += 1;
        }
    }

    if (insights.length) {
        blocks.push(buildSectionBlock(painter, "Your insights", { pageBreakBefore: true }));
        blocks.push(
            ...insights.map((insight, index) => buildInsightBlock(painter, insight, index + 1)),
        );
    }
    if (data.tip) {
        blocks.push(buildTipBlock(painter, data.tip));
    }
    if (allTime.length) {
        blocks.push(buildSectionBlock(painter, "All time"), buildStatsBlock(painter, allTime));
    }
    if (threads.length) {
        blocks.push(buildSectionBlock(painter, "Recent conversations", { pageBreakBefore: true }));
        for (const thread of threads) {
            blocks.push(buildThreadHeaderBlock(painter, thread));
            blocks.push(
                ...(thread.messages || []).map((message) => buildMessageBlock(painter, message)),
            );
        }
    }
    // Only the header: none of the sections above found anything to say.
    if (blocks.length === 1) {
        blocks.push(buildEmptyBlock(painter));
    }

    return blocks;
}

/**
 * Draw the running head a page that opens mid-dashboard carries.
 *
 * Page chrome rather than a block, drawn into the top margin the way the footer
 * is drawn into the bottom one. A block would have to be placed, and pagination
 * cannot place it: which pages open mid-dashboard is only known once the placing
 * is done. Smaller and quieter than the dashboard's own heading, so the page it
 * continues stays the one that announced the section.
 * @param {Painter} painter - Drawing helpers
 * @param {string} label - Continuation text
 */
function drawRunningHead(painter, label) {
    const { palette, fonts } = painter;
    const size = 10;
    const baseline = PAGE.marginTop - 6;

    painter.text(label, PAGE.marginX, baseline, fonts.accent, size, palette["--text-muted"]);
    painter.fillRect(PAGE.marginX, baseline + 2.4, CONTENT_WIDTH, 0.4, palette["--border-light"]);
}

/**
 * Draw the page footer.
 * @param {Painter} painter - Drawing helpers
 * @param {number} pageNumber - One-based page number
 * @param {number} pageCount - Total pages
 */
function drawFooter(painter, pageNumber, pageCount) {
    const { palette, fonts } = painter;
    const footerTop = PAGE.height - PAGE.marginBottom;
    const baseline = footerTop + 12;
    const size = 8.5;

    painter.fillRect(PAGE.marginX, footerTop + 6, CONTENT_WIDTH, 0.4, palette["--border-light"]);
    painter.text(
        "LinkedIn Analyzer",
        PAGE.marginX,
        baseline,
        fonts.body,
        size,
        palette["--text-muted"],
    );
    painter.text(
        `Page ${pageNumber} of ${pageCount}`,
        PAGE.width - PAGE.marginX,
        baseline,
        fonts.body,
        size,
        palette["--text-muted"],
        { align: "right" },
    );
}

/**
 * Draw the whole document onto a jsPDF instance.
 * @param {object} doc - jsPDF document, A4 in millimetres
 * @param {DocumentModel} data - Document model from collectExportData()
 * @param {{palette: Palette, fonts: {body: string, accent: string}}} theme - Palette and registered fonts
 * @returns {number} Page count
 */
export function renderPdfDocument(doc, data, theme) {
    const painter = createPainter(doc, theme.palette, theme.fonts);
    const pages = paginateBlocks(buildBlocks(painter, data), USABLE_HEIGHT);
    // buildBlocks always emits at least the header, so an empty result would
    // mean no rows at all; render one blank page rather than nothing.
    const placed = pages.length ? pages : [[]];

    placed.forEach((segments, pageIndex) => {
        if (pageIndex > 0) {
            doc.addPage();
        }
        painter.fillRect(0, 0, PAGE.width, PAGE.height, theme.palette["--bg-primary"]);

        // A page whose first block carries a continuation label is a page that
        // opened part way through a dashboard: the heading itself never carries
        // one, so a page that starts with it is the section's own first page.
        const [opening] = segments;
        if (opening && opening.block.continuation) {
            drawRunningHead(painter, opening.block.continuation);
        }

        segments.forEach((segment) => {
            const top = PAGE.marginTop + segment.y;
            if (segment.block.drawChrome) {
                segment.block.drawChrome(PAGE.marginX, top, totalRowHeight(segment.rows));
            }
            let rowY = top;
            segment.rows.forEach((row) => {
                row.draw(PAGE.marginX, rowY);
                rowY += row.height;
            });
        });

        drawFooter(painter, pageIndex + 1, placed.length);
    });

    return placed.length;
}
