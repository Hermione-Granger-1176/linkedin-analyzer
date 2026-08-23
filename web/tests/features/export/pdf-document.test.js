import { describe, expect, it, vi } from "vitest";

import { PDF_PALETTE_TOKENS, readPdfPalette } from "../../../src/features/export/palette.js";
import {
    buildBlocks,
    createPainter,
    formatLongDate,
    paginateBlocks,
    renderPdfDocument,
} from "../../../src/features/export/pdf-document.js";
import {
    CONTENT_WIDTH,
    PAGE,
    USABLE_HEIGHT,
    contrastRatio,
    lineHeightMm,
    readableOn,
    totalRowHeight,
} from "../../../src/features/export/pdf-layout.js";

// Taken from the palette itself rather than copied: a token added there has to
// reach the stub, or the painter is handed undefined and nothing notices.
const palette = Object.fromEntries(
    PDF_PALETTE_TOKENS.map((token, index) => [token, { r: index, g: index, b: index }]),
);
const fonts = { body: "PatrickHand", accent: "Caveat" };
const theme = { palette, fonts };

/**
 * Build a jsPDF stub with deterministic text measurement.
 * @returns {object} Stub document
 */
function createDocStub() {
    let size = 10;
    const calls = { text: [], addPage: 0, rect: [], roundedRect: [], circle: [], lines: [] };

    return {
        calls,
        setFont: vi.fn(),
        setFontSize: vi.fn((value) => {
            size = value;
        }),
        setTextColor: vi.fn(),
        setFillColor: vi.fn(),
        setDrawColor: vi.fn(),
        setLineWidth: vi.fn(),
        lines: vi.fn((...args) => calls.lines.push(args)),
        rect: vi.fn((...args) => calls.rect.push(args)),
        roundedRect: vi.fn((...args) => calls.roundedRect.push(args)),
        circle: vi.fn((...args) => calls.circle.push(args)),
        addPage: vi.fn(() => {
            calls.addPage += 1;
        }),
        // The size in force is recorded alongside the line: a stat value that
        // stepped down to fit its tile is otherwise indistinguishable from one
        // drawn at the headline size.
        text: vi.fn((value, x, y) => calls.text.push({ value, x, y, size })),
        // The same metric the wrap stub below wraps by, so a label measured and
        // then wrapped agrees with itself.
        getTextWidth: vi.fn((value) => value.length * size * 0.05),
        // Roughly half a millimetre per character at 10pt, so wrapping is
        // predictable without pulling in real font metrics.
        splitTextToSize: vi.fn((value, width) => {
            const perLine = Math.max(1, Math.floor(width / (size * 0.05)));
            const chunks = [];
            for (let index = 0; index < value.length; index += perLine) {
                chunks.push(value.slice(index, index + perLine));
            }
            return chunks;
        }),
    };
}

/**
 * Build rows of a fixed height.
 * @param {number} count - Row count
 * @param {number} height - Height of each row
 * @returns {Array<{height: number}>} Rows
 */
function rows(count, height) {
    return Array.from({ length: count }, () => ({ height }));
}

const SAMPLE = {
    generatedAt: new Date(2026, 6, 31),
    rangeLabel: "Last 12 months",
    insights: [
        { title: "Mornings win", body: "Your morning posts do better.", accent: "accent-yellow" },
        { title: "Ask questions", body: "Posts that ask questions get replies.", accent: "nonsense" },
    ],
    tip: "Reply within a day.",
    allTime: [
        { label: "Network growth", value: "3.4×" },
        { label: "Outreach initiated", value: "128" },
        { label: "Reply rate", value: "42%" },
    ],
    threads: [
        {
            name: "Ada Lovelace",
            messageCount: 2,
            lastTimestamp: new Date(2026, 5, 2).getTime(),
            messages: [
                { direction: "sent", timestamp: new Date(2026, 5, 1).getTime(), body: "Hello" },
                { direction: "received", timestamp: new Date(2026, 5, 2).getTime(), body: "Hi" },
            ],
        },
    ],
};

/**
 * Build a dashboard in the shape collectExportData() hands one over.
 * @param {string} title - Dashboard heading
 * @param {object} [overrides] - Fields to replace on the result
 * @returns {object} Dashboard
 */
function dashboard(title, overrides = {}) {
    return {
        title,
        subtitle: "Last 12 months",
        stats: [
            { label: "Posts", value: "42" },
            { label: "Comments", value: "18" },
            { label: "Total activity", value: "60" },
            { label: "Peak hour", value: "09:00" },
            { label: "Current streak", value: "3 days" },
            { label: "Longest streak", value: "11 days" },
        ],
        charts: [
            {
                type: "line",
                title: `${title} timeline`,
                points: [
                    { label: "Jan 2026", value: 3 },
                    { label: "Feb 2026", value: 6 },
                ],
            },
            {
                type: "bar",
                title: `${title} topics`,
                items: [{ topic: "Hiring", count: 4 }],
            },
            {
                type: "heatmap",
                title: `${title} hours`,
                grid: Array.from({ length: 7 }, () => new Array(24).fill(1)),
            },
        ],
        ...overrides,
    };
}

/**
 * Build the shape a real activity export takes at the top of its range.
 *
 * Five stat tiles, a year of months, the twelve topics the analytics cap allows,
 * and the heatmap: the dashboard the plot heights used to be tuned against.
 * @param {string} [title] - Dashboard heading
 * @returns {object} Dashboard
 */
