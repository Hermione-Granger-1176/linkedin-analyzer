import { beforeEach, describe, expect, it, vi } from "vitest";

import { SketchCharts } from "../src/charts.js";
import { initRuntime } from "../src/runtime.js";
import { captureError } from "../src/sentry.js";

vi.mock("../src/sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../src/charts.js", () => ({ SketchCharts: { exportPng: vi.fn() } }));

describe("runtime", () => {
    beforeEach(() => {
        document.body.innerHTML = "";
        vi.restoreAllMocks();
        vi.clearAllMocks();
    });

    it("creates error banner on error", () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        initRuntime();
        const error = new Error("boom");
        window.dispatchEvent(new ErrorEvent("error", { error }));
        expect(captureError).toHaveBeenCalledWith(error, {
            module: "runtime",
            operation: "global-error",
        });
        const banner = document.getElementById("globalErrorBanner");
        expect(banner).toBeTruthy();
        expect(banner.hidden).toBe(false);
    });

    it("handles promise rejection", () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        initRuntime();
        const event = new Event("unhandledrejection");
        const reason = { private: "rejection value" };
        Object.defineProperty(event, "reason", { value: reason });
        window.dispatchEvent(event);
        expect(captureError).toHaveBeenCalledWith(reason, {
            module: "runtime",
            operation: "unhandled-rejection",
        });
        const banner = document.getElementById("globalErrorBanner");
        expect(banner).toBeTruthy();
    });

    it("dismisses banner on button click", () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        initRuntime();
        window.dispatchEvent(new ErrorEvent("error", { error: new Error("boom") }));
        const banner = document.getElementById("globalErrorBanner");
        const dismiss = banner.querySelectorAll("button")[1];
        dismiss.click();
        expect(banner.hidden).toBe(true);
    });

    it("ignores export click when canvas missing", () => {
        document.body.innerHTML =
            '<button class="chart-export-btn" data-export-canvas="missing"></button>';
        initRuntime();
        document
            .querySelector(".chart-export-btn")
            .dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(SketchCharts.exportPng).not.toHaveBeenCalled();
    });

    it("ignores an export click when the export canvas id is empty", () => {
        // A button with an empty data-export-canvas attribute has a falsy canvasId,
        // so the export handler returns early before looking up the canvas.
        document.body.innerHTML =
            '<button class="chart-export-btn" data-export-canvas=""></button>';
        initRuntime();
        document
            .querySelector(".chart-export-btn")
            .dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(SketchCharts.exportPng).not.toHaveBeenCalled();
    });

    it("calls exportPng when a valid export button with a canvas is clicked", () => {
        const canvas = document.createElement("canvas");
        canvas.id = "myCanvas";
        document.body.appendChild(canvas);

        const btn = document.createElement("button");
        btn.className = "chart-export-btn";
        btn.dataset.exportCanvas = "myCanvas";
        btn.dataset.exportName = "my-chart.png";
        document.body.appendChild(btn);

        initRuntime();
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));

        expect(SketchCharts.exportPng).toHaveBeenCalledWith(canvas, "my-chart.png");
    });

    it("handleError shows the banner when the error event has no error property", () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        initRuntime();
        // Dispatch an error event without an .error property: the handler falls back
        // to the event itself and still shows the banner.
        const event = new Event("error");
        window.dispatchEvent(event);
        const banner = document.getElementById("globalErrorBanner");
        expect(banner).toBeTruthy();
        expect(banner.hidden).toBe(false);
    });

    it("handleError shows the banner when the error event has a null error value", () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        initRuntime();
        // Dispatch an error event with error=null: the resolved error is falsy, so the
        // console-logging branch is skipped but the banner still shows.
        window.dispatchEvent(new ErrorEvent("error", { error: null }));
        const banner = document.getElementById("globalErrorBanner");
        expect(banner).toBeTruthy();
        expect(banner.hidden).toBe(false);
    });

    it("handleRejection shows the banner when the rejection has no reason", () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        initRuntime();
        // An unhandledrejection event with no .reason property skips console logging
        // but still shows the banner.
        const event = new Event("unhandledrejection");
        window.dispatchEvent(event);
        const banner = document.getElementById("globalErrorBanner");
        expect(banner).toBeTruthy();
        expect(banner.hidden).toBe(false);
    });

    it("createBanner falls back to documentElement when body is null", () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const originalBody = document.body;
        Object.defineProperty(document, "body", { value: null, configurable: true });
        initRuntime();
        // Trigger error to call createBanner
        window.dispatchEvent(new ErrorEvent("error", { error: new Error("no-body") }));
        // Restore body
        Object.defineProperty(document, "body", { value: originalBody, configurable: true });
        const banner = document.getElementById("globalErrorBanner");
        expect(banner).toBeTruthy();
    });

    it("invokes the reload handler when the Reload button is clicked", () => {
        // jsdom cannot actually navigate, so it reports the reload attempt to the
        // virtual console; swallow that here. Clicking still runs the handler.
        vi.spyOn(console, "error").mockImplementation(() => {});
        initRuntime();
        window.dispatchEvent(new ErrorEvent("error", { error: new Error("boom") }));
        const banner = document.getElementById("globalErrorBanner");
        const reloadBtn = banner.querySelectorAll("button")[0];
        expect(reloadBtn.textContent).toBe("Reload");
        expect(() => reloadBtn.click()).not.toThrow();
    });

    it("uses the default filename when data-export-name is absent", () => {
        const canvas = document.createElement("canvas");
        canvas.id = "defaultCanvas";
        document.body.appendChild(canvas);

        const btn = document.createElement("button");
        btn.className = "chart-export-btn";
        btn.dataset.exportCanvas = "defaultCanvas";
        // intentionally no data-export-name attribute
        document.body.appendChild(btn);

        initRuntime();
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));

        expect(SketchCharts.exportPng).toHaveBeenCalledWith(canvas, "chart.png");
    });
});
