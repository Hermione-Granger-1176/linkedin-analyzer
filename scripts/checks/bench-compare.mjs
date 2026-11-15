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
 * when that is set. Exits 1 on a regression and 2 when the control's output
 * differs from the base's, which means the harness, not the code, is broken.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";

import { generateLargeExport } from "../fixtures/gen-large-export.mjs";
import { formatVerdicts, judgeRun, stagesToConfirm } from "./bench-gate.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
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
                return [...(/** @type {Iterable<unknown>} */ (item))];
            }
            return item;
        }),
    );
}

/**
 * Time stages on every side, rotating which side goes first each round.
 * @param {Record<string, ReturnType<typeof buildStages>>} stagesBySide - Stages per side
 * @param {number} runs - Rounds to time
 * @param {string[]} [only] - Stages to time; every stage when omitted
 */
function timeStages(stagesBySide, runs, only) {
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
                globalThis.gc();
                const started = performance.now();
                outputs[side] = stagesBySide[side][name]();
                timings[name][side].push(performance.now() - started);
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
 * Prepare the copies and the export, compare, and report.
 * @param {ReturnType<typeof parseArgs>["values"]} args - Parsed options
 * @param {string} inputDir - Private directory for the synthetic export
 * @returns {Promise<number>} Process exit code
 */
async function compare(args, inputDir) {
    // Round up to a multiple of the side count, so each side runs first,
    // second, and third equally often.
    const runs = Math.ceil(Number(args.runs) / SIDES.length) * SIDES.length;
    const threshold = Number(args.threshold) / 100;
    const baseCommit = args["merge-base"]
        ? git(["merge-base", args["base-ref"], "HEAD"])
        : git(["rev-parse", "--verify", `${args["base-ref"]}^{commit}`]);
    console.log(
        `bench-compare: head ${git(["rev-parse", "--short", "HEAD"])} against base ${baseCommit.slice(0, 7)}`,
    );

    rmSync(COPIES, { recursive: true, force: true });
    extractWebSource(baseCommit, join(COPIES, "base"));
    extractWebSource(baseCommit, join(COPIES, "control"));
    generateLargeExport({ sizeMb: Number(args["size-mb"]), dir: inputDir });

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
        stagesBySide[side] = buildStages(await loadSide(roots[side]), raw);
    }

    const { stageNames, timings, sameOutput } = timeStages(stagesBySide, runs);
    const first = judgeRun(timings, threshold);
    const sections = [formatVerdicts(first.verdicts, threshold)];
    let regressed = false;
    if (first.regressed) {
        // A noisy round can push one stage over by chance. Time the flagged
        // stages again with twice the rounds, and fail only if they still regress.
        const retry = stagesToConfirm(first.verdicts);
        const again = timeStages(stagesBySide, runs * 2, retry.names);
        const confirmed = judgeRun(again.timings, threshold, { total: retry.total });
        regressed = confirmed.regressed;
        sections.push(
            "",
            `### Confirmation pass (${runs * 2} rounds of the flagged stages)`,
            "",
            formatVerdicts(confirmed.verdicts, threshold),
        );
    }
    const changedOutputs = stageNames.filter((name) => !sameOutput[name].head);
    const brokenControl = stageNames.filter((name) => !sameOutput[name].control);
    const report = [
        "## Web benchmark",
        "",
        `Base ${baseCommit.slice(0, 7)}, ${args["size-mb"]} MiB synthetic export, ${runs} rounds.`,
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

const { values: args } = parseArgs({
    options: {
        "base-ref": { type: "string", default: "origin/main" },
        "merge-base": { type: "boolean", default: false },
        "size-mb": { type: "string", default: "20" },
        runs: { type: "string", default: "15" },
        threshold: { type: "string", default: "10" },
    },
});

if (typeof globalThis.gc !== "function") {
    console.error("bench-compare: run under node --expose-gc");
    process.exitCode = 2;
} else {
    const inputDir = mkdtempSync(join(tmpdir(), "linkedin-analyzer-bench-"));
    try {
        process.exitCode = await compare(args, inputDir);
    } finally {
        rmSync(COPIES, { recursive: true, force: true });
        rmSync(inputDir, { recursive: true, force: true });
    }
}
