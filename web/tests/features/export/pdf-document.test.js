import { describe, expect, it, vi } from "vitest";

import {
    CONTENT_WIDTH,
    PAGE,
    USABLE_HEIGHT,
    buildBlocks,
    createPainter,
    formatLongDate,
    lineHeightMm,
    contrastRatio,
    paginateBlocks,
    readableOn,
    renderPdfDocument,
    totalRowHeight,
} from "../../../src/features/export/pdf-document.js";

const PALETTE_TOKENS = [
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
    "--text-on-accent",
];

const palette = Object.fromEntries(
    PALETTE_TOKENS.map((token, index) => [token, { r: index, g: index, b: index }]),
);
const fonts = { body: "PatrickHand", accent: "Caveat", embedded: true };
const theme = { palette, fonts };

/**
 * Build a jsPDF stub with deterministic text measurement.
 * @returns {object} Stub document
 */
function createDocStub() {
    let size = 10;
    const calls = { text: [], addPage: 0, rect: [], roundedRect: [], circle: [] };

    return {
        calls,
        setFont: vi.fn(),
        setFontSize: vi.fn((value) => {
            size = value;
        }),
        setTextColor: vi.fn(),
        setFillColor: vi.fn(),
        setDrawColor: vi.fn(),
        rect: vi.fn((...args) => calls.rect.push(args)),
        roundedRect: vi.fn((...args) => calls.roundedRect.push(args)),
        circle: vi.fn((...args) => calls.circle.push(args)),
        addPage: vi.fn(() => {
            calls.addPage += 1;
        }),
        text: vi.fn((value, x, y) => calls.text.push({ value, x, y })),
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
        { label: "Network growth", value: "3.4x" },
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

describe("page geometry", () => {
    it("describes an A4 page", () => {
        expect(PAGE.width).toBe(210);
        expect(PAGE.height).toBe(297);
        expect(CONTENT_WIDTH).toBe(210 - PAGE.marginX * 2);
        expect(USABLE_HEIGHT).toBe(297 - PAGE.marginTop - PAGE.marginBottom);
    });

    it("converts point sizes to line heights", () => {
        expect(lineHeightMm(12)).toBeCloseTo(12 * (25.4 / 72) * 1.32, 6);
        expect(lineHeightMm(24)).toBeCloseTo(lineHeightMm(12) * 2, 6);
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
    // The real light-theme values, so the ratios below are the ones that end up
    // on paper rather than ones the synthetic test palette happens to produce.
    const LIGHT = {
        "--text-primary": { r: 28, g: 25, b: 23 },
        "--text-on-accent": { r: 255, g: 255, b: 255 },
        "--bg-tertiary": { r: 255, g: 248, b: 230 },
        "--accent-blue": { r: 66, g: 133, b: 244 },
        "--accent-blue-bg": { r: 240, g: 243, b: 247 },
        "--accent-yellow": { r: 251, g: 188, b: 5 },
        "--accent-yellow-bg": { r: 254, g: 243, b: 211 },
        "--accent-red": { r: 249, g: 74, b: 54 },
        "--accent-red-bg": { r: 254, g: 235, b: 228 },
        "--accent-green": { r: 41, g: 181, b: 113 },
        "--accent-green-bg": { r: 223, g: 242, b: 227 },
        "--accent-purple": { r: 155, g: 81, b: 224 },
        "--accent-purple-bg": { r: 245, g: 236, b: 245 },
    };
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

        expect(pageCount).toBe(1);
    });

    it("draws every section that has data", () => {
        const { doc } = build(SAMPLE);
        const drawn = doc.calls.text.map((entry) => entry.value);

        expect(drawn).toContain("LinkedIn Insights");
        expect(drawn).toContain("Last 12 months  ·  Generated 31 July 2026");
        expect(drawn).toContain("Your insights");
        expect(drawn).toContain("Pro tip");
        expect(drawn).toContain("All time");
        expect(drawn).toContain("Recent conversations");
        expect(drawn).toContain("Ada Lovelace");
        expect(drawn).toContain("2 messages  ·  last on 2 June 2026");
        expect(drawn).toContain("Sent");
        expect(drawn).toContain("Received");
        expect(drawn).toContain("Network growth");
        expect(drawn).toContain("3.4x");
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
        const pageCount = renderPdfDocument(doc, SAMPLE, theme);

        expect(pageCount).toBe(1);
        expect(doc.addPage).not.toHaveBeenCalled();
        expect(doc.calls.text.filter((entry) => entry.value === "Page 1 of 1")).toHaveLength(1);
        expect(doc.calls.rect.some((args) => args[2] === PAGE.width && args[3] === PAGE.height)).toBe(
            true,
        );
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
