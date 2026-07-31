import { describe, expect, it, vi } from "vitest";

import { DAY_LABELS } from "../../../src/features/analytics/constants.js";
import { PDF_PALETTE_TOKENS } from "../../../src/features/export/palette.js";
import {
    axisScale,
    buildBarChartBlocks,
    buildHeatmapBlocks,
    buildLineChartBlocks,
    buildListBlocks,
    pickLabelIndices,
} from "../../../src/features/export/pdf-charts.js";
import { createPainter, paginateBlocks } from "../../../src/features/export/pdf-document.js";
import { USABLE_HEIGHT } from "../../../src/features/export/pdf-layout.js";

const HOURS_PER_DAY = 24;

// Taken from the palette itself rather than copied, and spaced ten apart: a
// chart mixes colors towards the paper, and neighbouring token values would
// round back into each other and hide which ink a cell was painted with.
const palette = Object.fromEntries(
    PDF_PALETTE_TOKENS.map((token, index) => [
        token,
        { r: index * 10, g: index * 10, b: index * 10 },
    ]),
);
const fonts = { body: "PatrickHand", accent: "Caveat" };

/**
 * Width the stub gives a string, in millimetres.
 *
 * The stub's own metric, restated so a test can predict it: what a column has
 * to hold is the width of the text drawn in it, not the width it was fitted to.
 * @param {string} value - Text
 * @param {number} size - Font size in points
 * @returns {number} Width in millimetres
 */
function textWidth(value, size) {
    return value.length * size * 0.05;
}

/**
 * Build a jsPDF stub with deterministic text measurement.
 *
 * Records the fill, stroke and line width in force at each call, so a test can
 * ask what a cell was painted with rather than only where it was painted.
 * @returns {object} Stub document
 */
function createDocStub() {
    let size = 10;
    let fill = null;
    let stroke = null;
    let lineWidth = 0;
    const calls = { text: [], rect: [], roundedRect: [], circle: [], lines: [] };

    return {
        calls,
        setFont: vi.fn(),
        setFontSize: vi.fn((value) => {
            size = value;
        }),
        setTextColor: vi.fn(),
        setFillColor: vi.fn((r, g, b) => {
            fill = { r, g, b };
        }),
        setDrawColor: vi.fn((r, g, b) => {
            stroke = { r, g, b };
        }),
        setLineWidth: vi.fn((value) => {
            lineWidth = value;
        }),
        rect: vi.fn((x, y, width, height) => calls.rect.push({ x, y, width, height, fill })),
        roundedRect: vi.fn((x, y, width, height, radius) =>
            calls.roundedRect.push({ x, y, width, height, radius, fill }),
        ),
        circle: vi.fn((x, y, radius) => calls.circle.push({ x, y, radius, fill })),
        lines: vi.fn((deltas, x, y, scale, style) =>
            calls.lines.push({ deltas, x, y, style, stroke, lineWidth }),
        ),
        text: vi.fn((value, x, y, options) =>
            calls.text.push({ value, x, y, align: options && options.align }),
        ),
        // Roughly half a millimetre per character at 10pt, so both measuring and
        // wrapping are predictable without pulling in real font metrics, and a
        // label measured and then wrapped agrees with itself.
        getTextWidth: vi.fn((value) => textWidth(value, size)),
        // Broken at spaces, the way jsPDF breaks. A stub that chopped every
        // width-worth of characters instead would have hidden the word-granular
        // truncation these charts used to do, which is exactly what it did.
        splitTextToSize: vi.fn((value, width) => {
            const lines = [];
            for (const word of String(value).split(" ")) {
                const joined = lines.length ? `${lines[lines.length - 1]} ${word}` : word;
                if (lines.length && textWidth(joined, size) <= width) {
                    lines[lines.length - 1] = joined;
                    continue;
                }
                lines.push(word);
            }
            return lines;
        }),
    };
}

/**
 * Build a painter over a fresh stub.
 * @returns {{doc: object, painter: object}} Stub and the painter drawing onto it
 */
function createHarness() {
    const doc = createDocStub();
    return { doc, painter: createPainter(doc, palette, fonts) };
}

