// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
    isDependencyResolutionError,
    parseOptions,
    runGate,
} from "../../../scripts/checks/bench-compare.mjs";

const SIDES = ["base", "control", "head"];

/**
 * Build stages that advance a fake clock instead of doing work.
 * @param {Record<string, (side: string, call: number) => number>} durations - Milliseconds
 * each call of each stage takes, by side and by that side's call count
 * @param {Record<string, (side: string) => unknown>} [outputs] - Output of each stage, by side
 */
function fakePipeline(durations, outputs = {}) {
    let time = 0;
    const calls = [];
    const clock = { now: () => time, collectGarbage: () => {} };
    const stagesBySide = Object.fromEntries(
        SIDES.map((side) => [
            side,
            Object.fromEntries(
                Object.keys(durations).map((name) => {
                    let call = 0;
                    const stage = () => {
                        calls.push(side);
                        time += durations[name](side, call);
                        call += 1;
                        return outputs[name] ? outputs[name](side) : name;
                    };
                    return [name, stage];
                }),
            ),
        ]),
    );
    return { stagesBySide, clock, calls };
}

describe("bench-compare gate run", () => {
    it("passes identical sides without a confirmation pass", () => {
        const { stagesBySide, clock } = fakePipeline({ compute: () => 100 });

        const result = runGate({ stagesBySide, runs: 3, threshold: 0.1, clock });

        expect(result).toMatchObject({
            regressed: false,
            confirmation: null,
            changedOutputs: [],
            brokenControl: [],
        });
    });

    it("fails a regression that repeats in the confirmation pass", () => {
        const { stagesBySide, clock } = fakePipeline({
            compute: (side) => (side === "head" ? 130 : 100),
        });

        const result = runGate({ stagesBySide, runs: 3, threshold: 0.1, clock });

        expect(result.first.regressed).toBe(true);
        // compute is the only stage, so the total regressed with it and is confirmed too.
        expect(result.confirmation?.verdicts.map((verdict) => verdict.stage)).toContain("compute");
        expect(result.regressed).toBe(true);
    });

    it("passes a slowdown that does not repeat in the confirmation pass", () => {
        // The head is slow in all three first-pass rounds, then back to normal.
        const { stagesBySide, clock } = fakePipeline({
            compute: (side, call) => (side === "head" && call < 3 ? 130 : 100),
        });

        const result = runGate({ stagesBySide, runs: 3, threshold: 0.1, clock });

        expect(result.first.regressed).toBe(true);
        expect(result.confirmation?.regressed).toBe(false);
        expect(result.regressed).toBe(false);
    });

    it("confirms only the flagged stages", () => {
        const { stagesBySide, clock } = fakePipeline({
            clean: () => 100,
            compute: (side) => (side === "head" ? 130 : 100),
            decode: () => 1000,
        });

        const result = runGate({ stagesBySide, runs: 3, threshold: 0.1, clock });

        expect(result.confirmation?.verdicts.map((verdict) => verdict.stage)).toEqual(["compute"]);
    });

    it("reports a control whose output differs from the base as a broken harness", () => {
        const { stagesBySide, clock } = fakePipeline(
            { compute: () => 100 },
            { compute: (side) => (side === "control" ? { rows: 1 } : { rows: 2 }) },
        );

        const result = runGate({ stagesBySide, runs: 3, threshold: 0.1, clock });

        expect(result.brokenControl).toEqual(["compute"]);
        expect(result.changedOutputs).toEqual([]);
    });

    it("reports, without failing, a head whose output differs from the base", () => {
        const { stagesBySide, clock } = fakePipeline(
            { compute: () => 100 },
            { compute: (side) => (side === "head" ? new Map([["a", 2]]) : new Map([["a", 1]])) },
        );

        const result = runGate({ stagesBySide, runs: 3, threshold: 0.1, clock });

        expect(result.changedOutputs).toEqual(["compute"]);
        expect(result.brokenControl).toEqual([]);
        expect(result.regressed).toBe(false);
    });

    it("rotates which side runs first, so each side leads equally often", () => {
        const { stagesBySide, clock, calls } = fakePipeline({ compute: () => 100 });

        runGate({ stagesBySide, runs: 3, threshold: 0.1, clock });

        const leaders = [calls[0], calls[3], calls[6]];
        expect(leaders.sort()).toEqual([...SIDES].sort());
    });
});

describe("bench-compare options", () => {
    it("defaults to origin/main, 20 MiB, 15 rounds, and a 10% threshold", () => {
        expect(parseOptions([])).toEqual({
            baseRef: "origin/main",
            mergeBase: false,
            sizeMb: 20,
            runs: 15,
            threshold: 0.1,
        });
    });

    it("reads every option and rounds the rounds up to a multiple of three", () => {
        expect(
            parseOptions([
                "--base-ref",
                "abc123",
                "--merge-base",
                "--size-mb",
                "5",
                "--runs",
                "4",
                "--threshold",
                "12.5",
            ]),
        ).toEqual({ baseRef: "abc123", mergeBase: true, sizeMb: 5, runs: 6, threshold: 0.125 });
    });

    it.each([
        ["--runs=0", "invalid runs: 0"],
        ["--runs=abc", "invalid runs: abc"],
        ["--runs=", "invalid runs: "],
        ["--runs=3.1", "invalid runs: 3.1"],
        ["--threshold=-1", "invalid threshold: -1"],
        ["--threshold=x", "invalid threshold: x"],
        ["--size-mb=0", "invalid size_mb: 0"],
    ])("rejects %s instead of passing without timing anything", (argument, message) => {
        expect(() => parseOptions([argument])).toThrow(message);
    });
});

describe("bench-compare dependency changes", () => {
    it("recognizes a package that cannot be resolved", () => {
        // The code Node gives an import of a package that is not installed.
        const error = Object.assign(new Error("Cannot find package 'gone'"), {
            code: "ERR_MODULE_NOT_FOUND",
        });

        expect(isDependencyResolutionError(error)).toBe(true);
    });

    it("recognizes a package subpath that is no longer exported", () => {
        const error = Object.assign(new Error("not exported"), {
            code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
        });

        expect(isDependencyResolutionError(error)).toBe(true);
    });

    it.each([[new Error("boom")], [new SyntaxError("bad token")], [null], [undefined]])(
        "treats %s as a real failure, not a dependency change",
        (error) => {
            expect(isDependencyResolutionError(error)).toBe(false);
        },
    );
});
