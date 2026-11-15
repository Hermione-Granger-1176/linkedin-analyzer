// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EXPORT_FILES } from "../../../scripts/checks/app-preview.mjs";
import {
    budgetProblems,
    oversizedInputs,
    parseArgs,
    summarize,
} from "../../../scripts/checks/browser-bench.mjs";

const MB = 1024 * 1024;

/**
 * A finished run with the given time to Analytics and heap peak.
 * @param {number} analyticsMs - Time from file drop to Analytics showing data
 * @param {number} [peakMb] - Combined heap peak in MiB
 */
function run(analyticsMs, peakMb = 100) {
    const peak = { combined: peakMb * MB, page: 0, workers: 0 };
    return { analyticsMs, peak, exportPeak: { combined: 0, page: 0, workers: 0 } };
}

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
            budgetS: 0,
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
            "--budget-s",
            "8.5",
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
            budgetS: 8.5,
            exportKind: "pdf",
        });
    });

    it("rejects unknown options, missing values, and out-of-range numbers", () => {
        expect(() => parseArgs(["--bogus", "1"])).toThrow(/invalid option/);
        expect(() => parseArgs(["--runs"])).toThrow(/missing value/);
        expect(() => parseArgs(["--runs", "0"])).toThrow(/invalid runs/);
        expect(() => parseArgs(["--cpu", "fast"])).toThrow(/invalid cpu/);
        expect(() => parseArgs(["--export", "csv"])).toThrow(/invalid export/);
        expect(() => parseArgs(["--budget-s", "-1"])).toThrow(/invalid budget_s/);
    });

    it("passes runs within every budget, and applies no budget by default", () => {
        const runs = [run(4000), run(5000), run(6000)];

        expect(budgetProblems(runs, parseArgs([]))).toEqual([]);
        expect(budgetProblems(runs, parseArgs(["--budget-s", "5", "--budget-mb", "200"]))).toEqual(
            [],
        );
    });

    it("fails a median time to Analytics over the time budget", () => {
        const runs = [run(4000), run(6000), run(7000)];

        expect(budgetProblems(runs, parseArgs(["--budget-s", "5"]))).toEqual([
            "analytics-median=6.00s budget=5s",
        ]);
    });

    it("does not fail the time budget on one slow run when the median holds", () => {
        const runs = [run(4000), run(4500), run(30000)];

        expect(budgetProblems(runs, parseArgs(["--budget-s", "5"]))).toEqual([]);
    });

    it("judges the time budget on finished runs only, and reports the unfinished ones", () => {
        const runs = [run(4000), { ...run(Number.NaN), error: "timed out" }];

        expect(budgetProblems(runs, parseArgs(["--budget-s", "5"]))).toEqual([
            "unfinished-runs=1",
        ]);
    });

    it("fails a heap peak over the memory budget alongside a slow median", () => {
        const runs = [run(9000, 350), run(9000, 120), run(9000, 120)];

        expect(budgetProblems(runs, parseArgs(["--budget-s", "5", "--budget-mb", "300"]))).toEqual([
            "peak=350.0MB budget=300MB",
            "analytics-median=9.00s budget=5s",
        ]);
    });

    it("summarizes odd and even sample counts as median and range", () => {
        expect(summarize([3, 1, 2])).toEqual({ median: 2, min: 1, max: 3 });
        expect(summarize([4, 1, 3, 2])).toEqual({ median: 2.5, min: 1, max: 4 });
    });

    it("names the export files over the upload limit", () => {
        const dir = mkdtempSync(join(tmpdir(), "browser-bench-test-"));
        try {
            Object.values(EXPORT_FILES).forEach((name, index) => {
                writeFileSync(join(dir, name), "x".repeat(index * 10));
            });
            expect(oversizedInputs(dir, 15)).toEqual(
                Object.values(EXPORT_FILES)
                    .slice(2)
                    .map((name) => expect.stringMatching(new RegExp(`^${name}=`))),
            );
            expect(oversizedInputs(dir)).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
