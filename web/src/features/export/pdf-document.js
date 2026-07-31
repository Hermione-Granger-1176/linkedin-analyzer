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

const CARD_PADDING = 3.6;
const CARD_GUTTER = 8.5;
const RULE_WIDTH = 1.6;
const ROUNDEL_RADIUS = 2.3;

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
 * Place measured blocks onto pages.
 *
 * Pure: it only reads row heights, so it can be exercised without a document.
 * A `keepTogether` block that fits within a page moves to the next page rather
 * than splitting; anything taller flows row by row. Every placed row ends inside
 * the usable area: a row that could not is dropped rather than drawn past it.
 * @param {Array<{rows: Array<{height: number}>, keepTogether?: boolean, spacingAfter?: number}>} blocks - Blocks in document order
 * @param {number} usableHeight - Height available on one page
 * @returns {Array<Array<{block: any, rows: any[], y: number}>>} Placed segments per page
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

    for (const block of blocks) {
        if (!block.rows.length) {
            continue;
        }

        const spacingAfter = block.spacingAfter || 0;
        const height = totalRowHeight(block.rows);

        if (block.keepTogether && height <= usableHeight) {
            if (cursor > 0 && cursor + height > usableHeight) {
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
 * @param {object} palette - Palette from readPdfPalette()
 * @param {{body: string, accent: string}} fonts - Registered font families
 * @returns {object} Drawing helpers
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
     * @param {{r: number, g: number, b: number}} color - Text color
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
     * @param {{r: number, g: number, b: number}} color - Fill color
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

    return { doc, palette, fonts, useFont, wrap, text: drawText, fillRect };
}

/**
 * Resolve an insight's accent to a palette color.
 * @param {object} palette - Palette from readPdfPalette()
 * @param {string} accent - Accent class from the insight
 * @param {string} [suffix] - Token suffix, such as "-bg"
 * @returns {{r: number, g: number, b: number}} Accent color
 */
function accentColor(palette, accent, suffix = "") {
    const token = ACCENT_TOKENS[accent] || DEFAULT_ACCENT;
    return palette[`${token}${suffix}`] || palette[token];
}

/**
 * Build the title block.
 * @param {object} painter - Drawing helpers
 * @param {object} data - Document model
 * @returns {object} Block
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
                    y + lineHeightMm(titleSize) * 0.78,
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
                    y + lineHeightMm(metaSize) * 0.78,
                    fonts.body,
                    metaSize,
                    palette["--text-secondary"],
                );
                painter.fillRect(x, y + lineHeightMm(metaSize) + 1.6, CONTENT_WIDTH, 0.5, palette["--border-light"]);
            },
        },
    ];

    return { kind: "header", rows, keepTogether: true, spacingAfter: 6 };
}

/**
 * Build a section heading block.
 * @param {object} painter - Drawing helpers
 * @param {string} label - Heading text
 * @returns {object} Block
 */
function buildSectionBlock(painter, label) {
    const { palette, fonts } = painter;
    const size = 15;

    return {
        kind: "section",
        keepTogether: true,
        spacingAfter: 3,
        rows: [
            {
                height: lineHeightMm(size) + 3,
                draw: (x, y) => {
                    painter.text(
                        label,
                        x,
                        y + lineHeightMm(size) * 0.78,
                        fonts.accent,
                        size,
                        palette["--text-primary"],
                    );
                    painter.fillRect(x, y + lineHeightMm(size) + 1, 22, 0.9, palette["--accent-yellow"]);
                },
            },
        ],
    };
}

/**
 * Build one insight card block.
 * @param {object} painter - Drawing helpers
 * @param {object} insight - Insight from the analytics worker
 * @param {number} index - One-based card number shown in the roundel
 * @returns {object} Block
 */
function buildInsightBlock(painter, insight, index) {
    const { palette, fonts } = painter;
    const titleSize = 12.5;
    const bodySize = 10;
    const textWidth = CONTENT_WIDTH - CARD_GUTTER - CARD_PADDING;
    const accent = accentColor(palette, insight.accent);
    const tint = accentColor(palette, insight.accent, "-bg");

    const titleLines = painter.wrap(insight.title, textWidth - 10, fonts.body, titleSize);
    const bodyLines = painter.wrap(insight.body, textWidth, fonts.body, bodySize);

    const rows = [];
    titleLines.forEach((line, lineIndex) => {
        rows.push({
            height: lineHeightMm(titleSize) + (lineIndex === 0 ? CARD_PADDING : 0),
            draw: (x, y) => {
                const baseline =
                    y + (lineIndex === 0 ? CARD_PADDING : 0) + lineHeightMm(titleSize) * 0.78;
                if (lineIndex === 0) {
                    painter.doc.setFillColor(accent.r, accent.g, accent.b);
                    painter.doc.circle(
                        x + CARD_GUTTER - ROUNDEL_RADIUS - 1.4,
                        y + CARD_PADDING + ROUNDEL_RADIUS + 0.4,
                        ROUNDEL_RADIUS,
                        "F",
                    );
                    painter.text(
                        String(index),
                        x + CARD_GUTTER - ROUNDEL_RADIUS - 1.4,
                        y + CARD_PADDING + ROUNDEL_RADIUS + 1.6,
                        fonts.body,
                        7,
                        palette["--text-on-accent"],
                        { align: "center" },
                    );
                }
                painter.text(line, x + CARD_GUTTER, baseline, fonts.body, titleSize, accent);
            },
        });
    });
    bodyLines.forEach((line, lineIndex) => {
        rows.push({
            height: lineHeightMm(bodySize) + (lineIndex === 0 ? 1 : 0),
            draw: (x, y) => {
                painter.text(
                    line,
                    x + CARD_GUTTER,
                    y + (lineIndex === 0 ? 1 : 0) + lineHeightMm(bodySize) * 0.78,
                    fonts.body,
                    bodySize,
                    palette["--text-secondary"],
                );
            },
        });
    });
    rows.push({ height: CARD_PADDING, draw: () => {} });

    return {
        kind: "insight",
        keepTogether: true,
        spacingAfter: 3.5,
        rows,
        drawChrome: (x, y, height) => {
            painter.fillRect(x, y, CONTENT_WIDTH, height, tint, 1.6);
            painter.fillRect(x, y, RULE_WIDTH, height, accent, 0.6);
        },
    };
}

/**
 * Build the closing pro-tip panel.
 * @param {object} painter - Drawing helpers
 * @param {string} tip - Tip text
 * @returns {object} Block
 */
function buildTipBlock(painter, tip) {
    const { palette, fonts } = painter;
    const labelSize = 11;
    const bodySize = 10.5;
    const textWidth = CONTENT_WIDTH - CARD_GUTTER - CARD_PADDING;
    const lines = painter.wrap(tip, textWidth, fonts.body, bodySize);

    const rows = [
        {
            height: lineHeightMm(labelSize) + CARD_PADDING,
            draw: (x, y) => {
                painter.text(
                    "Pro tip",
                    x + CARD_GUTTER,
                    y + CARD_PADDING + lineHeightMm(labelSize) * 0.78,
                    fonts.accent,
                    labelSize,
                    palette["--text-primary"],
                );
            },
        },
    ];
    lines.forEach((line) => {
        rows.push({
            height: lineHeightMm(bodySize),
            draw: (x, y) => {
                painter.text(
                    line,
                    x + CARD_GUTTER,
                    y + lineHeightMm(bodySize) * 0.78,
                    fonts.body,
                    bodySize,
                    palette["--text-secondary"],
                );
            },
        });
    });
    rows.push({ height: CARD_PADDING, draw: () => {} });

    return {
        kind: "tip",
        keepTogether: true,
        spacingAfter: 7,
        rows,
        drawChrome: (x, y, height) => {
            painter.fillRect(x, y, CONTENT_WIDTH, height, palette["--accent-yellow-bg"], 1.6);
            painter.fillRect(x, y, RULE_WIDTH, height, palette["--accent-yellow"], 0.6);
        },
    };
}

/**
 * Build the all-time stat grid.
 * @param {object} painter - Drawing helpers
 * @param {Array<{label: string, value: string}>} stats - All-time stats
 * @returns {object} Block
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
                    painter.fillRect(tileX, y, RULE_WIDTH, STAT_TILE_HEIGHT, palette["--accent-blue"], 0.6);
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
 * @param {object} painter - Drawing helpers
 * @param {object} thread - Selected thread
 * @returns {object} Block
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
                y + lineHeightMm(metaSize) * 0.78,
                fonts.body,
                metaSize,
                palette["--text-muted"],
            );
        },
    });

    return { kind: "thread-header", keepTogether: true, spacingAfter: 1.5, rows };
}

/**
 * Resolve the chip a message's direction is drawn with.
 *
 * A one-conversation export gives the selector no way to tell the account owner
 * from the other person, and it says so rather than guessing; a neutral chip is
 * how that reads on the page.
 * @param {object} palette - Palette from readPdfPalette()
 * @param {string} direction - Message direction
 * @returns {{accent: object, chipFill: object, chipLabel: string}} Chip styling
 */
function messageChip(palette, direction) {
    if (direction === "sent") {
        return {
            accent: palette["--accent-blue"],
            chipFill: palette["--accent-blue-bg"],
            chipLabel: "Sent",
        };
    }
    if (direction === "received") {
        return {
            accent: palette["--accent-green"],
            chipFill: palette["--accent-green-bg"],
            chipLabel: "Received",
        };
    }
    return {
        accent: palette["--text-muted"],
        chipFill: palette["--bg-tertiary"],
        chipLabel: "Message",
    };
}

/**
 * Build one message block, chip and all.
 * @param {object} painter - Drawing helpers
 * @param {{direction: string, timestamp: number, body: string}} message - Message
 * @returns {object} Block
 */
function buildMessageBlock(painter, message) {
    const { palette, fonts } = painter;
    const metaSize = 8;
    const bodySize = 9.5;
    const indent = CARD_GUTTER;
    const textWidth = CONTENT_WIDTH - indent - CARD_PADDING;
    const { accent, chipFill, chipLabel } = messageChip(palette, message.direction);

    const lines = painter.wrap(message.body, textWidth, fonts.body, bodySize);
    const rows = [
        {
            height: lineHeightMm(metaSize) + 3.2,
            draw: (x, y) => {
                painter.fillRect(x + indent, y + 1, 15, 4.6, chipFill, 2.3);
                painter.text(
                    chipLabel,
                    x + indent + 7.5,
                    y + 4.3,
                    fonts.body,
                    metaSize - 0.5,
                    accent,
                    { align: "center" },
                );
                painter.text(
                    formatLongDate(message.timestamp),
                    x + indent + 17.5,
                    y + 4.3,
                    fonts.body,
                    metaSize,
                    palette["--text-muted"],
                );
            },
        },
    ];
    lines.forEach((line) => {
        rows.push({
            height: lineHeightMm(bodySize),
            draw: (x, y) => {
                painter.text(
                    line,
                    x + indent,
                    y + lineHeightMm(bodySize) * 0.78,
                    fonts.body,
                    bodySize,
                    palette["--text-secondary"],
                );
            },
        });
    });
    rows.push({ height: 2.6, draw: () => {} });

    return {
        kind: "message",
        keepTogether: true,
        spacingAfter: 1.2,
        rows,
        drawChrome: (x, y, height) => {
            painter.fillRect(x + 1.5, y, 0.9, height, accent, 0.45);
        },
    };
}

/**
 * Build the placeholder shown when there is nothing to report.
 * @param {object} painter - Drawing helpers
 * @returns {object} Block
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
                        y + 4 + lineHeightMm(size) * 0.78,
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
 * @param {object} painter - Drawing helpers
 * @param {object} data - Document model from collectExportData()
 * @returns {object[]} Blocks in document order
 */
export function buildBlocks(painter, data) {
    const insights = Array.isArray(data.insights) ? data.insights : [];
    const allTime = Array.isArray(data.allTime) ? data.allTime : [];
    const threads = Array.isArray(data.threads) ? data.threads : [];

    const blocks = [buildHeaderBlock(painter, data)];

    if (insights.length) {
        blocks.push(buildSectionBlock(painter, "Your insights"));
        insights.forEach((insight, index) => {
            blocks.push(buildInsightBlock(painter, insight, index + 1));
        });
    }
    if (data.tip) {
        blocks.push(buildTipBlock(painter, data.tip));
    }
    if (allTime.length) {
        blocks.push(buildSectionBlock(painter, "All time"), buildStatsBlock(painter, allTime));
    }
    if (threads.length) {
        blocks.push(buildSectionBlock(painter, "Recent conversations"));
        threads.forEach((thread) => {
            blocks.push(buildThreadHeaderBlock(painter, thread));
            (thread.messages || []).forEach((message) => {
                blocks.push(buildMessageBlock(painter, message));
            });
        });
    }
    if (!insights.length && !allTime.length && !threads.length && !data.tip) {
        blocks.push(buildEmptyBlock(painter));
    }

    return blocks;
}

/**
 * Draw the whole document onto a jsPDF instance.
 * @param {object} doc - jsPDF document, A4 in millimetres
 * @param {object} data - Document model from collectExportData()
 * @param {{palette: object, fonts: {body: string, accent: string}}} theme - Palette and registered fonts
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

/**
 * Draw the page footer.
 * @param {object} painter - Drawing helpers
 * @param {number} pageNumber - One-based page number
 * @param {number} pageCount - Total pages
 */
function drawFooter(painter, pageNumber, pageCount) {
    const { palette, fonts } = painter;
    const baseline = PAGE.height - PAGE.marginBottom + 12;

    painter.fillRect(
        PAGE.marginX,
        PAGE.height - PAGE.marginBottom + 6,
        CONTENT_WIDTH,
        0.4,
        palette["--border-light"],
    );
    painter.text(
        "LinkedIn Analyzer",
        PAGE.marginX,
        baseline,
        fonts.body,
        8.5,
        palette["--text-muted"],
    );
    painter.text(
        `Page ${pageNumber} of ${pageCount}`,
        PAGE.width - PAGE.marginX,
        baseline,
        fonts.body,
        8.5,
        palette["--text-muted"],
        { align: "right" },
    );
}
