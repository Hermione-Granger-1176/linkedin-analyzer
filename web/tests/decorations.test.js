import { beforeEach, describe, expect, it, vi } from "vitest";

import { initDecorations } from "../src/decorations.js";

import { createCanvas } from "./helpers/dom.js";

vi.mock("roughjs/bundled/rough.esm.js", () => ({
    default: {
        canvas: vi.fn(() => ({ circle: vi.fn() })),
    },
}));

describe("initDecorations", () => {
    beforeEach(async () => {
        document.body.innerHTML = "";
        const rough = await import("roughjs/bundled/rough.esm.js");
        rough.default.canvas.mockClear();
    });

    it("returns early when canvas is missing", async () => {
        initDecorations();
        const rough = await import("roughjs/bundled/rough.esm.js");
        expect(rough.default.canvas).not.toHaveBeenCalled();
    });

    it("returns early when canvas context is null", async () => {
        const { canvas } = createCanvas({ width: 300, height: 200 });
        canvas.id = "roughCanvas";
        canvas.getContext = vi.fn(() => null);
        document.body.appendChild(canvas);

        initDecorations();
        const rough = await import("roughjs/bundled/rough.esm.js");
        expect(rough.default.canvas).toHaveBeenCalledWith(canvas);
        const rc = rough.default.canvas.mock.results[0].value;
        expect(rc.circle).not.toHaveBeenCalled();
    });

    it("draws rough circles on the canvas", async () => {
        const { canvas, ctx } = createCanvas({ width: 300, height: 200 });
        canvas.id = "roughCanvas";
        canvas.getContext = vi.fn(() => ctx);
        document.body.appendChild(canvas);
        document.documentElement.setAttribute("data-theme", "dark");

        initDecorations();
        const rough = await import("roughjs/bundled/rough.esm.js");
        const rc = rough.default.canvas.mock.results[0].value;
        expect(rough.default.canvas).toHaveBeenCalledWith(canvas);
        expect(rc.circle).toHaveBeenCalledTimes(3);
    });
});
