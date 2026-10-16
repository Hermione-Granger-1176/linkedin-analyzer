// @vitest-environment node
import { describe, expect, it } from "vitest";

import { parseArgs, summarize } from "../../../scripts/checks/browser-bench.mjs";

describe("browser-bench", () => {
    it("defaults to three unthrottled desktop runs with no budget", () => {
        expect(parseArgs([])).toEqual({
            inputDir: "",
            sizeMb: 0,
            runs: 3,
            cpu: 1,
            gpu: true,
            mobile: false,
            budgetMb: 0,
            exportKind: "none",
        });
    });

    it("parses every option", () => {
        const options = parseArgs([
            "--input-dir",
            "/export",
            "--size-mb",
            "55",
            "--runs",
            "5",
            "--cpu",
            "6",
            "--gpu",
            "0",
            "--mobile",
            "1",
            "--budget-mb",
            "300",
            "--export",
            "pdf",
        ]);
        expect(options).toEqual({
            inputDir: "/export",
            sizeMb: 55,
            runs: 5,
            cpu: 6,
            gpu: false,
            mobile: true,
            budgetMb: 300,
            exportKind: "pdf",
        });
    });

    it("rejects unknown options, missing values, and out-of-range numbers", () => {
        expect(() => parseArgs(["--bogus", "1"])).toThrow(/invalid option/);
        expect(() => parseArgs(["--runs"])).toThrow(/missing value/);
        expect(() => parseArgs(["--runs", "0"])).toThrow(/invalid runs/);
        expect(() => parseArgs(["--cpu", "fast"])).toThrow(/invalid cpu/);
        expect(() => parseArgs(["--export", "csv"])).toThrow(/invalid export/);
    });

    it("summarizes odd and even sample counts as median and range", () => {
        expect(summarize([3, 1, 2])).toEqual({ median: 2, min: 1, max: 3 });
        expect(summarize([4, 1, 3, 2])).toEqual({ median: 2.5, min: 1, max: 4 });
    });
});