function fullActivityDashboard(title = "Activity") {
    return dashboard(title, {
        stats: [
            { label: "Posts", value: "260" },
            { label: "Comments", value: "340" },
            { label: "Total activity", value: "600" },
            { label: "Peak hour", value: "09:00" },
            { label: "Longest streak", value: "11 days" },
        ],
        charts: [
            {
                type: "line",
                title: `${title} timeline`,
                points: Array.from({ length: 12 }, (_, index) => ({
                    label: `Month ${index + 1}`,
                    value: index + 3,
                })),
            },
            {
                type: "bar",
                title: "Top topics",
                items: Array.from({ length: 12 }, (_, index) => ({
                    topic: `Topic ${index + 1}`,
                    count: 12 - index,
                })),
            },
            {
                type: "heatmap",
                title: "When you are active",
                grid: Array.from({ length: 7 }, () =>
                    Array.from({ length: 24 }, (_, hour) => hour % 5),
                ),
            },
        ],
    });
}

describe("page geometry", () => {
    it("describes an A4 page", () => {
        expect(PAGE.width).toBe(210);
        expect(PAGE.height).toBe(297);
        // Concrete values, not the defining expressions: restating those cannot
        // fail while the module compiles.
        expect(CONTENT_WIDTH).toBe(178);
        expect(USABLE_HEIGHT).toBe(257);
    });

    it("converts point sizes to line heights", () => {
        expect(lineHeightMm(12)).toBeCloseTo(5.588, 3);
        expect(lineHeightMm(24)).toBeCloseTo(11.176, 3);
    });

    it("sums row heights", () => {
        expect(totalRowHeight(rows(4, 2.5))).toBe(10);
        expect(totalRowHeight([])).toBe(0);
    });
});

describe("formatLongDate", () => {
    it("formats dates and epoch milliseconds", () => {
        expect(formatLongDate(new Date(2026, 6, 31))).toBe("31 July 2026");
        expect(formatLongDate(new Date(2026, 0, 1).getTime())).toBe("1 January 2026");
    });

    it("returns nothing for an unusable date", () => {
        expect(formatLongDate(Number.NaN)).toBe("");
        expect(formatLongDate(new Date("nope"))).toBe("");
    });
});

describe("text contrast", () => {
    // Read live rather than copied, so a token whose value changes changes the
    // ratios this certifies instead of silently certifying the old ones. In
    // jsdom readPdfPalette() resolves to the built-in light fallbacks, which are
    // the values that end up on paper.
    const LIGHT = readPdfPalette();
    const ACCENTS = ["blue", "yellow", "red", "green", "purple"];

    it("computes WCAG contrast ratios", () => {
        const white = { r: 255, g: 255, b: 255 };
        const black = { r: 0, g: 0, b: 0 };

        expect(contrastRatio(white, black)).toBeCloseTo(21, 5);
        expect(contrastRatio(white, white)).toBeCloseTo(1, 5);
        // Symmetric, whichever way round the arguments arrive.
        expect(contrastRatio(black, white)).toBeCloseTo(contrastRatio(white, black), 5);
    });

    it("keeps every card title and roundel digit readable on its own accent", () => {
        // Drawing the title in the accent it sits on a tint of gave 1.54:1 on
        // yellow, and the white roundel digit on the raw accent gave 1.71:1.
        for (const name of ACCENTS) {
            const tint = LIGHT[`--accent-${name}-bg`];
            const accent = LIGHT[`--accent-${name}`];

            expect(contrastRatio(readableOn(LIGHT, tint), tint), `${name} title`).toBeGreaterThan(
                4.5,
            );
            expect(
                contrastRatio(readableOn(LIGHT, accent), accent),
                `${name} roundel`,
            ).toBeGreaterThan(4.5);
        }
    });

    it("keeps every direction chip label readable on its own fill", () => {
        for (const fill of [
            LIGHT["--accent-blue-bg"],
            LIGHT["--accent-green-bg"],
            LIGHT["--bg-tertiary"],
        ]) {
            expect(contrastRatio(readableOn(LIGHT, fill), fill)).toBeGreaterThan(4.5);
        }
    });

    it("reverses to the on-accent color when the ink is the worse of the two", () => {
        const ink = { r: 0, g: 0, b: 0 };
        const reversed = { r: 255, g: 255, b: 255 };
        const stub = { "--text-primary": ink, "--text-on-accent": reversed };

        expect(readableOn(stub, { r: 255, g: 255, b: 255 })).toBe(ink);
        expect(readableOn(stub, { r: 0, g: 0, b: 0 })).toBe(reversed);
    });
});

