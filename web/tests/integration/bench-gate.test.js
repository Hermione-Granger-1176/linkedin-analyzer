import { describe, expect, it } from "vitest";

import {
    MIN_GATED_MS,
    TOTAL_STAGE,
    formatVerdicts,
    judgeRun,
    judgeStage,
    stagesToConfirm,
} from "../../../scripts/checks/bench-gate.mjs";

/**
 * Samples whose fastest rounds are the given values, padded with slower rounds.
 * @param {number} base - Fastest base round
 * @param {number} control - Fastest control round
 * @param {number} head - Fastest head round
 */
function samples(base, control, head) {
    const pad = (fastest) => [fastest * 1.3, fastest, fastest * 1.1];
    return { base: pad(base), control: pad(control), head: pad(head) };
}

describe("bench gate", () => {
    it("passes identical timings as unchanged", () => {
        const verdict = judgeStage("compute", samples(100, 100, 100), 0.1);

        expect(verdict).toMatchObject({ change: 0, noise: 0, allowance: 0.1, status: "same" });
    });

    it("judges each side by its fastest round, so slow outliers do not count", () => {
        const verdict = judgeStage(
            "compute",
            { base: [100, 400], control: [100, 100], head: [100, 900] },
            0.1,
        );

        expect(verdict.status).toBe("same");
    });

    it("fails a slowdown beyond the threshold when the control shows no noise", () => {
        const verdict = judgeStage("compute", samples(100, 100, 120), 0.1);

        expect(verdict.status).toBe("regression");
        expect(verdict.change).toBeCloseTo(0.2);
    });

    it("widens the allowance by the noise the control measured", () => {
        // The control drifted 8%, so a 15% slowdown stays within 10% + 8%.
        const verdict = judgeStage("compute", samples(100, 108, 115), 0.1);

        expect(verdict.allowance).toBeCloseTo(0.18);
        expect(verdict.status).toBe("slower");
    });

    it("counts control drift in either direction as noise", () => {
        const verdict = judgeStage("compute", samples(100, 92, 115), 0.1);

        expect(verdict.noise).toBeCloseTo(0.08);
        expect(verdict.status).toBe("slower");
    });

    it("reports a faster head beyond the noise as faster", () => {
        expect(judgeStage("compute", samples(100, 101, 80), 0.1).status).toBe("faster");
    });

    it("reports but never fails a stage too short to time reliably", () => {
        const short = MIN_GATED_MS / 2;
        const verdict = judgeStage("buildView", samples(short, short, short * 2), 0.1);

        expect(verdict.gated).toBe(false);
        expect(verdict.status).toBe("slower");
    });

    it("adds a total over the gated stages and flags the run when any stage regresses", () => {
        const run = judgeRun(
            {
                clean: samples(100, 100, 100),
                compute: samples(100, 100, 130),
                buildView: samples(1, 1, 1),
            },
            0.1,
        );

        expect(run.verdicts.map((verdict) => verdict.stage)).toEqual([
            "clean",
            "compute",
            "buildView",
            TOTAL_STAGE,
        ]);
        // The total covers clean and compute only: 200 ms became 230 ms.
        expect(run.verdicts.at(-1)?.change).toBeCloseTo(0.15);
        expect(run.regressed).toBe(true);
    });

    it("leaves out the total when judging a subset of stages", () => {
        const run = judgeRun({ compute: samples(100, 100, 100) }, 0.1, { total: false });

        expect(run.verdicts.map((verdict) => verdict.stage)).toEqual(["compute"]);
        expect(run.regressed).toBe(false);
    });

    it("retimes only the regressed stages when the total held", () => {
        const { verdicts } = judgeRun(
            {
                clean: samples(100, 100, 100),
                compute: samples(1000, 1000, 1300),
                // Large enough that the total moves only 6100 ms to 6400 ms, under 10%.
                decode: samples(5000, 5000, 5000),
            },
            0.1,
        );

        expect(stagesToConfirm(verdicts)).toEqual({ names: ["compute"], total: false });
    });

    it("retimes every gated stage when the total regressed", () => {
        const { verdicts } = judgeRun(
            {
                clean: samples(100, 100, 125),
                compute: samples(100, 100, 125),
                buildView: samples(1, 1, 1),
            },
            0.1,
        );

        expect(stagesToConfirm(verdicts)).toEqual({ names: ["clean", "compute"], total: true });
    });

    it("renders a Markdown table with the threshold and every verdict", () => {
        const { verdicts } = judgeRun(
            { compute: samples(100, 100, 120), buildView: samples(1, 1, 1) },
            0.1,
        );
        const table = formatVerdicts(verdicts, 0.1);

        expect(table).toContain("Threshold: 10% beyond the control's measured noise.");
        expect(table).toContain(
            "| compute | 100.0 | 120.0 | +20.0% | ±0.0% | > +10.0% | regression |",
        );
        expect(table).toContain("| buildView | 1.0 | 1.0 | +0.0% | ±0.0% | not gated | same |");
    });
});
