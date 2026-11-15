/*
 * Compare the analysis pipeline of this checkout against a base commit, and
 * fail when this checkout is measurably slower.
 *
 * Three copies of web/src load into one process: the base commit, an
 * identical copy of it (the control), and this checkout (the head). Every
 * stage runs once per side per round, in a rotating order, after a forced
 * garbage collection, on the same synthetic export. The control shows how far
 * two identical copies drift on this machine during this run, and
 * bench-gate.mjs only fails a stage that slowed down by more than the
 * threshold plus that drift.
 *
 * The stages match pipeline-bench.mjs: decode, clean, AnalyticsEngine compute,
 * buildView, and generateInsights for Insights, then decode, clean, and the
 * MessagesAnalytics state builders for Messages.
 *
 * Usage through Make:
 *   make bench-compare                          # against origin/main
 *   make bench-compare base=abc123 runs=21 threshold=10
 *   make bench-compare base=origin/main merge_base=1
 *
 * The base and control copies are extracted with git archive under
 * .artifacts/bench-compare, where their imports resolve this repository's
 * node_modules. The export is generated in a private temporary directory.
 * Both are removed on exit. Writes a Markdown report to $GITHUB_STEP_SUMMARY
 * when that is set. Exits 1 on a regression. Exits 2 on an invalid option, or
 * when the control's output differs from the base's, which means the
 * harness, not the code, is broken.
 *
 * parseOptions and runGate are exported so tests can drive the timing loop,
 * the confirmation pass, and the output checks with a fake clock.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";

import { formatVerdicts, judgeRun, stagesToConfirm } from "./bench-gate.mjs";

// Under Vitest this module is imported with a non-file import.meta.url, so
// fall back to the working directory, as cleaner-diff.mjs does. Tests drive
// runGate and parseOptions, which never read REPO, and Make runs from the root.
function resolveRepoRoot() {
    try {
        return fileURLToPath(new URL("../..", import.meta.url));
    } catch {
        return process.cwd();
    }
}

const REPO = resolveRepoRoot();
const COPIES = join(REPO, ".artifacts", "bench-compare");
const STREAM_THRESHOLD = 5 * 1024 * 1024;
const CHUNK = 64 * 1024;
const FILTERS = {
    timeRange: "12m",
    topic: "all",
    monthFocus: null,
    day: null,
    hour: null,
    shareType: "all",
};
const SIDES = /** @type {const} */ (["base", "control", "head"]);

/**
 * Run git in the repository and return its trimmed output.
 * @param {string[]} command - Git arguments
 * @returns {string}
 */
function git(command) {
    return execFileSync("git", command, { cwd: REPO, encoding: "utf8" }).trim();
}

/**
 * Extract a commit's web/src into a directory.
 * @param {string} commit - Commit to extract
 * @param {string} dir - Destination directory
 */
function extractWebSource(commit, dir) {
    mkdirSync(dir, { recursive: true });
    const archive = execFileSync("git", ["archive", "--format=tar", commit, "web/src"], {
        cwd: REPO,
        maxBuffer: 256 * 1024 * 1024,
    });
    execFileSync("tar", ["-x", "-C", dir], { input: archive });
}

/**
 * Import the pipeline modules from one checkout.
 * @param {string} root - Directory that holds web/src
 */
async function loadSide(root) {
    const url = (path) => pathToFileURL(resolve(root, "web/src", path)).href;
    return {
        decode: await import(url("features/upload/decode.js")),
        Cleaner: (await import(url("features/cleaning/cleaner.js"))).LinkedInCleaner,
        Engine: (await import(url("features/analytics/activity.js"))).AnalyticsEngine,
        Messages: (await import(url("features/messages/analytics.js"))).MessagesAnalytics,
    };
}

/**
 * Decode bytes the way the upload path does: large files go through chunk
 * preparation and concatenation first.
 * @param {Awaited<ReturnType<typeof loadSide>>["decode"]} decode - Decode module
 * @param {Uint8Array} bytes - File bytes
 * @returns {string}
 */