describe("paginateBlocks", () => {
    it("returns no pages for no blocks", () => {
        expect(paginateBlocks([], 100)).toEqual([]);
    });

    it("skips blocks with no rows", () => {
        expect(paginateBlocks([{ rows: [], keepTogether: true }], 100)).toEqual([]);
    });

    it("moves a keepWithNext heading rather than stranding it at the foot", () => {
        // 88 of 100 used, a 10mm heading, then content. The heading alone fits;
        // the heading followed by anything does not.
        const heading = { rows: rows(1, 10), keepTogether: true, keepWithNext: true };
        const pages = paginateBlocks(
            [{ rows: rows(1, 88), keepTogether: true }, heading, { rows: rows(4, 20) }],
            100,
        );

        expect(pages[0]).toHaveLength(1);
        expect(pages[1][0].block).toBe(heading);
        expect(pages[1][0].y).toBe(0);
    });

    it("reserves the whole of a follower that cannot be split", () => {
        // The shape every chart builder emits: a title marked keepWithNext, then
        // a chart that moves as one unit. Reserving one 6.4mm row of a 66mm list
        // reserved nothing, because the list could never start in it: the title
        // stayed at the foot of the page and its ten rows went overleaf.
        const heading = { rows: rows(1, 10), keepTogether: true, keepWithNext: true };
        const list = { rows: rows(10, 6.4), keepTogether: true };
        const pages = paginateBlocks(
            [{ rows: rows(1, 80), keepTogether: true }, heading, list],
            100,
        );

        expect(pages).toHaveLength(2);
        expect(pages[1].map((segment) => segment.block)).toEqual([heading, list]);
    });

    it("reserves only the first row of a follower that flows", () => {
        // A block that can be split needs only the row that will share the page
        // with the heading. Asking for all of it would push short sections onto
        // pages of their own to no purpose.
        const heading = { rows: rows(1, 10), keepTogether: true, keepWithNext: true };
        const flowing = { rows: rows(4, 20) };
        const pages = paginateBlocks(
            [{ rows: rows(1, 70), keepTogether: true }, heading, flowing],
            100,
        );

        expect(pages[0]).toHaveLength(3);
        expect(pages[0][1].block).toBe(heading);
        expect(pages[0][2].rows).toHaveLength(1);
    });

    it("looks past a block with no rows for what it has to keep up with", () => {
        // An empty block is not what follows a heading: a dashboard whose charts
        // all came back empty still leaves its blocks in the list.
        const heading = { rows: rows(1, 10), keepTogether: true, keepWithNext: true };
        const list = { rows: rows(10, 6.4), keepTogether: true };
        const pages = paginateBlocks(
            [{ rows: rows(1, 80), keepTogether: true }, heading, { rows: [] }, list],
            100,
        );

        expect(pages).toHaveLength(2);
        expect(pages[1].map((segment) => segment.block)).toEqual([heading, list]);
    });

    it("keeps a keepWithNext heading in place when its content still fits", () => {
        const heading = { rows: rows(1, 10), keepTogether: true, keepWithNext: true };
        const pages = paginateBlocks(
            [{ rows: rows(1, 50), keepTogether: true }, heading, { rows: rows(1, 20) }],
            100,
        );

        expect(pages).toHaveLength(1);
        expect(pages[0][1].block).toBe(heading);
    });

    it("places a keepWithNext heading with nothing after it like any other block", () => {
        const heading = { rows: rows(1, 10), keepTogether: true, keepWithNext: true };
        const pages = paginateBlocks([{ rows: rows(1, 85), keepTogether: true }, heading], 100);

        expect(pages).toHaveLength(1);
        expect(pages[0][1].block).toBe(heading);
    });

    it("asks only for the first row of a follower taller than any page", () => {
        const heading = { rows: rows(1, 10), keepTogether: true, keepWithNext: true };
        const flowing = { rows: rows(30, 10), keepTogether: true };
        const pages = paginateBlocks(
            [{ rows: rows(1, 70), keepTogether: true }, heading, flowing],
            100,
        );

        expect(pages[0]).toHaveLength(3);
        expect(pages[0][1].block).toBe(heading);
        expect(pages[0][2].rows).toHaveLength(2);
    });

    it("does not loop pages when a heading and its content cannot share one", () => {
        // The pair cannot fit on any page, so the request is dropped rather
        // than retried forever on ever-emptier pages.
        const heading = { rows: rows(1, 60), keepTogether: true, keepWithNext: true };
        const pages = paginateBlocks(
            [{ rows: rows(1, 50), keepTogether: true }, heading, { rows: rows(1, 60) }],
            100,
        );

        expect(pages.length).toBeLessThanOrEqual(3);
        expect(pages.flat().some((segment) => segment.block === heading)).toBe(true);
    });

    it("opens a pageBreakBefore block on fresh paper", () => {
        const dashboardSection = { rows: rows(1, 10), keepTogether: true, pageBreakBefore: true };
        const pages = paginateBlocks(
            [{ rows: rows(1, 10), keepTogether: true }, dashboardSection],
            100,
        );

        expect(pages).toHaveLength(2);
        expect(pages[1][0].block).toBe(dashboardSection);
        expect(pages[1][0].y).toBe(0);
    });

    it("does not break onto a page that is still empty", () => {
        // Every dashboard after the first asks for a page of its own, so a run
        // of sections that turned out to have nothing in them would otherwise
        // leave a blank sheet behind for each one.
        const dashboardSection = { rows: rows(1, 10), keepTogether: true, pageBreakBefore: true };
        const pages = paginateBlocks(
            [
                { rows: [], pageBreakBefore: true },
                { rows: [], pageBreakBefore: true },
                dashboardSection,
            ],
            100,
        );

        expect(pages).toHaveLength(1);
        expect(pages[0][0].block).toBe(dashboardSection);
    });

    it("stacks blocks down one page, honouring spacing", () => {
        const pages = paginateBlocks(
            [
                { rows: rows(1, 10), keepTogether: true, spacingAfter: 5 },
                { rows: rows(1, 10), keepTogether: true },
            ],
            100,
        );

        expect(pages).toHaveLength(1);
        expect(pages[0].map((segment) => segment.y)).toEqual([0, 15]);
    });

    it("moves a card to the next page rather than splitting it", () => {
        const pages = paginateBlocks(
            [
                { rows: rows(1, 60), keepTogether: true },
                { rows: rows(4, 15), keepTogether: true },
            ],
            100,
        );

        expect(pages).toHaveLength(2);
        expect(pages[0]).toHaveLength(1);
        expect(pages[1]).toHaveLength(1);
        expect(pages[1][0].rows).toHaveLength(4);
        expect(pages[1][0].y).toBe(0);
    });

    it("flows a block taller than a page across pages", () => {
        const pages = paginateBlocks([{ rows: rows(30, 10), keepTogether: true }], 100);

        expect(pages).toHaveLength(3);
        expect(pages.map((page) => page[0].rows.length)).toEqual([10, 10, 10]);
        expect(pages.every((page) => page[0].y === 0)).toBe(true);
    });

    it("flows an over-long block that starts mid-page without looping", () => {
        const pages = paginateBlocks(
            [
                { rows: rows(1, 40), keepTogether: true },
                { rows: rows(25, 10), keepTogether: true },
            ],
            100,
        );

        expect(pages).toHaveLength(3);
        expect(pages[0]).toHaveLength(2);
        expect(pages[0][1].rows).toHaveLength(6);
        expect(pages.map((page) => page[page.length - 1].rows.length)).toEqual([6, 10, 9]);
        expect(totalRowHeight(pages.flatMap((page) => page.flatMap((segment) => segment.rows)))).toBe(
            40 + 250,
        );
    });

    it("splits an explicitly breakable block at row boundaries", () => {
        const pages = paginateBlocks([{ rows: rows(15, 10), keepTogether: false }], 100);

        expect(pages).toHaveLength(2);
        expect(pages[0][0].rows).toHaveLength(10);
        expect(pages[1][0].rows).toHaveLength(5);
    });

    it("drops a row taller than the page rather than drawing past it", () => {
        const pages = paginateBlocks([{ rows: rows(1, 500), keepTogether: false }], 100);

        expect(pages).toEqual([]);
    });

    it("never places a row that ends outside the usable area", () => {
        const usableHeight = 100;
        const pages = paginateBlocks(
            [
                { rows: rows(3, 30), keepTogether: false },
                { rows: rows(1, 500), keepTogether: false },
                { rows: rows(4, 45), keepTogether: false },
            ],
            usableHeight,
        );

        for (const page of pages) {
            for (const segment of page) {
                let end = segment.y;
                for (const row of segment.rows) {
                    end += row.height;
                }
                expect(end).toBeLessThanOrEqual(usableHeight);
            }
        }
        // The 500mm row is gone; every other row survives.
        expect(totalRowHeight(pages.flatMap((page) => page.flatMap((segment) => segment.rows)))).toBe(
            3 * 30 + 4 * 45,
        );
    });
});