/**
 * Draw every row of a run of blocks at the page origin.
 * @param {object[]} blocks - Blocks from a chart builder
 */
function drawAll(blocks) {
    for (const block of blocks) {
        let y = 0;
        for (const row of block.rows) {
            row.draw(0, y);
            y += row.height;
        }
    }
}

/**
 * Values of the text drawn with a given alignment.
 * @param {object} doc - Stub document
 * @param {string|undefined} align - Alignment to match
 * @returns {string[]} Drawn text
 */
function textAligned(doc, align) {
    return doc.calls.text.filter((call) => call.align === align).map((call) => call.value);
}

describe("axisScale", () => {
    it("floors a flat series at two", () => {
        // A series of ones plotted against a maximum of one is a straight line
        // along the top edge, which stops reading as a chart.
        expect(axisScale(0)).toEqual([0, 1, 2]);
        expect(axisScale(1)).toEqual([0, 1, 2]);
    });

    it("counts up in whole steps a reader can add", () => {
        expect(axisScale(4)).toEqual([0, 1, 2, 3, 4, 5]);
        expect(axisScale(5)).toEqual([0, 2, 4, 6]);
        expect(axisScale(19)).toEqual([0, 5, 10, 15, 20, 25]);
        expect(axisScale(336)).toEqual([0, 100, 200, 300, 400]);
    });

    it("gives every tick of every scale a round step", () => {
        // The scale used to be a pleasant maximum cut into fractions of itself,
        // which printed 0/94/188/282/377 and 0/18/36/54/73: only the two ends of
        // either one meant anything to a reader.
        for (let peak = 0; peak <= 2000; peak += 1) {
            const values = axisScale(peak);
            const step = values[1];
            const magnitude = 10 ** Math.floor(Math.log10(step));

            expect([1, 2, 5], `peak ${peak} step ${step}`).toContain(step / magnitude);
            expect(
                values.every((value, index) => value === index * step),
                `peak ${peak}`,
            ).toBe(true);
        }
    });

    it("keeps the data inside the scale, with headroom above it", () => {
        for (let peak = 0; peak <= 2000; peak += 1) {
            const values = axisScale(peak);
            const maxValue = values[values.length - 1];

            // Room above the peak, but not so much that the series is drawn as
            // a ripple along the bottom of the plot.
            expect(maxValue, `peak ${peak}`).toBeGreaterThan(peak);
            expect(maxValue, `peak ${peak}`).toBeLessThanOrEqual(Math.max(2, peak * 1.7));
            expect(values.length, `peak ${peak}`).toBeLessThanOrEqual(7);
        }
    });
});

describe("pickLabelIndices", () => {
    it("labels every point of a series the width can hold", () => {
        expect([...pickLabelIndices(5, 165)]).toEqual([0, 1, 2, 3, 4]);
    });

    it("thins a long series down to what fits", () => {
        const kept = pickLabelIndices(100, 120);

        expect([...kept].slice(0, 3)).toEqual([0, 15, 30]);
        expect(kept.has(99)).toBe(true);
        expect(kept.size).toBe(7);
    });

    it("evicts the neighbour of the last point when the two would collide", () => {
        // Every third of eight points leaves 6 and 7 side by side. The last
        // point anchors where the series ends, so 6 gives way rather than 7.
        expect([...pickLabelIndices(8, 50)]).toEqual([0, 3, 7]);
    });

    it("gives the last label the room every other pair gets", () => {
        // Ten years of months over the plot's 164mm: the step left the last two
        // indices six apart, which the index test read as clear and the paper
        // read as 8mm, printing "Dec 2025" and "Jun 2026" as "Dec 202Jun 2026".
        // 500 is the case where the step happens to leave the last two far
        // enough apart that the one before it stays.
        for (const count of [8, 13, 60, 100, 124, 125, 240, 500, 519]) {
            const width = 164;
            const kept = [...pickLabelIndices(count, width)];
            const gaps = kept
                .slice(1)
                .map((index, position) => ((index - kept[position]) * width) / count);

            expect(kept[kept.length - 1], `${count} points`).toBe(count - 1);
            // MIN_LABEL_SPACING in pdf-charts.js: room for a whole "Jan 2024".
            expect(Math.min(...gaps), `${count} points`).toBeGreaterThanOrEqual(16);
        }
    });

    it("labels nothing when there are no points", () => {
        expect(pickLabelIndices(0, 165).size).toBe(0);
    });
});

