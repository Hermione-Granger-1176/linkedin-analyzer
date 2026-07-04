/**
 * Vitest unit tests for the sketch-style upload progress overlay controller.
 *
 * UploadProgress was extracted from upload.js. It owns its own DOM refs and an
 * animation loop, so the module is re-imported per test after the overlay DOM
 * and a mocked canvas are in place, and requestAnimationFrame is stubbed so the
 * loop can be driven deterministically.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockCanvasContext } from "./helpers/dom.js";

let UploadProgress;
let rafCallbacks;

/**
 * Run and clear the currently queued animation-frame callbacks.
 * @param {number} timestamp - Timestamp handed to each callback
 */
function flushFrame(timestamp) {
    const callbacks = rafCallbacks;
    rafCallbacks = [];
    callbacks.forEach((callback) => callback(timestamp));
}

/** Let queued microtask callbacks (animation completions) run. */
async function flushMicrotasks() {
    await Promise.resolve();
    await Promise.resolve();
}

/**
 * Install the overlay DOM with a mocked canvas of the given size.
 * @param {{ width?: number, height?: number }} [size] - Canvas rect size
 */
function setupOverlayDom({ width = 300, height = 60 } = {}) {
    document.body.innerHTML = `
        <div id="progressOverlay" hidden>
            <canvas id="progressCanvas"></canvas>
            <span id="progressPercent"></span>
        </div>`;
    const canvas = document.getElementById("progressCanvas");
    canvas.getContext = vi.fn(() => createMockCanvasContext());
    canvas.getBoundingClientRect = () => ({
        width,
        height,
        left: 0,
        top: 0,
        right: width,
        bottom: height,
    });
    return canvas;
}

describe("UploadProgress", () => {
    beforeEach(() => {
        vi.resetModules();
        rafCallbacks = [];
        vi.stubGlobal("requestAnimationFrame", (callback) => {
            rafCallbacks.push(callback);
            return rafCallbacks.length;
        });
        vi.stubGlobal("cancelAnimationFrame", () => {});
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        document.body.innerHTML = "";
    });

    /** Import the controller after the overlay DOM is in place. */
    async function loadController() {
        ({ UploadProgress } = await import("../src/upload-progress.js"));
    }

    it("reveals the overlay and updates the percent label on show", async () => {
        setupOverlayDom();
        await loadController();

        UploadProgress.show(() => true);
        expect(document.getElementById("progressOverlay").hidden).toBe(false);

        flushFrame(performance.now() + 5000);
        await flushMicrotasks();
        // The crawl continues while jobs are active, so a frame stays queued.
        expect(rafCallbacks.length).toBeGreaterThan(0);
        expect(document.getElementById("progressPercent").textContent).toMatch(/%$/);
    });

    it("does not crawl once show reports no active jobs", async () => {
        setupOverlayDom();
        await loadController();

        UploadProgress.show(() => false);
        flushFrame(performance.now() + 5000);
        await flushMicrotasks();
        expect(rafCallbacks.length).toBe(0);
    });

    it("treats a non-function predicate as no active jobs", async () => {
        setupOverlayDom();
        await loadController();

        expect(() => UploadProgress.show(undefined)).not.toThrow();
        flushFrame(performance.now() + 5000);
        await flushMicrotasks();
        expect(rafCallbacks.length).toBe(0);
    });

    it("hides the overlay after animating to completion", async () => {
        setupOverlayDom();
        await loadController();

        UploadProgress.show(() => false);
        flushFrame(performance.now() + 5000);
        await flushMicrotasks();

        UploadProgress.hide();
        flushFrame(performance.now() + 5000);
        await flushMicrotasks();
        expect(document.getElementById("progressOverlay").hidden).toBe(true);
    });

    it("hide is a no-op when the overlay is already hidden", async () => {
        setupOverlayDom();
        await loadController();
        expect(() => UploadProgress.hide()).not.toThrow();
        expect(document.getElementById("progressOverlay").hidden).toBe(true);
    });

    it("clamps and draws incremental progress updates", async () => {
        setupOverlayDom();
        await loadController();

        UploadProgress.reportPercent(0.5);
        expect(document.getElementById("progressPercent").textContent).toBe("49%");

        // A sub-threshold change still redraws but keeps the last reported mark.
        UploadProgress.reportPercent(0.505);
        expect(document.getElementById("progressPercent").textContent).toBe("49%");

        // Out-of-range input is clamped into [0, 1].
        UploadProgress.reportPercent(5);
        expect(document.getElementById("progressPercent").textContent).toBe("98%");
    });

    it("redraw repaints at the current value without error", async () => {
        setupOverlayDom();
        await loadController();
        UploadProgress.reportPercent(0.3);
        expect(() => UploadProgress.redraw()).not.toThrow();
        expect(document.getElementById("progressPercent").textContent).toBe("29%");
    });

    it("skips drawing when the canvas has no measured size", async () => {
        const canvas = setupOverlayDom({ width: 0, height: 0 });
        await loadController();
        UploadProgress.redraw();
        expect(canvas.getContext).not.toHaveBeenCalled();
        expect(document.getElementById("progressPercent").textContent).toBe("");
    });

    it("show is a no-op when the overlay element is absent", async () => {
        document.body.innerHTML = "";
        await loadController();
        expect(() => UploadProgress.show(() => true)).not.toThrow();
    });
});
