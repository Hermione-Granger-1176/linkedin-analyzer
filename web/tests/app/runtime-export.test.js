import { beforeEach, describe, expect, it, vi } from "vitest";

import { initRuntime } from "../../src/app/runtime.js";
import { SketchCharts } from "../../src/shared/ui/charts.js";

vi.mock("../../src/shared/ui/charts.js", () => ({
    SketchCharts: {
        exportPng: vi.fn()
    }
}));

describe("runtime export handler", () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <button class="chart-export-btn" data-export-canvas="chartCanvas" data-export-name="report.png"></button>
            <canvas id="chartCanvas"></canvas>
        `;
        vi.restoreAllMocks();
    });

    it("exports chart on button click", () => {
        initRuntime();
        const button = document.querySelector(".chart-export-btn");
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(SketchCharts.exportPng).toHaveBeenCalledWith(
            document.getElementById("chartCanvas"),
            "report.png"
        );
    });
});