describe("buildLineChartBlocks", () => {
    it("reserves the whole plot as a single row under its title", () => {
        const { painter } = createHarness();
        const blocks = buildLineChartBlocks(painter, {
            title: "Activity timeline",
            points: [{ label: "Jan 2026", value: 3 }],
        });

        expect(blocks.map((block) => block.kind)).toEqual(["chart-title", "line-chart"]);
        // One row, so a page break can never slice a plot in half.
        expect(blocks[1].rows).toHaveLength(1);
        expect(blocks[1].keepTogether).toBe(true);
    });

    it("draws a single point as a dot with no line to join it to", () => {
        const { doc, painter } = createHarness();

        drawAll(
            buildLineChartBlocks(painter, {
                title: "Activity timeline",
                points: [{ label: "Jan 2026", value: 3 }],
            }),
        );

        expect(doc.calls.circle).toHaveLength(1);
        expect(doc.calls.lines).toEqual([]);
        expect(doc.calls.text.map((call) => call.value)).toContain("Activity timeline");
    });

    it("fills the area and strokes the spine of a multi-point series", () => {
        const { doc, painter } = createHarness();

        drawAll(
            buildLineChartBlocks(painter, {
                title: "Activity timeline",
                points: [
                    { label: "Jan 2026", value: 3 },
                    { label: "Feb 2026", value: 6 },
                    { label: "Mar 2026", value: 0 },
                ],
            }),
        );

        const [area, spine] = doc.calls.lines;
        expect(doc.calls.lines.map((call) => call.style)).toEqual(["F", "S"]);
        // The area drops to the baseline at both ends, so it carries two
        // vertices more than the spine it is drawn under.
        expect(area.deltas).toHaveLength(4);
        expect(spine.deltas).toHaveLength(2);
        expect(spine.lineWidth).toBe(0.5);
        expect(doc.calls.circle).toHaveLength(3);
    });

    it("plots in the timeline's blue whatever ink the config asks for", () => {
        // The colour belongs to the chart type, not to whoever collected the
        // data: on screen a timeline is blue however the dashboard was built.
        const { doc, painter } = createHarness();

        drawAll(
            buildLineChartBlocks(painter, {
                title: "Activity timeline",
                points: [
                    { label: "Jan 2026", value: 3 },
                    { label: "Feb 2026", value: 6 },
                ],
                accent: "--accent-green",
            }),
        );

        const [, spine] = doc.calls.lines;
        expect(spine.stroke).toEqual(palette["--accent-blue"]);
        expect(doc.calls.circle[0].fill).toEqual(palette["--accent-blue"]);
    });

    it("labels the values it plots, and the months under them", () => {
        const { doc, painter } = createHarness();

        drawAll(
            buildLineChartBlocks(painter, {
                title: "Activity timeline",
                points: [
                    { label: "Jan 2026", value: 3 },
                    { label: "Feb 2026", value: 6 },
                    { label: "Mar 2026", value: 0 },
                ],
            }),
        );

        // A month with nothing in it keeps its dot and its axis label but takes
        // no "0" above the baseline, where it would only add noise.
        expect(textAligned(doc, "center")).toEqual(["3", "Jan 2026", "6", "Feb 2026", "Mar 2026"]);
    });

    it("keeps the whole of a label the reader cannot hover", () => {
        // Growth runs across years and the shorter ranges are weekly, so a
        // first word alone reads "Jan Jan Feb Feb" or loses the year outright.
        const { doc, painter } = createHarness();

        drawAll(
            buildLineChartBlocks(painter, {
                title: "Connection growth",
                points: [
                    { label: "Jan 2024", value: 3 },
                    { label: "Jan 05", value: 6 },
                ],
            }),
        );

        const centred = textAligned(doc, "center");
        expect(centred).toContain("Jan 2024");
        expect(centred).toContain("Jan 05");
    });

    it("never plots a point above its highest gridline", () => {
        // The step was rounded and the loop stopped at the axis maximum, so at
        // niceAxisMax(19) = 22 the gridlines ran 0/6/12/18 and the band above 18
        // held the peak with nothing to read it against.
        for (const peak of [1, 3, 4, 5, 7, 9, 13, 19, 20, 50, 120]) {
            const { doc, painter } = createHarness();

            drawAll(
                buildLineChartBlocks(painter, {
                    title: "Activity timeline",
                    points: [
                        { label: "Jan 2026", value: 0 },
                        { label: "Feb 2026", value: peak },
                    ],
                }),
            );

            // A gridline is the only hairline the plot draws the full width of.
            const gridlines = doc.calls.rect.filter((call) => call.height === 0.2);
            const top = Math.min(...gridlines.map((call) => call.y));
            const highest = Math.min(...doc.calls.circle.map((call) => call.y));

            expect(gridlines.length, `peak ${peak}`).toBeGreaterThan(1);
            expect(highest, `peak ${peak}`).toBeGreaterThanOrEqual(top);
        }
    });

    it("labels the axis maximum it scales against", () => {
        const { doc, painter } = createHarness();

        drawAll(
            buildLineChartBlocks(painter, {
                title: "Activity timeline",
                points: [
                    { label: "Jan 2026", value: 4 },
                    { label: "Feb 2026", value: 19 },
                ],
            }),
        );

        // Every tick a whole five, the topmost the maximum the plot scales by.
        // The scale used to read 0/6/12/18/22.
        expect(textAligned(doc, "right")).toEqual(["0", "5", "10", "15", "20", "25"]);
    });

    it("keeps the gridlines out of the value labels", () => {
        // The rules run the full width of the plot, so "21" and "37" had one
        // straight through the digits. The gridline is broken behind the label
        // rather than the label moved, which would only crowd the next rule.
        const { doc, painter } = createHarness();

        drawAll(
            buildLineChartBlocks(painter, {
                title: "Activity timeline",
                points: [
                    { label: "Jan 2026", value: 21 },
                    { label: "Feb 2026", value: 37 },
                    { label: "Mar 2026", value: 57 },
                ],
            }),
        );

        const lastGridline = doc.calls.rect.findLastIndex((call) => call.height === 0.2);
        const labels = doc.calls.text.filter((call) => ["21", "37", "57"].includes(call.value));

        expect(labels).toHaveLength(3);
        for (const label of labels) {
            const half = textWidth(label.value, 6.5) / 2;
            // Painted in the paper colour, over the whole of the label's line
            // box, and after the rules it breaks.
            const covering = doc.calls.rect.findIndex(
                (call) =>
                    call.fill.r === palette["--bg-primary"].r &&
                    call.x <= label.x - half &&
                    call.x + call.width >= label.x + half &&
                    call.y <= label.y - 2 &&
                    call.y + call.height >= label.y,
            );

            expect(covering, `${label.value} knockout`).toBeGreaterThan(lastGridline);
        }
    });

    it("keeps the last axis label inside the plot it belongs to", () => {
        // The last point sits half a slice from the right edge, which over ten
        // years of months is a third of a millimetre: centred on its dot, "Jun
        // 2026" ran out past the plot and over the margin.
        const { doc, painter } = createHarness();
        const points = Array.from({ length: 124 }, (_, index) => ({
            label: `Mon ${2016 + Math.floor(index / 12)}`,
            value: index,
        }));

        drawAll(buildLineChartBlocks(painter, { title: "Connection growth", points }));

        // LINE_PADDING in pdf-charts.js: the plot runs from 11mm to 175mm.
        const drawn = doc.calls.text.filter((call) => call.align === "center");
        for (const label of drawn) {
            const half = textWidth(label.value, 6.5) / 2;
            expect(label.x - half, label.value).toBeGreaterThanOrEqual(11);
            expect(label.x + half, label.value).toBeLessThanOrEqual(175);
        }
        expect(drawn.length).toBeGreaterThan(1);
    });

    it("drops the value labels once the points are packed too tightly", () => {
        const { doc, painter } = createHarness();
        const points = Array.from({ length: 20 }, (_, index) => ({
            label: `Point ${index}`,
            value: index + 1,
        }));

        drawAll(buildLineChartBlocks(painter, { title: "Activity timeline", points }));

        const centred = textAligned(doc, "center");
        expect(centred.every((value) => value.startsWith("Point "))).toBe(true);
        expect(centred.length).toBeLessThan(points.length);
    });
});

