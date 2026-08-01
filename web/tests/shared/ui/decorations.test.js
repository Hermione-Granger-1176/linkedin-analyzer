import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initDecorations } from "../../../src/shared/ui/decorations.js";
import { createCanvas, resetDom } from "../../helpers/dom.js";

vi.mock("roughjs/bundled/rough.esm.js", () => ({
    default: {
        canvas: vi.fn(() => ({ circle: vi.fn() })),
    },
}));

/**
 * Mount a decoration canvas the module can find.
 * @returns {HTMLCanvasElement} The mounted canvas
 */
function mountCanvas() {
    const { canvas, ctx } = createCanvas({ width: 300, height: 200 });
    canvas.id = "roughCanvas";
    canvas.getContext = vi.fn(() => ctx);
    document.body.appendChild(canvas);
    return canvas;
}

describe("initDecorations", () => {
    beforeEach(async () => {
        document.body.innerHTML = "";
        const rough = await import("roughjs/bundled/rough.esm.js");
        rough.default.canvas.mockClear();
    });

    afterEach(() => {
        resetDom();
    });

    it("returns early when canvas is missing", async () => {
        initDecorations();
        const rough = await import("roughjs/bundled/rough.esm.js");
        expect(rough.default.canvas).not.toHaveBeenCalled();
    });

    it("returns early when canvas context is null", async () => {
        const canvas = mountCanvas();
        canvas.getContext = vi.fn(() => null);

        initDecorations();
        const rough = await import("roughjs/bundled/rough.esm.js");
        expect(rough.default.canvas).toHaveBeenCalledWith(canvas);
        const rc = rough.default.canvas.mock.results[0].value;
        expect(rc.circle).not.toHaveBeenCalled();
    });

    it("draws chalk outlines on the canvas in the dark theme", async () => {
        const canvas = mountCanvas();
        document.documentElement.setAttribute("data-theme", "dark");

        initDecorations();
        const rough = await import("roughjs/bundled/rough.esm.js");
        const rc = rough.default.canvas.mock.results[0].value;
        expect(rough.default.canvas).toHaveBeenCalledWith(canvas);
        expect(rc.circle).toHaveBeenCalledTimes(3);
        expect(rc.circle.mock.calls[0][3]).toMatchObject({ strokeWidth: 1.8 });
        expect(rc.circle.mock.calls[0][3].fill).toBeUndefined();
    });

    it("draws solid blobs on the canvas in the light theme", async () => {
        mountCanvas();
        document.documentElement.setAttribute("data-theme", "light");

        initDecorations();
        const rough = await import("roughjs/bundled/rough.esm.js");
        const rc = rough.default.canvas.mock.results[0].value;
        expect(rc.circle).toHaveBeenCalledTimes(3);
        expect(rc.circle.mock.calls[0][3]).toMatchObject({ fillStyle: "solid" });
    });

    it("redraws when the theme changes", async () => {
        mountCanvas();
        document.documentElement.setAttribute("data-theme", "light");
        initDecorations();

        const rough = await import("roughjs/bundled/rough.esm.js");
        expect(rough.default.canvas).toHaveBeenCalledTimes(1);

        document.documentElement.setAttribute("data-theme", "dark");
        document.dispatchEvent(new CustomEvent("themechange"));

        expect(rough.default.canvas).toHaveBeenCalledTimes(2);
        const rc = rough.default.canvas.mock.results[1].value;
        expect(rc.circle.mock.calls[0][3]).toMatchObject({ strokeWidth: 1.8 });
    });

    it("registers only one redraw listener however often it is initialized", async () => {
        mountCanvas();
        initDecorations();
        initDecorations();

        const rough = await import("roughjs/bundled/rough.esm.js");
        expect(rough.default.canvas).toHaveBeenCalledTimes(2);

        document.dispatchEvent(new CustomEvent("themechange"));
        expect(rough.default.canvas).toHaveBeenCalledTimes(3);
    });
});