function decodeFile(decode, bytes) {
    let input = bytes;
    if (bytes.length >= STREAM_THRESHOLD) {
        const chunks = [];
        for (let i = 0; i < bytes.length; i += CHUNK) {
            chunks.push(bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
        }
        input = decode.concatChunks(chunks, bytes.length);
    }
    return decode.decodeBytes(input, "benchmark.csv").text;
}

/**
 * Build one side's stages. Each stage reads the previous stage's output from
 * `state`, which is filled once before timing so every timed call does the
 * same work.
 * @param {Awaited<ReturnType<typeof loadSide>>} m - Pipeline modules
 * @param {Record<string, Uint8Array>} raw - Input bytes by file
 */
function buildStages(m, raw) {
    const state = /** @type {Record<string, any>} */ ({});
    const stages = {
        "insights decode": () => [
            decodeFile(m.decode, raw.shares),
            decodeFile(m.decode, raw.comments),
        ],
        "insights clean": () => [
            m.Cleaner.process(state.sharesText, "shares").cleanedData,
            m.Cleaner.process(state.commentsText, "comments").cleanedData,
        ],
        "analytics compute": () => m.Engine.compute(state.shares, state.comments),
        "analytics buildView": () => m.Engine.buildView(state.analytics, FILTERS),
        "insights generate": () => m.Engine.generateInsights(state.view),
        "messages decode": () => [
            decodeFile(m.decode, raw.messages),
            decodeFile(m.decode, raw.connections),
        ],
        "messages clean": () => [
            m.Cleaner.process(state.messagesText, "messages").cleanedData,
            m.Cleaner.process(state.connectionsText, "connections").cleanedData,
        ],
        "messages buildMessageState": () => m.Messages.buildMessageState(state.messages),
        "messages buildConnectionState": () => m.Messages.buildConnectionState(state.connections),
    };
    [state.sharesText, state.commentsText] = stages["insights decode"]();
    [state.shares, state.comments] = stages["insights clean"]();
    state.analytics = stages["analytics compute"]();
    state.view = stages["analytics buildView"]();
    [state.messagesText, state.connectionsText] = stages["messages decode"]();
    [state.messages, state.connections] = stages["messages clean"]();
    return stages;
}

/**
 * Turn Maps, Sets, and typed arrays into plain data so outputs compare by value.
 * @param {unknown} value - Stage output
 * @returns {unknown}
 */
function plain(value) {
    return JSON.parse(
        JSON.stringify(value, (_key, item) => {
            if (item instanceof Map || item instanceof Set || ArrayBuffer.isView(item)) {
                return [.../** @type {Iterable<unknown>} */ (item)];
            }
            return item;
        }),
    );
}

/**
 * @typedef {object} GateClock
 * @property {() => number} now - Current time in milliseconds
 * @property {() => void} collectGarbage - Run a garbage collection before a timed call
 */

/** Real timer and collector; the collector needs node --expose-gc. */
const SYSTEM_CLOCK = {
    now: () => performance.now(),
    collectGarbage: () => globalThis.gc(),
};

/**
 * Time stages on every side, rotating which side goes first each round.
 * @param {Record<string, Record<string, () => unknown>>} stagesBySide - Stages per side
 * @param {number} runs - Rounds to time
 * @param {string[]|undefined} only - Stages to time; every stage when undefined
 * @param {GateClock} clock - Timer and collector
 */
function timeStages(stagesBySide, runs, only, clock) {
    const stageNames = only ?? Object.keys(stagesBySide.base);
    const timings = Object.fromEntries(
        stageNames.map((name) => [name, { base: [], control: [], head: [] }]),
    );
    /** @type {Record<string, {control: boolean, head: boolean}>} */
    const sameOutput = {};
    for (let run = 0; run < runs; run += 1) {
        const order = SIDES.map((_, index) => SIDES[(index + run) % SIDES.length]);
        for (const name of stageNames) {
            const outputs = {};
            for (const side of order) {
                clock.collectGarbage();
                const started = clock.now();
                outputs[side] = stagesBySide[side][name]();
                timings[name][side].push(clock.now() - started);
            }
            if (run === 0) {
                const base = plain(outputs.base);
                sameOutput[name] = {
                    control: isDeepStrictEqual(base, plain(outputs.control)),
                    head: isDeepStrictEqual(base, plain(outputs.head)),
                };
            }
        }
    }
    return { stageNames, timings, sameOutput };
}

/**
 * Parse and validate the command-line options. An unusable value throws
 * rather than reaching the gate, where an empty sample set would compare as
 * NaN and pass without timing anything.
 * @param {string[]} argv - Arguments after the script path
 */
export function parseOptions(argv) {
    const { values } = parseArgs({
        args: argv,
        options: {
            "base-ref": { type: "string", default: "origin/main" },
            "merge-base": { type: "boolean", default: false },
            "size-mb": { type: "string", default: "20" },
            runs: { type: "string", default: "15" },
            threshold: { type: "string", default: "10" },
        },
    });
    const number = (value, name, min) => {
        const parsed = Number(value);
        if (value.trim() === "" || !Number.isFinite(parsed) || parsed < min) {
            throw new Error(`invalid ${name}: ${value}`);
        }
        return parsed;
    };
    const runs = number(values.runs, "runs", 1);
    if (!Number.isInteger(runs)) {
        throw new Error(`invalid runs: ${values.runs}`);
    }
    return {
        baseRef: values["base-ref"],
        mergeBase: values["merge-base"],
        sizeMb: number(values["size-mb"], "size_mb", 1),
        // Round up to a multiple of the side count, so each side runs first,
        // second, and third equally often.
        runs: Math.ceil(runs / SIDES.length) * SIDES.length,
        threshold: number(values.threshold, "threshold", 0) / 100,
    };
}

/**
 * Time every stage, judge it, and confirm any regression with a second pass.
 * @param {{
 *   stagesBySide: Record<string, Record<string, () => unknown>>,
 *   runs: number,
 *   threshold: number,
 *   clock?: GateClock,
 * }} options - Stages for the base, control, and head sides, and the gate settings
 */
export function runGate({ stagesBySide, runs, threshold, clock = SYSTEM_CLOCK }) {
    const { stageNames, timings, sameOutput } = timeStages(stagesBySide, runs, undefined, clock);
    const first = judgeRun(timings, threshold);
    let confirmation = null;
    if (first.regressed) {
        // A noisy round can push one stage over by chance. Time the flagged
        // stages again with twice the rounds, and fail only if they still regress.
        const retry = stagesToConfirm(first.verdicts);
        const again = timeStages(stagesBySide, runs * 2, retry.names, clock);
        confirmation = judgeRun(again.timings, threshold, { total: retry.total });
    }
    return {
        first,
        confirmation,
        regressed: Boolean(confirmation && confirmation.regressed),
        changedOutputs: stageNames.filter((name) => !sameOutput[name].head),
        brokenControl: stageNames.filter((name) => !sameOutput[name].control),
    };
}

/**
 * Whether an import failed because a package could not be resolved.
 *
 * The base and control copies hold only web/src and resolve packages from
 * this checkout's node_modules. A change that removes or restructures a
 * package the base still imports leaves the base unable to load, which says
 * nothing about the speed of either side's code.
 * @param {unknown} error - Error thrown while importing a side
 * @returns {boolean}
 */
export function isDependencyResolutionError(error) {
    const code = /** @type {{code?: unknown}} */ (error)?.code;
    return code === "ERR_MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED";
}

/**
 * Report a comparison that could not run because the base cannot load
 * against this checkout's dependencies.
 * @param {string} baseCommit - Base commit
 * @param {string} reason - Import error message
 */
function reportSkipped(baseCommit, reason) {
    const report = [
        "## Web benchmark",
        "",
        `Skipped: base ${baseCommit.slice(0, 7)} could not load against this checkout's dependencies.`,
        "This happens when a change removes or restructures a package the base imports. The",
        "gate times web/src only, with the same dependencies on both sides, so it has nothing",
        "to compare here.",
        "",
        `Import error: ${reason}`,
        "",
    ].join("\n");
    console.log(report);
    if (process.env.GITHUB_ACTIONS === "true") {
        console.log(
            "::warning title=Web benchmark skipped::The base commit cannot load against this checkout's dependencies. See the job summary.",
        );
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
    }
}

/**
 * Prepare the copies and the export, compare, and report.
 * @param {ReturnType<typeof parseOptions>} options - Validated options
 * @param {string} inputDir - Private directory for the synthetic export
 * @returns {Promise<number>} Process exit code
 */
async function compare(options, inputDir) {
    const { runs, threshold } = options;
    const baseCommit = options.mergeBase
        ? git(["merge-base", options.baseRef, "HEAD"])
        : git(["rev-parse", "--verify", `${options.baseRef}^{commit}`]);
    console.log(
        `bench-compare: head ${git(["rev-parse", "--short", "HEAD"])} against base ${baseCommit.slice(0, 7)}`,
    );

    rmSync(COPIES, { recursive: true, force: true });
    extractWebSource(baseCommit, join(COPIES, "base"));
    extractWebSource(baseCommit, join(COPIES, "control"));
    // Imported here, not at the top: the generator resolves its own paths from
    // a file URL when it loads, which fails when tests import this module.
    const { generateLargeExport } = await import("../fixtures/gen-large-export.mjs");
    generateLargeExport({ sizeMb: options.sizeMb, dir: inputDir });

    const raw = Object.fromEntries(
        [
            ["shares", "Shares.csv"],
            ["comments", "Comments.csv"],
            ["messages", "messages.csv"],
            ["connections", "Connections.csv"],
        ].map(([key, file]) => [key, new Uint8Array(readFileSync(join(inputDir, file)))]),
    );
    const roots = { base: join(COPIES, "base"), control: join(COPIES, "control"), head: REPO };
    const stagesBySide = {};
    for (const side of SIDES) {
        let modules;
        try {
            modules = await loadSide(roots[side]);
        } catch (error) {
            if (side === "head" || !isDependencyResolutionError(error)) {
                throw error;
            }
            reportSkipped(baseCommit, /** @type {Error} */ (error).message);
            return 0;
        }
        stagesBySide[side] = buildStages(modules, raw);
    }

    const { first, confirmation, regressed, changedOutputs, brokenControl } = runGate({
        stagesBySide,
        runs,
        threshold,
    });
    const sections = [formatVerdicts(first.verdicts, threshold)];
    if (confirmation) {
        sections.push(
            "",
            `### Confirmation pass (${runs * 2} rounds of the flagged stages)`,
            "",
            formatVerdicts(confirmation.verdicts, threshold),
        );
    }
    const report = [
        "## Web benchmark",
        "",
        `Base ${baseCommit.slice(0, 7)}, ${options.sizeMb} MiB synthetic export, ${runs} rounds.`,
        "Each stage ran once per side per round, after a forced garbage collection.",
        "",
        ...sections,
        "",
        changedOutputs.length
            ? `Head output differs from base in: ${changedOutputs.join(", ")}. Expected only when the change alters results.`
            : "Head output matches base in every stage.",
        "",
    ].join("\n");

    console.log(report);
    if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
    }
    if (brokenControl.length) {
        console.error(
            `bench-compare: control output differs from base in ${brokenControl.join(", ")}`,
        );
        return 2;
    }
    if (regressed) {
        console.error("bench-compare: a stage slowed down beyond the threshold and measured noise");
        return 1;
    }
    return 0;
}

/**
 * Validate the environment and options, run the comparison, and clean up.
 * @param {string[]} argv - Arguments after the script path
 * @returns {Promise<number>} Process exit code
 */
async function main(argv) {
    let options;
    try {
        options = parseOptions(argv);
    } catch (error) {
        console.error(`bench-compare: ${/** @type {Error} */ (error).message}`);
        return 2;
    }
    if (typeof globalThis.gc !== "function") {
        console.error("bench-compare: run under node --expose-gc");
        return 2;
    }
    const inputDir = mkdtempSync(join(tmpdir(), "linkedin-analyzer-bench-"));
    try {
        return await compare(options, inputDir);
    } finally {
        rmSync(COPIES, { recursive: true, force: true });
        rmSync(inputDir, { recursive: true, force: true });
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exitCode = await main(process.argv.slice(2));
}