describe("buildBarChartBlocks", () => {
    it("measures one row per bar and a spacer below them", () => {
        const { painter } = createHarness();
        const blocks = buildBarChartBlocks(painter, {
            title: "Top topics",
            items: [
                { topic: "Hiring", count: 4 },
                { topic: "Engineering", count: 2 },
            ],
        });

        expect(blocks.map((block) => block.kind)).toEqual(["chart-title", "bar-chart"]);
        // One row per bar, so a chart taller than a page can still flow, and
        // kept together so one that fits a page is never split across two.
        expect(blocks[1].rows).toHaveLength(3);
        expect(blocks[1].keepTogether).toBe(true);
    });

    it("moves a chart that will not fit onto the next page whole", () => {
        // Split, the tail arrived overleaf as unlabelled bars with no title and
        // nothing to say what they counted.
        const { painter } = createHarness();
        const items = Array.from({ length: 12 }, (_, index) => ({
            topic: `Topic ${index + 1}`,
            count: 12 - index,
        }));
        const [, chart] = buildBarChartBlocks(painter, { title: "Top topics", items });
        const filled = { rows: [{ height: 200, draw: () => {} }], keepTogether: true };

        const pages = paginateBlocks([filled, chart], USABLE_HEIGHT);

        expect(pages).toHaveLength(2);
        expect(pages[0]).toHaveLength(1);
        expect(pages[1][0].block).toBe(chart);
        expect(pages[1][0].rows).toHaveLength(13);
        expect(pages[1][0].y).toBe(0);
    });

    it("truncates a label too long for its column", () => {
        const { doc, painter } = createHarness();
        const topic = "Distributed systems ".repeat(20).trim();

        drawAll(buildBarChartBlocks(painter, { title: "Top topics", items: [{ topic, count: 4 }] }));

        const [label] = textAligned(doc, "right");
        expect(label.endsWith("…")).toBe(true);
        expect(topic.startsWith(label.slice(0, -1))).toBe(true);
        expect(label.length).toBeLessThan(topic.length);
    });

    it("gives a zero-count bar a visible stub", () => {
        const { doc, painter } = createHarness();

        drawAll(
            buildBarChartBlocks(painter, {
                title: "Top topics",
                items: [
                    { topic: "Hiring", count: 4 },
                    { topic: "Nothing", count: 0 },
                ],
            }),
        );

        // A row draws its tinted track and then the accent cap over its left
        // edge, so the tracks are the first of each pair. A row is never a
        // label with blank paper next to it.
        const tracks = doc.calls.roundedRect.filter((call, index) => index % 2 === 0);
        expect(tracks).toHaveLength(2);
        expect(tracks[1].width).toBe(0.6);
        expect(tracks[0].width).toBeGreaterThan(tracks[1].width);
        expect(doc.calls.text.map((call) => call.value)).toContain("0");
    });

    it("keeps a bar's corner radius inside the bar it rounds", () => {
        // At the stub width the fixed radius was wider than half the bar, which
        // jsPDF draws as a lozenge overshooting its own track.
        const { doc, painter } = createHarness();

        drawAll(
            buildBarChartBlocks(painter, {
                title: "Top topics",
                items: [{ topic: "Nothing", count: 0 }],
            }),
        );

        for (const call of doc.calls.roundedRect) {
            expect(call.radius).toBeLessThanOrEqual(call.width / 2);
        }
    });

    it("draws its bars in the purple the Connections screen uses", () => {
        // Companies and positions are both drawn by drawTopics(), which is
        // purple for either; a config asking for another colour is ignored.
        const { doc, painter } = createHarness();

        drawAll(
            buildBarChartBlocks(painter, {
                title: "Top positions",
                items: [{ topic: "Engineer", count: 4 }],
                accent: "--accent-green",
            }),
        );

        const [, cap] = doc.calls.roundedRect;
        expect(cap.fill).toEqual(palette["--accent-purple"]);
    });

    it("leaves a bar with no label of its own blank rather than elided", () => {
        const { doc, painter } = createHarness();

        drawAll(buildBarChartBlocks(painter, { title: "Top topics", items: [{ count: 4 }] }));

        expect(textAligned(doc, "right")).toEqual([""]);
    });
});

