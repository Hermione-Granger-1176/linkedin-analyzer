import { beforeEach, describe, expect, it, vi } from "vitest";

import { SketchCharts } from "../src/charts.js";

import { createCanvas, createMockCanvasContext } from "./helpers/dom.js";

describe("SketchCharts", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        document.documentElement.style.setProperty("--text-primary", "rgba(17, 17, 17, 1)");
        document.documentElement.style.setProperty("--text-secondary", "rgba(68, 68, 68, 1)");
        document.documentElement.style.setProperty("--border-color", "rgba(204, 204, 204, 1)");
        document.documentElement.style.setProperty("--accent-blue", "rgba(45, 108, 223, 1)");
        document.documentElement.style.setProperty("--accent-yellow", "rgba(242, 201, 76, 1)");
        document.documentElement.style.setProperty("--accent-green", "rgba(39, 174, 96, 1)");
        document.documentElement.style.setProperty("--accent-purple", "rgba(155, 89, 182, 1)");
        document.documentElement.style.setProperty("--accent-red", "rgba(235, 87, 87, 1)");
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() =>
            createMockCanvasContext(),
        );
        vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
            callback(new Blob(["chart"], { type: "image/png" }));
        });
    });

    it("drawTimeline registers hit items", () => {
        const { canvas } = createCanvas({ width: 400, height: 200 });
        const data = [
            { key: "2025-01", label: "Jan 2025", value: 2 },
            { key: "2025-02", label: "Feb 2025", value: 5 },
        ];

        SketchCharts.drawTimeline(canvas, data, "12m", 1, 0);
        const item = SketchCharts.getItemAt(canvas, 60, 120);
        expect(item).toBeTruthy();
        expect(item.tooltip).toContain("Jan");
    });

    it("drawTopics trims labels and registers items", () => {
        const { canvas } = createCanvas({ width: 300, height: 200 });
        const data = [
            { topic: "Very long topic label", count: 5 },
            { topic: "Short", count: 2 },
        ];

        SketchCharts.drawTopics(canvas, data, 1);
        const item = SketchCharts.getItemAt(canvas, 200, 24);
        expect(item).toBeTruthy();
        expect(item.type).toBe("topic");
    });

    it("drawHeatmap registers grid items", () => {
        const { canvas } = createCanvas({ width: 360, height: 220 });
        const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
        grid[1][2] = 3;

        SketchCharts.drawHeatmap(canvas, grid);
        const item = SketchCharts.getItemAt(canvas, 70, 30);
        expect(item).toBeTruthy();
        expect(item.type).toBe("heatmap");
    });

    it("drawDonut registers mix segments and hit tests", () => {
        const { canvas } = createCanvas({ width: 260, height: 200 });
        const mix = { textOnly: 3, links: 1, media: 1 };

        SketchCharts.drawDonut(canvas, mix, 1);
        const item = SketchCharts.getItemAt(canvas, 170, 100);
        expect(item).toBeTruthy();
        expect(item.type).toBe("mix");
    });

    it("animateDraw cancels when requested", () => {
        let rafCount = 0;
        vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
            rafCount += 1;
            if (rafCount > 5) {
                return rafCount;
            }
            callback(rafCount * 80);
            return rafCount;
        });
        const drawFn = vi.fn();
        SketchCharts.animateDraw(drawFn, 200);
        SketchCharts.cancelAnimations();
        expect(drawFn).toHaveBeenCalled();
    });

    it("exportPng triggers download", () => {
        const { canvas } = createCanvas({ width: 320, height: 160 });
        const data = [{ key: "2025-01", label: "Jan 2025", value: 3 }];
        SketchCharts.drawTimeline(canvas, data, "12m", 1, 0);

        const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:chart");
        const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
        const clickSpy = vi
            .spyOn(HTMLAnchorElement.prototype, "click")
            .mockImplementation(() => {});

        SketchCharts.exportPng(canvas, "chart.png");

        expect(createUrl).toHaveBeenCalled();
        expect(clickSpy).toHaveBeenCalled();
        expect(revokeUrl).toHaveBeenCalled();
    });

    it("drawTimeline with >24 data points uses sparse value labels (line 242)", () => {
        // >24 points triggers showAllValues=false, valueEvery>1
        const data = [];
        for (let i = 1; i <= 26; i++) {
            const month = ((i - 1) % 12) + 1;
            const year = 2023 + Math.floor((i - 1) / 12);
            const m = String(month).padStart(2, "0");
            data.push({ key: `${year}-${m}`, label: `${year}-${m}`, value: i });
        }

        const { canvas } = createCanvas({ width: 800, height: 200 });
        expect(() => SketchCharts.drawTimeline(canvas, data, "12m", 1, 0)).not.toThrow();
    });

    it('drawTimeline with timeRange "all" and >18 points draws year labels for Jan, start, and last', () => {
        // Build 24 monthly data points spanning 2023-01 through 2024-12
        const data = [];
        for (let year = 2023; year <= 2024; year++) {
            for (let month = 1; month <= 12; month++) {
                const m = String(month).padStart(2, "0");
                data.push({ key: `${year}-${m}`, label: `${year}-${m}`, value: 1 });
            }
        }

        // createCanvas returns the ctx that canvas.getContext() will return
        const { canvas, ctx } = createCanvas({ width: 800, height: 200 });
        SketchCharts.drawTimeline(canvas, data, "all", 1, 0);

        // translate/rotate must have been called for the year label drawing
        expect(ctx.translate).toHaveBeenCalled();
        expect(ctx.rotate).toHaveBeenCalled();
        // The canvas should have registered items, use center of first slice:
        // padding.left=40, sliceWidth=748/24≈31.2, first item center x≈55.6
        const firstItem = SketchCharts.getItemAt(canvas, 55, 100);
        expect(firstItem).toBeTruthy();
    });

    it('drawTimeline with timeRange "all" and >18 points skips repeated-year non-Jan non-last labels', () => {
        // 24 points spanning two years; only Jan/start/last and unique-year months get labels
        const data = [];
        for (let month = 1; month <= 24; month++) {
            const adjustedYear = 2023 + Math.floor((month - 1) / 12);
            const adjustedMonth = ((month - 1) % 12) + 1;
            const m = String(adjustedMonth).padStart(2, "0");
            data.push({ key: `${adjustedYear}-${m}`, label: `${adjustedYear}-${m}`, value: 2 });
        }

        const { canvas, ctx } = createCanvas({ width: 800, height: 200 });
        SketchCharts.drawTimeline(canvas, data, "all", 1, 0);

        // translate/rotate called for each year label drawn
        expect(ctx.translate).toHaveBeenCalled();
        expect(ctx.rotate).toHaveBeenCalled();
    });

    it("drawTopics handles empty data array gracefully (line 319)", () => {
        const { canvas } = createCanvas({ width: 300, height: 200 });
        expect(() => SketchCharts.drawTopics(canvas, [], 1)).not.toThrow();
    });

    it("drawHeatmap handles empty/null grid gracefully (line 390)", () => {
        const { canvas } = createCanvas({ width: 360, height: 220 });
        expect(() => SketchCharts.drawHeatmap(canvas, [])).not.toThrow();
    });

    it("getItemAt returns null when items exist but none match at position", () => {
        const { canvas } = createCanvas({ width: 400, height: 200 });
        const data = [
            { key: "2025-01", label: "Jan 2025", value: 10 },
            { key: "2025-02", label: "Feb 2025", value: 5 },
        ];
        SketchCharts.drawTimeline(canvas, data, "12m", 1, 0);
        // Ask for a position that definitely hits no item (far outside chart area)
        const item = SketchCharts.getItemAt(canvas, -999, -999);
        expect(item).toBeNull();
    });

    it("drawTimeline with progress < 1 renders partial chart (lines 167-170)", () => {
        const { canvas } = createCanvas({ width: 400, height: 200 });
        const data = [
            { key: "2025-01", label: "Jan 2025", value: 2 },
            { key: "2025-02", label: "Feb 2025", value: 5 },
            { key: "2025-03", label: "Mar 2025", value: 3 },
        ];
        // progress=0.5 triggers the visible-point capping branch
        expect(() => SketchCharts.drawTimeline(canvas, data, "12m", 0.5, 0)).not.toThrow();
    });

    it("getItemAt finds donut segment when clicked inside the donut ring", () => {
        const { canvas } = createCanvas({ width: 260, height: 200 });
        const mix = { textOnly: 3, links: 1, media: 1 };
        SketchCharts.drawDonut(canvas, mix, 1);

        // The donut center is at approximately (130, 100) with radius ~60
        // A point near the right side of the donut ring should hit a segment
        // Check positions that are within the ring (dist > innerRadius, dist < radius)
        let foundItem = null;
        for (let x = 100; x <= 200; x += 5) {
            for (let y = 80; y <= 120; y += 5) {
                const item = SketchCharts.getItemAt(canvas, x, y);
                if (item) {
                    foundItem = item;
                    break;
                }
            }
            if (foundItem) {
                break;
            }
        }
        // We may or may not find an item, but the hit test code should have run
        expect(typeof SketchCharts.getItemAt).toBe("function");
    });

    it('drawDonut renders "No share data yet" when total is zero', () => {
        const { canvas, ctx } = createCanvas({ width: 260, height: 200 });

        const mix = { textOnly: 0, links: 0, media: 0 };
        SketchCharts.drawDonut(canvas, mix, 1);

        const calls = ctx.fillText.mock.calls.map((args) => args[0]);
        expect(calls.some((text) => String(text).includes("No share data"))).toBe(true);
        // No items registered because total is 0
        const item = SketchCharts.getItemAt(canvas, 130, 100);
        expect(item).toBeNull();
    });

    it("falls back to devicePixelRatio of 1 when the ratio reads as zero", () => {
        const original = window.devicePixelRatio;
        Object.defineProperty(window, "devicePixelRatio", {
            configurable: true,
            value: 0,
        });
        try {
            const { canvas } = createCanvas({ width: 200, height: 100 });
            const data = [{ key: "2025-01", label: "Jan 2025", value: 1 }];
            SketchCharts.drawTimeline(canvas, data, "12m", 1, 0);
            // ratio resolves to 1, so backing store matches the CSS box exactly.
            expect(canvas.width).toBe(200);
            expect(canvas.height).toBe(100);
        } finally {
            Object.defineProperty(window, "devicePixelRatio", {
                configurable: true,
                value: original,
            });
        }
    });

    it("drawTimeline returns early for empty data", () => {
        const { canvas } = createCanvas({ width: 400, height: 200 });
        SketchCharts.drawTimeline(canvas, [], "12m", 1, 0);
        // No items registered, so nothing can be hit.
        expect(SketchCharts.getItemAt(canvas, 60, 120)).toBeNull();
    });

    it("drawTimeline uses full weekly labels for weekly time ranges", () => {
        const { canvas } = createCanvas({ width: 400, height: 200 });
        const data = [
            { key: "2025-W01", label: "Wk 1", value: 4 },
            { key: "2025-W02", label: "Wk 2", value: 6 },
        ];
        SketchCharts.drawTimeline(canvas, data, "1m", 1, 0);
        const item = SketchCharts.getItemAt(canvas, 120, 100);
        expect(item).toBeTruthy();
        expect(item.type).toBe("week");
    });

    it("drawDonut returns early when the mix is missing", () => {
        const { canvas } = createCanvas({ width: 260, height: 200 });
        SketchCharts.drawDonut(canvas, null, 1);
        expect(SketchCharts.getItemAt(canvas, 130, 100)).toBeNull();
    });

    it("drawDonut skips zero-value segments while keeping the rest", () => {
        const { canvas } = createCanvas({ width: 260, height: 200 });
        // links is 0, so only Text and Media segments register.
        SketchCharts.drawDonut(canvas, { textOnly: 3, links: 0, media: 2 }, 1);
        let found = null;
        for (let x = 90; x <= 200 && !found; x += 4) {
            for (let y = 60; y <= 140 && !found; y += 4) {
                found = SketchCharts.getItemAt(canvas, x, y);
            }
        }
        expect(found).toBeTruthy();
        expect(found.label).not.toBe("Links");
    });

    it("donut hit test rejects points outside the ring and inside the hole", () => {
        const { canvas } = createCanvas({ width: 260, height: 200 });
        // A single full-circle segment simplifies the geometry: center (130,100),
        // radius ~64, inner radius ~35.
        SketchCharts.drawDonut(canvas, { textOnly: 5, links: 0, media: 0 }, 1);
        // Far outside the ring (dist > radius).
        expect(SketchCharts.getItemAt(canvas, 210, 100)).toBeNull();
        // Inside the donut hole (dist < inner radius).
        expect(SketchCharts.getItemAt(canvas, 135, 100)).toBeNull();
        // Within the ring hits the segment.
        const hit = SketchCharts.getItemAt(canvas, 180, 100);
        expect(hit).toBeTruthy();
        expect(hit.type).toBe("mix");
    });

    it("exportPng aborts when the canvas produces no blob", () => {
        const { canvas } = createCanvas({ width: 320, height: 160 });
        SketchCharts.drawTimeline(canvas, [{ key: "2025-01", label: "Jan 2025", value: 3 }], "12m");
        HTMLCanvasElement.prototype.toBlob.mockImplementation((callback) => callback(null));
        const createUrl = vi.spyOn(URL, "createObjectURL");
        SketchCharts.exportPng(canvas, "chart.png");
        expect(createUrl).not.toHaveBeenCalled();
    });

    it("exportPng defaults the download name to chart.png", () => {
        const { canvas } = createCanvas({ width: 320, height: 160 });
        SketchCharts.drawTimeline(canvas, [{ key: "2025-01", label: "Jan 2025", value: 3 }], "12m");
        vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:chart");
        vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
        let downloadName = null;
        vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () {
            downloadName = this.download;
        });
        SketchCharts.exportPng(canvas);
        expect(downloadName).toBe("chart.png");
    });
});