describe("buildBlocks", () => {
    /**
     * Render a document model against a stub and hand back the recorded calls.
     * @param {object} data - Document model
     * @returns {{doc: object}} The stub used
     */
    function build(data) {
        const doc = createDocStub();
        renderPdfDocument(doc, data, theme);
        return { doc };
    }

    it("measures a card as its wrapped lines plus padding", () => {
        const doc = createDocStub();
        const painter = createPainter(doc, palette, fonts);

        const short = buildBlocks(painter, { ...SAMPLE, insights: [SAMPLE.insights[0]] });
        const long = buildBlocks(painter, {
            ...SAMPLE,
            insights: [{ ...SAMPLE.insights[0], body: SAMPLE.insights[0].body.repeat(12) }],
        });

        const shortCard = short.find((block) => block.kind === "insight");
        const longCard = long.find((block) => block.kind === "insight");

        expect(shortCard.keepTogether).toBe(true);
        expect(longCard.rows.length).toBeGreaterThan(shortCard.rows.length);
        expect(totalRowHeight(longCard.rows)).toBeGreaterThan(totalRowHeight(shortCard.rows));
        // CARD_PADDING in pdf-document.js: a card's final row is its bottom
        // padding, so a change there fails here intelligibly.
        expect(totalRowHeight(shortCard.rows)).toBeCloseTo(
            totalRowHeight(shortCard.rows.slice(0, -1)) + 3.6,
            6,
        );
    });

    it("orders the blocks the way the document reads", () => {
        const doc = createDocStub();
        const blocks = buildBlocks(createPainter(doc, palette, fonts), SAMPLE);

        expect(blocks.map((block) => block.kind)).toEqual([
            "header",
            "section",
            "insight",
            "insight",
            "tip",
            "section",
            "stats",
            "section",
            "thread-header",
            "message",
            "message",
        ]);
    });

    it("lays the stat grid out two tiles to a row", () => {
        const doc = createDocStub();
        const blocks = buildBlocks(createPainter(doc, palette, fonts), SAMPLE);
        const stats = blocks.find((block) => block.kind === "stats");

        expect(stats.rows).toHaveLength(2);
    });

    it("lays a dashboard's stat grid out three tiles to a row", () => {
        const doc = createDocStub();
        const blocks = buildBlocks(createPainter(doc, palette, fonts), {
            ...SAMPLE,
            dashboards: [dashboard("Activity")],
        });
        const [dashboardStats, allTimeStats] = blocks.filter((block) => block.kind === "stats");

        // Six dashboard tiles at three a row, against three all-time tiles at
        // two: the same builder, told what a section has room for.
        expect(dashboardStats.rows).toHaveLength(2);
        expect(allTimeStats.rows).toHaveLength(2);
    });

    it("fills every row of a dashboard's stat grid", () => {
        // A fixed three columns drew four stats as 3 + 1, leaving two thirds of
        // the second row blank. A tile is the only rounded rectangle the grid
        // draws at radius 2, so counting those in the first row counts columns.
        const expected = { 1: 1, 2: 2, 3: 3, 4: 2, 5: 5, 6: 3, 7: 3 };

        for (const [count, columns] of Object.entries(expected)) {
            const doc = createDocStub();
            const stats = Array.from({ length: Number(count) }, (_, index) => ({
                label: `Stat ${index + 1}`,
                value: String(index + 1),
            }));
            const blocks = buildBlocks(createPainter(doc, palette, fonts), {
                ...SAMPLE,
                dashboards: [dashboard("Activity", { stats })],
            });
            const [grid] = blocks.filter((block) => block.kind === "stats");
            grid.rows[0].draw(0, 0);

            const tiles = doc.calls.roundedRect.filter((args) => args[4] === 2);
            expect(tiles, `${count} stats`).toHaveLength(columns);
            expect(grid.rows, `${count} stats`).toHaveLength(Math.ceil(Number(count) / columns));
        }
    });

    it("steps a stat value down a size rather than running it off the tile", () => {
        // A dashboard tile carries whatever the data says. "Top company" is a
        // company name, and at the headline size a long one crossed into its
        // neighbour.
        const value = "x".repeat(60);
        const doc = createDocStub();
        const stats = [
            { label: "Top company", value },
            { label: "Posts", value: "42" },
            { label: "Comments", value: "18" },
        ];
        renderPdfDocument(doc, { ...SAMPLE, dashboards: [dashboard("Activity", { stats })] }, theme);

        const drawn = doc.calls.text.find((entry) => entry.value === value);
        expect(drawn).toBeDefined();
        expect(drawn.size).toBeLessThan(17);
    });

    it("leaves a stat whose value never arrived blank rather than elided", () => {
        const doc = createDocStub();
        renderPdfDocument(
            doc,
            {
                ...SAMPLE,
                dashboards: [dashboard("Activity", { stats: [{ label: "Top company" }] })],
            },
            theme,
        );

        const drawn = doc.calls.text.map((entry) => entry.value);
        expect(drawn).toContain("Top company");
        expect(drawn).not.toContain("…");
    });

    it("truncates a stat value that fits at no size at all", () => {
        const doc = createDocStub();
        renderPdfDocument(
            doc,
            {
                ...SAMPLE,
                dashboards: [
                    dashboard("Activity", {
                        stats: [
                            { label: "Top company", value: "x".repeat(400) },
                            { label: "Posts", value: "42" },
                            { label: "Comments", value: "18" },
                        ],
                    }),
                ],
            },
            theme,
        );

        const drawn = doc.calls.text.find((entry) => String(entry.value).startsWith("x"));
        expect(drawn.value.endsWith("…")).toBe(true);
        expect(drawn.value.length).toBeLessThan(100);
    });

    it("renders a dashboard's heading, subtitle, stats and charts", () => {
        const { doc } = build({
            ...SAMPLE,
            insights: [],
            tip: null,
            allTime: [],
            threads: [],
            dashboards: [dashboard("Activity")],
        });
        const drawn = doc.calls.text.map((entry) => entry.value);

        expect(drawn).toContain("Activity");
        // The subtitle says which range the charts below it were built at; a
        // heading alone would leave the reader guessing.
        expect(drawn).toContain("Last 12 months");
        expect(drawn).toContain("Total activity");
        expect(drawn).toContain("Activity timeline");
        expect(drawn).toContain("Activity topics");
        expect(drawn).toContain("Activity hours");
    });

    it("opens every dashboard after the first on a page of its own", () => {
        const doc = createDocStub();
        const blocks = buildBlocks(createPainter(doc, palette, fonts), {
            ...SAMPLE,
            insights: [],
            tip: null,
            allTime: [],
            threads: [],
            dashboards: [
                dashboard("Activity"),
                // A dashboard that arrived with only half of itself still counts
                // as a section, and still opens where the reader expects it.
                dashboard("Connections", { charts: undefined }),
                dashboard("Messages", { stats: undefined }),
            ],
        });
        const sections = blocks.filter((block) => block.kind === "section");

        // The first follows the title on page one, the way the site opens on a
        // screen rather than on a cover.
        expect(sections.map((block) => block.pageBreakBefore)).toEqual([false, true, true]);
    });

    it("drops a dashboard whose charts all came back empty", () => {
        const doc = createDocStub();
        const blocks = buildBlocks(createPainter(doc, palette, fonts), {
            ...SAMPLE,
            dashboards: [
                dashboard("Connections", {
                    stats: [],
                    charts: [
                        { type: "line", title: "Connection growth", points: [] },
                        { type: "bar", title: "Top companies", items: [] },
                    ],
                }),
            ],
        });

        expect(blocks.map((block) => block.kind)).not.toContain("line-chart");
        expect(
            blocks.filter((block) => block.kind === "section").map((block) => block.rows.length),
        ).toEqual([1, 1, 1]);
    });

    it("drops a dashboard that counted everything it has as none of it", () => {
        // The rule lives here rather than with whoever collected the data, so
        // every dashboard answers to the same one. The messages dashboard used
        // to print a page of zeroes.
        const doc = createDocStub();
        const empty = dashboard("Messages", {
            stats: [
                { label: "Messages in range", value: "0" },
                { label: "Reply rate", value: "-" },
                { label: "Busiest hour", value: "" },
                { label: "Threads", value: 0 },
                { label: "Median reply", value: null },
            ],
            charts: [{ type: "list", title: "Top contacts", items: [] }],
        });
        const blocks = buildBlocks(createPainter(doc, palette, fonts), {
            ...SAMPLE,
            insights: [],
            tip: null,
            allTime: [],
            threads: [],
            dashboards: [empty, dashboard("Activity")],
        });
        const sections = blocks.filter((block) => block.kind === "section");

        expect(blocks.map((block) => block.kind)).not.toContain("list");
        // One section, and it opens on page one: the dashboard that had nothing
        // to say does not cost the one after it a page break either.
        expect(sections).toHaveLength(1);
        expect(sections[0].pageBreakBefore).toBe(false);
    });

    it("gives the title company when the first section is not a dashboard", () => {
        // The rule the dashboards answer to governs the sections after them too.
        // Asked unconditionally, "Your insights" broke to page two and left an
        // export with no dashboard printing a page holding nothing but a title.
        const doc = createDocStub();
        const pages = paginateBlocks(
            buildBlocks(createPainter(doc, palette, fonts), { ...SAMPLE, dashboards: [] }),
            USABLE_HEIGHT,
        );

        expect(pages[0].map((segment) => segment.block.kind)).toContain("section");
    });

    it("keeps a dashboard where a single stat measured something", () => {
        const doc = createDocStub();
        const blocks = buildBlocks(createPainter(doc, palette, fonts), {
            ...SAMPLE,
            dashboards: [
                dashboard("Messages", {
                    stats: [
                        { label: "Messages in range", value: "0" },
                        { label: "Threads", value: "4" },
                    ],
                    charts: [],
                }),
            ],
        });

        expect(blocks.filter((block) => block.kind === "stats")).toHaveLength(2);
    });

    it("drops a heatmap whose week has no activity in it", () => {
        // The analytics worker always hands over a full week of hours, so an
        // empty heatmap arrives as a 7x24 grid of zeroes rather than as nothing.
        const { doc } = build({
            ...SAMPLE,
            insights: [],
            tip: null,
            allTime: [],
            threads: [],
            dashboards: [
                dashboard("Activity", {
                    charts: [
                        {
                            type: "heatmap",
                            title: "Activity hours",
                            grid: Array.from({ length: 7 }, () => new Array(24).fill(0)),
                        },
                    ],
                }),
            ],
        });
        const drawn = doc.calls.text.map((entry) => entry.value);

        expect(drawn).toContain("Activity");
        expect(drawn).not.toContain("Activity hours");
    });

    it("skips a chart type no builder answers to", () => {
        // A type the layout engine does not know is one chart lost, not the
        // whole export.
        const { doc } = build({
            ...SAMPLE,
            insights: [],
            tip: null,
            allTime: [],
            threads: [],
            dashboards: [
                dashboard("Activity", {
                    charts: [
                        { type: "sunburst", title: "Activity by orbit", items: [{ topic: "A" }] },
                        { type: "bar", title: "Activity topics", items: [{ topic: "B", count: 4 }] },
                    ],
                }),
            ],
        });
        const drawn = doc.calls.text.map((entry) => entry.value);

        expect(drawn).not.toContain("Activity by orbit");
        expect(drawn).toContain("Activity topics");
    });

    it("drops an empty chart while its siblings survive", () => {
        // On screen an empty chart invites an upload; on a page the reader has
        // already exported there is nothing left to invite.
        const { doc } = build({
            ...SAMPLE,
            insights: [],
            tip: null,
            allTime: [],
            threads: [],
            dashboards: [
                dashboard("Messages", {
                    stats: [{ label: "Messages in range", value: "12" }],
                    charts: [
                        {
                            type: "list",
                            title: "Top contacts",
                            items: [{ primary: "Ada Lovelace" }],
                        },
                        { type: "list", title: "Silent connections", items: [] },
                    ],
                }),
            ],
        });
        const drawn = doc.calls.text.map((entry) => entry.value);

        expect(drawn).toContain("Top contacts");
        expect(drawn).toContain("Ada Lovelace");
        expect(drawn).not.toContain("Silent connections");
    });

    it("lets a full dashboard run onto a second page rather than squeezing it", () => {
        // The plot heights used to be tuned down until this shape landed on one
        // page with 2mm to spare. It flows now, like every other section, and
        // the page it runs onto says whose charts these are.
        const doc = createDocStub();
        const data = {
            generatedAt: new Date(2026, 6, 31),
            rangeLabel: "Last 12 months",
            dashboards: [fullActivityDashboard()],
        };
        const pages = paginateBlocks(
            buildBlocks(createPainter(doc, palette, fonts), data),
            USABLE_HEIGHT,
        );
        renderPdfDocument(doc, data, theme);

        expect(pages).toHaveLength(2);
        expect(pages[1][0].block.continuation).toBe("Activity (continued)");
        // No page ends on a chart's title with the chart itself overleaf.
        expect(pages.map((page) => page[page.length - 1].block.kind)).not.toContain("chart-title");
        expect(doc.calls.text.map((entry) => entry.value)).toContain("Activity (continued)");
    });

    it("opens a spilled dashboard's neighbour on fresh paper all the same", () => {
        // Running over is not the same as running on: the next dashboard is
        // still the division a reader navigates by on the site.
        const doc = createDocStub();
        const pages = paginateBlocks(
            buildBlocks(createPainter(doc, palette, fonts), {
                generatedAt: new Date(2026, 6, 31),
                rangeLabel: "Last 12 months",
                dashboards: [fullActivityDashboard(), fullActivityDashboard("Connections")],
            }),
            USABLE_HEIGHT,
        );
        const opening = pages.findIndex(
            (page) => page[0].block.kind === "section" && page[0].block.pageBreakBefore,
        );

        expect(pages).toHaveLength(4);
        expect(opening).toBe(2);
        expect(pages[opening][0].y).toBe(0);
        // Its own second page is headed as its own continuation, not the one
        // before it.
        expect(pages[3][0].block.continuation).toBe("Connections (continued)");
    });

    it("renders a document that has dashboards but no insights", () => {
        const { doc } = build({
            generatedAt: new Date(2026, 6, 31),
            rangeLabel: "Last 12 months",
            dashboards: [dashboard("Activity")],
        });
        const drawn = doc.calls.text.map((entry) => entry.value);

        expect(drawn).toContain("Activity");
        expect(drawn).not.toContain("No insights yet. Upload your LinkedIn export to fill this in.");
    });

    it("emits a placeholder when everything is empty", () => {
        const doc = createDocStub();
        renderPdfDocument(
            doc,
            {
                generatedAt: new Date(2026, 6, 31),
                rangeLabel: "All time",
                insights: [],
                tip: null,
                allTime: [],
                threads: [],
            },
            theme,
        );

        const drawn = doc.calls.text.map((entry) => entry.value);
        expect(drawn).toContain("No insights yet. Upload your LinkedIn export to fill this in.");
        expect(drawn).not.toContain("Your insights");
        expect(drawn).not.toContain("All time");
        expect(drawn).not.toContain("Recent conversations");
    });

    it("tolerates missing collections", () => {
        const doc = createDocStub();
        const pageCount = renderPdfDocument(
            doc,
            { generatedAt: new Date(2026, 6, 31), rangeLabel: "All time" },
            theme,
        );
        const drawn = doc.calls.text.map((entry) => entry.value);

        // A document that drew nothing at all also returns 1, so the header and
        // the placeholder are what say the guards held.
        expect(pageCount).toBe(1);
        expect(drawn).toContain("LinkedIn Insights");
        expect(drawn).toContain("No insights yet. Upload your LinkedIn export to fill this in.");
        expect(drawn).toContain("Page 1 of 1");
    });

    it("still draws the chip for a message with an empty body", () => {
        // LinkedIn exports an attachment-only message with no CONTENT. Without
        // wrap()'s [""] floor the message would contribute no rows at all.
        const { doc } = build({
            ...SAMPLE,
            threads: [
                {
                    name: "Ada Lovelace",
                    messageCount: 1,
                    lastTimestamp: new Date(2026, 5, 2).getTime(),
                    messages: [
                        { direction: "sent", timestamp: new Date(2026, 5, 2).getTime(), body: "" },
                    ],
                },
            ],
        });

        expect(doc.calls.text.map((entry) => entry.value)).toContain("Sent");
    });

    it("draws every section that has data", () => {
        const { doc } = build(SAMPLE);
        const drawn = doc.calls.text.map((entry) => entry.value);

        expect(drawn).toContain("LinkedIn Insights");
        expect(drawn).toContain("Last 12 months  ·  Generated 31 July 2026");
        expect(drawn).toContain("Your insights");
        expect(drawn).toContain("Pip says");
        expect(drawn).toContain("All time");
        expect(drawn).toContain("Recent conversations");
        expect(drawn).toContain("Ada Lovelace");
        expect(drawn).toContain("2 messages  ·  last on 2 June 2026");
        expect(drawn).toContain("Sent");
        expect(drawn).toContain("Received");
        expect(drawn).toContain("Network growth");
        expect(drawn).toContain("3.4×");
        // Include the message bodies, not only the surrounding dialog text. This
        // is the behaviour the whole opt-in exists for.
        expect(drawn).toContain("Hello");
        expect(drawn).toContain("Hi");
    });

    it("numbers each insight in its roundel", () => {
        const { doc } = build(SAMPLE);
        const drawn = doc.calls.text.map((entry) => entry.value);

        expect(doc.calls.circle).toHaveLength(2);
        expect(drawn).toContain("1");
        expect(drawn).toContain("2");
    });

    it("renders every insight, not just the six the screen shows", () => {
        const insights = Array.from({ length: 9 }, (_, index) => ({
            title: `Insight ${index + 1}`,
            body: "Body text.",
            accent: "accent-blue",
        }));
        const doc = createDocStub();
        renderPdfDocument(doc, { ...SAMPLE, insights, threads: [] }, theme);

        const drawn = doc.calls.text.map((entry) => entry.value);
        for (let index = 1; index <= 9; index += 1) {
            expect(drawn).toContain(`Insight ${index}`);
        }
    });

    it("singularizes a one-message thread", () => {
        const doc = createDocStub();
        renderPdfDocument(
            doc,
            {
                ...SAMPLE,
                threads: [
                    {
                        name: "Grace Hopper",
                        messageCount: 1,
                        lastTimestamp: new Date(2026, 5, 2).getTime(),
                        messages: [
                            {
                                direction: "sent",
                                timestamp: new Date(2026, 5, 2).getTime(),
                                body: "Hi",
                            },
                        ],
                    },
                ],
            },
            theme,
        );

        expect(doc.calls.text.map((entry) => entry.value)).toContain(
            "1 message  ·  last on 2 June 2026",
        );
    });

    it("wraps a long thread heading rather than running past the margin", () => {
        // The stub measures at 0.05 mm per character per point of font size, and
        // thread names are drawn at 12.5pt.
        const maxChars = Math.floor(CONTENT_WIDTH / (12.5 * 0.05));
        const headings = [
            "Ada Lovelace ".repeat(60).trim(),
            `https://www.linkedin.com/in/${"a-very-long-vanity-name".repeat(20)}`,
        ];

        for (const name of headings) {
            const doc = createDocStub();
            renderPdfDocument(
                doc,
                {
                    ...SAMPLE,
                    insights: [],
                    tip: null,
                    allTime: [],
                    threads: [
                        {
                            name,
                            messageCount: 1,
                            lastTimestamp: new Date(2026, 5, 2).getTime(),
                            messages: [],
                        },
                    ],
                },
                theme,
            );

            const drawnName = doc.calls.text
                .map((entry) => String(entry.value))
                .filter((value) => name.includes(value));
            expect(drawnName.length).toBeGreaterThan(1);
            expect(drawnName.join("")).toBe(name);
            for (const line of doc.calls.text) {
                expect(String(line.value).length).toBeLessThanOrEqual(maxChars);
            }
        }
    });

    it("draws a neutral chip when the direction is unknown", () => {
        const doc = createDocStub();
        renderPdfDocument(
            doc,
            {
                ...SAMPLE,
                threads: [
                    {
                        name: "Ada Lovelace",
                        messageCount: 1,
                        lastTimestamp: new Date(2026, 5, 2).getTime(),
                        messages: [
                            {
                                direction: "unknown",
                                timestamp: new Date(2026, 5, 2).getTime(),
                                body: "Hi",
                            },
                        ],
                    },
                ],
            },
            theme,
        );

        const drawn = doc.calls.text.map((entry) => entry.value);
        expect(drawn).toContain("Message");
        expect(drawn).not.toContain("Sent");
        expect(drawn).not.toContain("Received");
    });

    it("tolerates a thread with no messages array", () => {
        const doc = createDocStub();
        renderPdfDocument(
            doc,
            {
                ...SAMPLE,
                threads: [{ name: "Nobody", messageCount: 0, lastTimestamp: 0 }],
            },
            theme,
        );

        expect(doc.calls.text.map((entry) => entry.value)).toContain("Nobody");
    });
});