describe("buildHeatmapBlocks", () => {
    /** @returns {number[][]} A week of empty hours */
    const emptyGrid = () => DAY_LABELS.map(() => new Array(HOURS_PER_DAY).fill(0));

    /**
     * The cells of the grid, told apart from the hairline rules over them.
     * @param {object} doc - Stub document
     * @returns {object[]} Cell fills in day-major order
     */
    function cellsOf(doc) {
        return doc.calls.rect.filter((call) => call.width > 1 && call.height > 1);
    }

    it("draws a cell for every hour of every day", () => {
        const { doc, painter } = createHarness();
        const grid = DAY_LABELS.map((_, day) =>
            Array.from({ length: HOURS_PER_DAY }, (cell, hour) => day + hour),
        );

        const blocks = buildHeatmapBlocks(painter, { title: "When you are active", grid });
        drawAll(blocks);

        expect(blocks.map((block) => block.kind)).toEqual(["chart-title", "heatmap"]);
        const cells = cellsOf(doc);
        expect(cells).toHaveLength(DAY_LABELS.length * HOURS_PER_DAY);
        expect(new Set(cells.map((cell) => cell.x)).size).toBe(HOURS_PER_DAY);
        expect(new Set(cells.map((cell) => cell.y)).size).toBe(DAY_LABELS.length);
        expect(textAligned(doc, "right")).toEqual([...DAY_LABELS]);
    });

    it("inks an empty cell faintly rather than leaving blank paper", () => {
        const { doc, painter } = createHarness();
        const grid = emptyGrid();
        grid[2][9] = 5;

        drawAll(buildHeatmapBlocks(painter, { title: "When you are active", grid }));

        const cells = cellsOf(doc);
        const busy = cells[2 * HOURS_PER_DAY + 9];
        expect(cells[0].fill.r).toBeGreaterThan(palette["--bg-primary"].r);
        expect(busy.fill.r).toBeGreaterThan(cells[0].fill.r);
    });

    it("labels the hours every three columns", () => {
        const { doc, painter } = createHarness();

        drawAll(buildHeatmapBlocks(painter, { title: "When you are active", grid: emptyGrid() }));

        const unaligned = textAligned(doc, undefined);
        expect(unaligned).toEqual([
            "When you are active",
            "00",
            "03",
            "06",
            "09",
            "12",
            "15",
            "18",
            "21",
        ]);
    });

    it("inks its busiest cell in the blue the Analytics screen uses", () => {
        const { doc, painter } = createHarness();
        const grid = emptyGrid();
        grid[0][0] = 9;

        drawAll(
            buildHeatmapBlocks(painter, {
                title: "When you are active",
                grid,
                accent: "--accent-purple",
            }),
        );

        // The busiest cell is drawn at full intensity, so it is the accent
        // itself rather than a mix of it.
        expect(cellsOf(doc)[0].fill).toEqual(palette["--accent-blue"]);
    });
});

