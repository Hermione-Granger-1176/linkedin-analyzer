/*
 * Time decoding, cleaning, and analysis-state construction for a real export.
 * Read the source bytes once before timing, then report stage medians across
 * the configured number of runs.
 *
 * The Insights stages clean shares and comments, then call AnalyticsEngine's
 * compute, buildView, and generateInsights methods. The Messages stages clean
 * messages and connections, then call MessagesAnalytics.buildMessageState and
 * MessagesAnalytics.buildConnectionState.
 *
 * Files of at least 5 MiB use chunk preparation and concatenation before
 * decodeBytes. This benchmark excludes disk reads, browser upload handling,
 * worker startup and messaging, and rendering.
 *
 * Usage:
 *   make bench                 # 5 runs (median)
 *   make bench runs=11
 *
 * Requires your private LinkedIn export in data/input (never committed). The
 * script skips cleanly when those files are absent.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { concatChunks, decodeBytes } from "../../web/src/features/upload/decode.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const INPUT = join(REPO, "data/input");
const RUNS = Number(process.argv[2] || 5);
const STREAM_THRESHOLD = 5 * 1024 * 1024;
const CHUNK = 64 * 1024;
const FILES = ["Shares.csv", "Comments.csv", "messages.csv", "Connections.csv"];

const missing = FILES.filter((name) => !existsSync(join(INPUT, name)));
if (missing.length > 0) {
    console.log(
        `SKIP: no local export in data/input (missing: ${missing.join(", ")}). ` +
            "This benchmark needs your private LinkedIn export.",
    );
    process.exit(0);
}

const { LinkedInCleaner } = await import(
    new URL("../../web/src/features/cleaning/cleaner.js", import.meta.url).href
);
const { AnalyticsEngine } = await import(
    new URL("../../web/src/features/analytics/activity.js", import.meta.url).href
);
const { MessagesAnalytics } = await import(
    new URL("../../web/src/features/messages/analytics.js", import.meta.url).href
);

const DEFAULT_FILTERS = {
    timeRange: "12m",
    topic: "all",
    monthFocus: null,
    day: null,
    hour: null,
    shareType: "all",
};

// Include chunk preparation and concatenation for files of at least 5 MiB.
// Both paths use the production decodeBytes function.
function decodeNew(bytes) {
    let decodeInput = bytes;
    if (bytes.length >= STREAM_THRESHOLD) {
        const chunks = [];
        for (let i = 0; i < bytes.length; i += CHUNK) {
            chunks.push(bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
        }
        decodeInput = concatChunks(chunks, bytes.length);
    }
    return decodeBytes(decodeInput, "benchmark.csv").text;
}

async function load(name) {
    const buf = await readFile(join(INPUT, name));
    return new Uint8Array(buf);
}

function median(times) {
    const s = [...times].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
}

// Read the source bytes once before timing any stages.
const raw = {
    shares: await load("Shares.csv"),
    comments: await load("Comments.csv"),
    messages: await load("messages.csv"),
    connections: await load("Connections.csv"),
};

function timeStages(stages) {
    const acc = Object.fromEntries(stages.map(([n]) => [n, []]));
    let result;
    for (let i = 0; i < RUNS; i += 1) {
        for (const [name, fn] of stages) {
            const t0 = performance.now();
            result = fn();
            acc[name].push(performance.now() - t0);
        }
    }
    return { acc, result };
}

function report(label, acc, extra = "") {
    const parts = Object.entries(acc).map(([n, times]) => `${n}=${median(times).toFixed(0)}ms`);
    const total = Object.values(acc).reduce((s, times) => s + median(times), 0);
    const cols = parts.join("  ").padEnd(58);
    console.log(`${label.padEnd(10)} ${cols} TOTAL=${total.toFixed(0)}ms  ${extra}`);
}

console.log(`runs=${RUNS} (median)\n`);

// ---- Insights pipeline (shares + comments) ----
{
    let sharesText;
    let commentsText;
    let sharesData;
    let commentsData;
    let analytics;
    let view;
    const { acc, result } = timeStages([
        [
            "decode",
            () => {
                sharesText = decodeNew(raw.shares);
                commentsText = decodeNew(raw.comments);
            },
        ],
        [
            "clean",
            () => {
                sharesData = LinkedInCleaner.process(sharesText, "shares").cleanedData;
                commentsData = LinkedInCleaner.process(commentsText, "comments").cleanedData;
            },
        ],
        [
            "compute",
            () => {
                analytics = AnalyticsEngine.compute(sharesData, commentsData);
            },
        ],
        [
            "buildView",
            () => {
                view = AnalyticsEngine.buildView(analytics, DEFAULT_FILTERS);
            },
        ],
        ["insights", () => AnalyticsEngine.generateInsights(view)],
    ]);
    report("INSIGHTS", acc, `cards=${result.insights?.length ?? "?"}`);
}

// ---- Messages pipeline (messages + connections) ----
{
    let messagesText;
    let connectionsText;
    let messagesData;
    let connectionsData;
    let messageState;
    const { acc, result } = timeStages([
        [
            "decode",
            () => {
                messagesText = decodeNew(raw.messages);
                connectionsText = decodeNew(raw.connections);
            },
        ],
        [
            "clean",
            () => {
                messagesData = LinkedInCleaner.process(messagesText, "messages").cleanedData;
                connectionsData = LinkedInCleaner.process(
                    connectionsText,
                    "connections",
                ).cleanedData;
            },
        ],
        [
            "msgState",
            () => {
                messageState = MessagesAnalytics.buildMessageState(messagesData);
            },
        ],
        ["connState", () => MessagesAnalytics.buildConnectionState(connectionsData)],
    ]);
    const convos = messageState?.conversations?.length ?? result?.list?.length ?? "?";
    report("MESSAGES", acc, `convos=${convos}`);
}
