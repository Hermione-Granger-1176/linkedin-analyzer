/*
 * Decide whether a benchmark run shows a regression.
 *
 * bench-compare.mjs times three copies of the pipeline in one process: the
 * base commit, an identical copy of the base (the control), and the head.
 * The control measures the noise of this particular run. A stage regresses
 * only when the head is slower than the base by more than the threshold plus
 * that measured noise, so noise alone cannot fail the gate.
 *
 * Each side is judged by its fastest round. These stages are CPU-bound and
 * run after a forced garbage collection, so interference only adds time: the
 * fastest round is the closest to the code's own cost. On a shared machine,
 * identical copies agree to within a few percent on their fastest rounds
 * while their medians drift by ten percent or more. One noisy run can still
 * push a stage over, so the caller times flagged stages again and fails only
 * on a regression that repeats.
 */

/** Stages whose base time is shorter than this are reported, not gated. */
export const MIN_GATED_MS = 5;

/**
 * @typedef {object} StageSamples
 * @property {number[]} base - Base timings in milliseconds
 * @property {number[]} control - Control timings in milliseconds
 * @property {number[]} head - Head timings in milliseconds
 */

/**
 * @typedef {object} StageVerdict
 * @property {string} stage - Stage name
 * @property {number} base - Fastest base round in milliseconds
 * @property {number} control - Fastest control round in milliseconds
 * @property {number} head - Fastest head round in milliseconds
 * @property {number} change - Head change against the base, as a fraction
 * @property {number} noise - Control distance from the base, as a fraction
 * @property {number} allowance - Slowdown allowed before the stage fails
 * @property {boolean} gated - Whether the stage is long enough to gate on
 * @property {"faster"|"same"|"slower"|"regression"} status - Outcome: "slower" is
 * beyond the measured noise but within the allowance, or on a stage too short to gate
 */

/**
 * Judge one stage from its samples.
 * @param {string} stage - Stage name
 * @param {StageSamples} samples - Timings for each side
 * @param {number} threshold - Allowed slowdown beyond noise, as a fraction
 * @returns {StageVerdict}
 */
export function judgeStage(stage, samples, threshold) {
    const base = Math.min(...samples.base);
    const control = Math.min(...samples.control);
    const head = Math.min(...samples.head);
    const change = head / base - 1;
    const noise = Math.abs(control / base - 1);
    const allowance = threshold + noise;
    const gated = base >= MIN_GATED_MS;
    let status;
    if (change > allowance && gated) {
        status = "regression";
    } else if (change > noise) {
        status = "slower";
    } else if (change < -noise) {
        status = "faster";
    } else {
        status = "same";
    }
    return { stage, base, control, head, change, noise, allowance, gated, status };
}

/** Name of the verdict that judges the sum of every gated stage. */
export const TOTAL_STAGE = "total (gated stages)";

/**
 * Judge every stage, plus the total of the gated stages when asked.
 * @param {Record<string, StageSamples>} stages - Timings by stage name
 * @param {number} threshold - Allowed slowdown beyond noise, as a fraction
 * @param {{total?: boolean}} [options] - Set total to false when `stages` is a subset
 * @returns {{verdicts: StageVerdict[], regressed: boolean}}
 */
export function judgeRun(stages, threshold, { total = true } = {}) {
    const verdicts = Object.entries(stages).map(([stage, samples]) =>
        judgeStage(stage, samples, threshold),
    );
    const gatedNames = verdicts.filter((verdict) => verdict.gated).map((verdict) => verdict.stage);
    if (total && gatedNames.length) {
        verdicts.push(judgeStage(TOTAL_STAGE, sumSamples(stages, gatedNames), threshold));
    }
    return { verdicts, regressed: verdicts.some((verdict) => verdict.status === "regression") };
}

/**
 * Pick the stages a confirmation pass should time again: every regressed
 * stage, or every gated stage when the total regressed.
 * @param {StageVerdict[]} verdicts - Verdicts of the first pass
 * @returns {{names: string[], total: boolean}} Stages to retime, and whether to judge their total
 */
export function stagesToConfirm(verdicts) {
    const regressed = verdicts.filter((verdict) => verdict.status === "regression");
    if (regressed.some((verdict) => verdict.stage === TOTAL_STAGE)) {
        const gated = verdicts.filter((verdict) => verdict.gated && verdict.stage !== TOTAL_STAGE);
        return { names: gated.map((verdict) => verdict.stage), total: true };
    }
    return { names: regressed.map((verdict) => verdict.stage), total: false };
}

/**
 * Add the per-run timings of several stages, side by side.
 * @param {Record<string, StageSamples>} stages - Timings by stage name
 * @param {string[]} names - Stages to add
 * @returns {StageSamples}
 */
function sumSamples(stages, names) {
    const runs = stages[names[0]].base.length;
    /** @param {"base"|"control"|"head"} side */
    const total = (side) =>
        Array.from({ length: runs }, (_, run) =>
            names.reduce((sum, name) => sum + stages[name][side][run], 0),
        );
    return { base: total("base"), control: total("control"), head: total("head") };
}

/**
 * Render the verdicts as a Markdown table.
 * @param {StageVerdict[]} verdicts - Stage outcomes
 * @param {number} threshold - Allowed slowdown beyond noise, as a fraction
 * @returns {string}
 */
export function formatVerdicts(verdicts, threshold) {
    const percent = (value) => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
    const rows = verdicts.map((verdict) =>
        [
            verdict.stage,
            verdict.base.toFixed(1),
            verdict.head.toFixed(1),
            percent(verdict.change),
            `±${(verdict.noise * 100).toFixed(1)}%`,
            verdict.gated ? `> ${percent(verdict.allowance)}` : "not gated",
            verdict.status,
        ].join(" | "),
    );
    return [
        `Threshold: ${(threshold * 100).toFixed(0)}% beyond the control's measured noise.`,
        "",
        "| Stage | Base ms (fastest) | Head ms (fastest) | Change | Noise | Fails at | Status |",
        "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
        ...rows.map((row) => `| ${row} |`),
    ].join("\n");
}