describe("buildListBlocks", () => {
    it("draws a primary, a secondary and a value across one row", () => {
        const { doc, painter } = createHarness();
        const [, list] = buildListBlocks(painter, {
            title: "Fading conversations",
            items: [{ primary: "Ada Lovelace", secondary: "Analytical Engines", value: "62 days" }],
        });

        list.rows[0].draw(0, 0);

        expect(list.rows).toHaveLength(2);
        expect(doc.calls.text.map((call) => call.value)).toEqual([
            "Ada Lovelace",
            "Analytical Engines",
            "62 days",
        ]);
    });

    it("draws only the primary when there is nothing to put beside it", () => {
        // Silent connections carry a name and, often, nothing else; the row must
        // not reserve ink for fields the data never filled in.
        const { doc, painter } = createHarness();
        const [, list] = buildListBlocks(painter, {
            title: "Silent connections",
            items: [{ primary: "Ada Lovelace" }],
        });

        list.rows[0].draw(0, 0);

        expect(doc.calls.text.map((call) => call.value)).toEqual(["Ada Lovelace"]);
    });

    it("keeps the primary clear of the secondary drawn back at it", () => {
        // Both were fitted to the same width and drawn from opposite ends of one
        // baseline, so an ordinary name and an ordinary headline overprinted by
        // 36mm. Long enough here that each fills its own column, so what the
        // columns are is what this measures.
        const { doc, painter } = createHarness();
        const [, list] = buildListBlocks(painter, {
            title: "Top contacts",
            items: [
                {
                    primary:
                        "Wolfgang-Maximilian von Habsburg-Lothringen de la Cruz PhD MBA ".repeat(6),
                    secondary:
                        "Head of People Operations and Culture @ Globex Worldwide Holdings International ".repeat(
                            6,
                        ),
                },
            ],
        });

        list.rows[0].draw(0, 0);

        const [primaryDraw, secondaryDraw] = doc.calls.text;
        expect(secondaryDraw.align).toBe("right");
        expect(primaryDraw.x + textWidth(primaryDraw.value, 7.5)).toBeLessThanOrEqual(
            secondaryDraw.x - textWidth(secondaryDraw.value, 6.5),
        );
        // Roughly the larger share of the row, not all of it.
        expect(textWidth(primaryDraw.value, 7.5)).toBeGreaterThan(
            textWidth(secondaryDraw.value, 6.5),
        );
    });

    it("fills the room a cut name has rather than stopping at a space", () => {
        // Word-granular truncation cost one row 54 characters for the sake of
        // one digit: "Bartholomewkonstantinos9 Vandenbroucke-..." printed whole
        // while "Bartholomewkonstantinos13 ..." printed as its first token and
        // then 53mm of blank row.
        const { doc, painter } = createHarness();
        // Two tokens, the second far too long for the column, which is the
        // shape a wrap has nowhere to break: it hands back the first token and
        // the row loses the name entirely.
        const surname = "Vandenbroucke-Steenhuyse-Papadopoulos-Rajagopalachari-".repeat(5);
        const items = Array.from({ length: 20 }, (_, index) => ({
            primary: `Bartholomewkonstantinos${index} ${surname}`,
        }));
        const [, list] = buildListBlocks(painter, { title: "Top contacts", items });

        items.forEach((item, index) => list.rows[index].draw(0, 0));

        // LIST_* in pdf-charts.js: the primary column is 55% of the row less its
        // value column and its insets, which is 82.5mm.
        const column = ((178 - 24 - 2 * 2) * 55) / 100;
        for (const call of doc.calls.text) {
            expect(call.value.endsWith("…"), call.value).toBe(true);
            expect(textWidth(call.value, 7.5), call.value).toBeLessThanOrEqual(column);
            // Every row keeps most of the surname, not just the first token.
            expect(call.value.length, call.value).toBeGreaterThan(
                "Bartholomewkonstantinos13".length + 10,
            );
        }
        // One character of data apart, one character of label apart: the rows
        // no longer fall off a cliff between "…9" and "…13".
        const lengths = new Set(doc.calls.text.map((call) => call.value.length));
        expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThanOrEqual(1);
    });

    it("flows a list too tall for any page row by row", () => {
        // Keeping it together is only ever an option while it fits: the
        // pagination contract is that anything taller still flows.
        const { painter } = createHarness();
        const items = Array.from({ length: 80 }, (_, index) => ({
            primary: `Contact ${index + 1}`,
        }));
        const [, list] = buildListBlocks(painter, { title: "Silent connections", items });

        const pages = paginateBlocks([list], USABLE_HEIGHT);

        expect(pages.length).toBeGreaterThan(1);
        expect(pages.every((page) => page[0].block === list)).toBe(true);
        expect(pages.reduce((sum, page) => sum + page[0].rows.length, 0)).toBe(list.rows.length);
    });

    it("alternates the row fill so a long list stays readable", () => {
        const { doc, painter } = createHarness();
        const [, list] = buildListBlocks(painter, {
            title: "Top contacts",
            items: [{ primary: "Ada Lovelace" }, { primary: "Grace Hopper" }],
        });

        list.rows[0].draw(0, 0);
        list.rows[1].draw(0, 10);

        const [first, second] = doc.calls.roundedRect;
        expect(first.fill).toEqual(palette["--bg-tertiary"]);
        expect(second.fill).toEqual(palette["--bg-primary"]);
    });
});