describe("renderPdfDocument", () => {
    it("paints one page background and footer per page", () => {
        const doc = createDocStub();
        // This sample has no dashboards, so insights are the first thing placed
        // and share page one with the title; conversations then open a page of
        // their own.
        const pageCount = renderPdfDocument(doc, SAMPLE, theme);

        expect(pageCount).toBe(2);
        expect(doc.addPage).toHaveBeenCalledTimes(1);
        expect(doc.calls.text.filter((entry) => entry.value === "Page 1 of 2")).toHaveLength(1);
        expect(doc.calls.text.filter((entry) => entry.value === "Page 2 of 2")).toHaveLength(1);
        expect(
            doc.calls.rect.filter((args) => args[2] === PAGE.width && args[3] === PAGE.height),
        ).toHaveLength(2);
    });

    it("heads a page that opens part way through a dashboard", () => {
        const doc = createDocStub();
        renderPdfDocument(
            doc,
            {
                generatedAt: new Date(2026, 6, 31),
                rangeLabel: "Last 12 months",
                dashboards: [fullActivityDashboard()],
            },
            theme,
        );
        const heads = doc.calls.text.filter((entry) => entry.value === "Activity (continued)");

        // Once, on the page that carries the rest: the page that announced the
        // section keeps the heading itself.
        expect(heads).toHaveLength(1);
        expect(doc.calls.text.map((entry) => entry.value)).toContain("Activity");
        // Drawn into the top margin the way the footer is drawn into the bottom
        // one, so pagination does not have to reserve room for a block whose
        // page it cannot know until the placing is done.
        expect(heads[0].y).toBeLessThan(PAGE.marginTop);
    });

    it("wraps a message longer than a page across pages and numbers them", () => {
        const doc = createDocStub();
        const pageCount = renderPdfDocument(
            doc,
            {
                ...SAMPLE,
                insights: [],
                tip: null,
                allTime: [],
                threads: [
                    {
                        name: "Ada Lovelace",
                        messageCount: 1,
                        lastTimestamp: new Date(2026, 5, 2).getTime(),
                        messages: [
                            {
                                direction: "received",
                                timestamp: new Date(2026, 5, 2).getTime(),
                                body: "word ".repeat(6000),
                            },
                        ],
                    },
                ],
            },
            theme,
        );

        expect(pageCount).toBeGreaterThan(1);
        expect(doc.addPage).toHaveBeenCalledTimes(pageCount - 1);
        const footers = doc.calls.text.filter((entry) => String(entry.value).startsWith("Page "));
        expect(footers).toHaveLength(pageCount);
        expect(footers[0].value).toBe(`Page 1 of ${pageCount}`);
        expect(footers[pageCount - 1].value).toBe(`Page ${pageCount} of ${pageCount}`);
    });

    it("never draws content past the bottom margin", () => {
        const doc = createDocStub();
        renderPdfDocument(
            doc,
            {
                ...SAMPLE,
                insights: Array.from({ length: 12 }, (_, index) => ({
                    title: `Insight ${index + 1}`,
                    body: "A reasonably wordy body that will wrap onto several lines. ".repeat(4),
                    accent: "accent-purple",
                })),
            },
            theme,
        );

        const bodyText = doc.calls.text.filter(
            (entry) => !String(entry.value).startsWith("Page ") && entry.value !== "LinkedIn Analyzer",
        );
        expect(bodyText.every((entry) => entry.y <= PAGE.height - PAGE.marginBottom + 1)).toBe(true);
        expect(bodyText.every((entry) => entry.y >= PAGE.marginTop)).toBe(true);
    });
});
