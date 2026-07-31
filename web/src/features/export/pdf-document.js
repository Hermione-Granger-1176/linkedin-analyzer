/**
 * A4 layout engine for the PDF export.
 *
 * The document is not a screenshot: it is measured and drawn from scratch. Text
 * is wrapped into rows first, rows are grouped into blocks, and blocks are then
 * placed onto pages. A block that asks to be kept together never straddles a
 * page break unless it is taller than a page, in which case it flows row by row
 * so an unusually long message wraps rather than looping forever.
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

// Fraction of the line box the text baseline sits at.
const BASELINE_RATIO = 0.78;

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
 * @typedef {{kind: string, rows: Row[], keepTogether?: boolean, keepWithNext?: boolean, spacingAfter?: number, drawChrome?: (x: number, y: number, height: number) => void}} Block
 * @typedef {{block: Block, rows: Row[], y: number}} Segment
 * @typedef {{palette: Palette, fonts: {body: string, accent: string}, wrap: (text: string, width: number, family: string, size: number) => string[], text: (value: string, x: number, baseline: number, family: string, size: number, color: Rgb, options?: object) => void, fillRect: (x: number, y: number, width: number, height: number, color: Rgb, radius?: number) => void, fillCircle: (x: number, y: number, radius: number, color: Rgb) => void}} Painter
 * @typedef {{generatedAt: Date, rangeLabel: string, insights: object[], tip: string|null, allTime: Array<{label: string, value: string}>, threads: object[]}} DocumentModel
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
function spacerRow(height) {
    return { height, draw: () => {} };
}

/**
 * Height of the first row of the next block that has any.
 *
 * One row, not the whole block: a heading needs to be followed by something to
 * stop reading as stranded, and demanding the entire next block fit too would
 * push short sections onto pages of their own.
 * @param {Block[]} blocks - Blocks in document order
 * @param {number} from - Index to start looking from
 * @returns {number} First row height, or zero when nothing follows
 */
function leadingRowHeight(blocks, from) {
    for (let index = from; index < blocks.length; index += 1) {
        if (blocks[index].rows.length) {
            return blocks[index].rows[0].height;
        }
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
 * room for the first row of whatever follows it; on the row-by-row path the flag
 * does not apply. A heading is only a heading if something comes after it on the
 * same page; without this, "All time" and a person's name were routinely left
 * alone at the foot of a page with their content overleaf.
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

        const spacingAfter = block.spacingAfter || 0;
        const height = totalRowHeight(block.rows);

        if (block.keepTogether && height <= usableHeight) {
            let required = height;
            if (block.keepWithNext) {
                // Falls back to the block's own height when the pair cannot
                // share a page at all, so an unsatisfiable request cannot loop
                // pages.
                const withNext = height + spacingAfter + leadingRowHeight(blocks, index + 1);
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

    return { palette, fonts, wrap, text: drawText, fillRect, fillCircle };
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
 * 1.71:1 - neither is visible on paper. Measuring instead keeps every one of
 * them legible whatever the tokens are later set to.
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
 * @returns {Block} Block
 */
function buildSectionBlock(painter, label) {
    const { palette, fonts } = painter;
    const size = 15;

    return {
        kind: "section",
        keepTogether: true,
        keepWithNext: true,
        spacingAfter: 3,
        rows: [
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
                    painter.fillRect(
                        x,
                        y + lineHeightMm(size) + 1,
                        22,
                        0.9,
                        palette["--accent-yellow"],
                    );
                },
            },
        ],
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
 * Build the all-time stat grid.
 * @param {Painter} painter - Drawing helpers
 * @param {Array<{label: string, value: string}>} stats - All-time stats
 * @returns {Block} Block
 */
function buildStatsBlock(painter, stats) {
    const { palette, fonts } = painter;
    const tileWidth = (CONTENT_WIDTH - STAT_GAP * (STAT_COLUMNS - 1)) / STAT_COLUMNS;
    const rows = [];

    for (let index = 0; index < stats.length; index += STAT_COLUMNS) {
        const tiles = stats.slice(index, index + STAT_COLUMNS);
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
                        stat.value,
                        tileX + CARD_GUTTER,
                        y + 14.6,
                        fonts.accent,
                        17,
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
 * Turn the document model into measured blocks.
 * @param {Painter} painter - Drawing helpers
 * @param {DocumentModel} data - Document model from collectExportData()
 * @returns {Block[]} Blocks in document order
 */
export function buildBlocks(painter, data) {
    const insights = Array.isArray(data.insights) ? data.insights : [];
    const allTime = Array.isArray(data.allTime) ? data.allTime : [];
    const threads = Array.isArray(data.threads) ? data.threads : [];

    const blocks = [buildHeaderBlock(painter, data)];

    if (insights.length) {
        blocks.push(buildSectionBlock(painter, "Your insights"));
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
        blocks.push(buildSectionBlock(painter, "Recent conversations"));
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