describe("chart builders with unusable numbers", () => {
    /**
     * Every number a builder handed to the document, in call order.
     * @param {object} doc - Stub document
     * @returns {number[]} Coordinates, sizes and radii
     */
    function coordinates(doc) {
        const drawn = [
            ...doc.calls.rect,
            ...doc.calls.roundedRect,
            ...doc.calls.circle,
            ...doc.calls.text,
            ...doc.calls.lines.flatMap((call) => [
                { x: call.x, y: call.y },
                ...call.deltas.map(([dx, dy]) => ({ x: dx, y: dy })),
            ]),
        ];
        return drawn.flatMap((call) =>
            Object.values(call).filter((value) => typeof value === "number"),
        );
    }

    it("leaves out the points and bars it cannot scale against", () => {
        // Real jsPDF answers a NaN coordinate with "Invalid arguments passed to
        // jsPDF.rect", which pdf.js catches as a failed export: the reader gets
        // no document at all rather than one chart short. Nothing sends one
        // today, which is the case mixColors() already defends against.
        const bad = [Number.NaN, Number.POSITIVE_INFINITY, undefined, null, "12"];

        for (const value of bad) {
            const line = createHarness();
            drawAll(
                buildLineChartBlocks(line.painter, {
                    title: "Activity timeline",
                    points: [
                        { label: "Jan 2026", value: 4 },
                        { label: "Feb 2026", value },
                        { label: "Mar 2026", value: 9 },
                    ],
                }),
            );
            const bars = createHarness();
            drawAll(
                buildBarChartBlocks(bars.painter, {
                    title: "Top topics",
                    items: [
                        { topic: "Hiring", count: 4 },
                        { topic: "Nothing", count: value },
                    ],
                }),
            );

            expect(coordinates(line.doc).every(Number.isFinite), `line ${String(value)}`).toBe(
                true,
            );
            expect(coordinates(bars.doc).every(Number.isFinite), `bars ${String(value)}`).toBe(
                true,
            );
            // The points either side of it are still plotted.
            expect(line.doc.calls.circle, `line ${String(value)}`).toHaveLength(2);
            expect(bars.doc.calls.text.map((call) => call.value)).toContain("Hiring");
        }
    });

    it("draws a series of nothing but unusable numbers as an empty chart", () => {
        const { doc, painter } = createHarness();

        drawAll(
            buildLineChartBlocks(painter, {
                title: "Activity timeline",
                points: [{ label: "Jan 2026", value: Number.NaN }],
            }),
        );

        expect(doc.calls.text.map((call) => call.value)).toContain("Activity timeline");
        expect(doc.calls.circle).toEqual([]);
        expect(coordinates(doc).every(Number.isFinite)).toBe(true);
    });
});

describe("chart builders with no series", () => {
    it("draw their chrome rather than throwing", () => {
        // The document drops an empty chart before it reaches a builder, so
        // these guards answer for a chart config whose series never arrived.
        const builders = [
            buildLineChartBlocks,
            buildBarChartBlocks,
            buildHeatmapBlocks,
            buildListBlocks,
        ];

        for (const build of builders) {
            const { doc, painter } = createHarness();
            drawAll(build(painter, { title: "Nothing yet" }));

            expect(doc.calls.text.map((call) => call.value)).toContain("Nothing yet");
            expect(doc.calls.circle).toEqual([]);
        }
    });
});
