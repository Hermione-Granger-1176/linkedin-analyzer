import { afterEach, expect, it, vi } from "vitest";

import { createCanvas, createMockCanvasContext } from "../../helpers/dom.js";

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
});

it("redraws resized charts without looping or drawing hidden canvases", async () => {
    let notify;
    const observe = vi.fn();
    vi.stubGlobal(
        "ResizeObserver",
        class {
            constructor(callback) {
                notify = callback;
            }
            observe = observe;
        },
    );
    vi.stubGlobal("devicePixelRatio", 2);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() =>
        createMockCanvasContext(),
    );
    const { SketchCharts } = await import("../../../src/shared/ui/charts.js");
    const { canvas } = createCanvas({ width: 540, height: 320 });
    const grid = Array.from({ length: 7 }, () => Array(24).fill(1));
    SketchCharts.drawHeatmap(canvas, grid);
    expect(observe).toHaveBeenCalledWith(canvas);

    const box = vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
        width: 240.4,
        height: 320,
    });
    notify([{ target: canvas }]);
    expect(canvas.width).toBe(480);
    expect(canvas.height).toBe(640);
    expect(SketchCharts.getItemAt(canvas, 218, 290)).toMatchObject({ day: 6, hour: 23 });

    observe.mockClear();
    notify([{ target: canvas }]);
    expect(observe).not.toHaveBeenCalled();
    box.mockReturnValue({ width: 0, height: 0 });
    notify([{ target: canvas }]);
    expect(canvas.width).toBe(480);
    expect(observe).not.toHaveBeenCalled();

    // A scaled entrance animation must not shrink the backing store.
    Object.defineProperty(canvas, "clientWidth", { value: 300 });
    Object.defineProperty(canvas, "clientHeight", { value: 320 });
    box.mockReturnValue({ width: 291, height: 310.4 });
    notify([{ target: canvas }]);
    expect(canvas.width).toBe(600);
    expect(canvas.height).toBe(640);
});
