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
    const { canvas } = createCanvas({ width: 300, height: 200 });
    canvas.id = "roughCanvas";
    document.body.appendChild(canvas);
    return canvas;
}

/** @type {Array<FrameRequestCallback>} */
let frames = [];
/** @type {typeof window.requestAnimationFrame} */
let realRequestAnimationFrame;

/**
 * Run every frame the module has booked so far.
 * @returns {void}
 */
function runFrames() {
    const queued = frames;
    frames = [];
    queued.forEach((callback) => callback(0));
}

describe("initDecorations", () => {
    beforeEach(async () => {
        document.body.innerHTML = "";
        frames = [];
        // The resize redraw waits for a frame, and jsdom never paints one, so
        // the queue is drained by hand.
        realRequestAnimationFrame = window.requestAnimationFrame;
        window.requestAnimationFrame = /** @type {typeof window.requestAnimationFrame} */ (
            (callback) => {
                frames.push(callback);
                return frames.length;
            }
        );
        const rough = await import("roughjs/bundled/rough.esm.js");
        rough.default.canvas.mockClear();
    });

    afterEach(() => {
        window.requestAnimationFrame = realRequestAnimationFrame;
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
        expect(rc.circle.mock.calls[0][3]).toMatchObject({
            fillStyle: "solid",
            stroke: "transparent",
        });
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

    it("repaints at the new size when the window is resized", async () => {
        const canvas = mountCanvas();
        initDecorations();

        const rough = await import("roughjs/bundled/rough.esm.js");
        expect(rough.default.canvas).toHaveBeenCalledTimes(1);

        window.innerWidth = 900;
        window.dispatchEvent(new Event("resize"));
        runFrames();

        expect(rough.default.canvas).toHaveBeenCalledTimes(2);
        expect(canvas.width).toBe(900);
    });

    it("repaints once per frame however many resize events arrive", async () => {
        mountCanvas();
        initDecorations();

        const rough = await import("roughjs/bundled/rough.esm.js");
        window.dispatchEvent(new Event("resize"));
        window.dispatchEvent(new Event("resize"));
        window.dispatchEvent(new Event("resize"));

        // The second and third resize land on a frame that is already booked.
        expect(frames).toHaveLength(1);
        runFrames();
        expect(rough.default.canvas).toHaveBeenCalledTimes(2);
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
