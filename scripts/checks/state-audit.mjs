/*
 * Retained-state audit: how many bytes each analysis structure keeps alive
 * after the export is processed. It complements the browser bench, which only
 * sees sampled peaks, by forcing garbage collection around each step and
 * reading the heap plus array-buffer memory before and after.
 *
 *   rows      cleaned rows the workers hold while they build state
 *   messages  the page-side message state, then each field it keeps
 *   analytics the AnalyticsEngine state for shares and comments
 *
 * The web modules load through Vite in `measurement` mode, so a 100 MB export
 * passes the raised upload limits the same way it does in `make bench-browser`.
 *
 * Usage (prefer the Makefile):
 *   make audit-state [input_dir=path] [strict=1]
 *   node --expose-gc scripts/checks/state-audit.mjs [--input-dir path] [--strict]
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const FILES = ["Shares.csv", "Comments.csv", "messages.csv", "Connections.csv"];
const MESSAGE_FIELDS = [
    "events",
    "rowTimestamps",
    "contacts",
    "talkedNameKeys",
    "talkedUrlKeys",
    "outreach",
];

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const dirIndex = args.indexOf("--input-dir");
const inputDir = resolve(REPO, dirIndex >= 0 ? args[dirIndex + 1] : "data/input");

if (typeof globalThis.gc !== "function") {
    console.error("state-audit needs node --expose-gc (run it through make audit-state).");
    process.exit(2);
}

const missing = FILES.filter((name) => !existsSync(join(inputDir, name)));
if (missing.length > 0) {
    console.log(`SKIP: missing ${missing.join(", ")} in ${inputDir}.`);
    process.exit(strict ? 1 : 0);
}

function settle() {
    for (let i = 0; i < 4; i += 1) {
        globalThis.gc();
    }
}

function used() {
    settle();
    const memory = process.memoryUsage();
    return memory.heapUsed + memory.arrayBuffers;
}

function mb(bytes) {
    return `${(bytes / 1e6).toFixed(1)} MB`.padStart(10);
}

function line(label, bytes, note = "") {
    console.log(`STATE  ${label.padEnd(30)} ${mb(bytes)}${note ? `  ${note}` : ""}`);
}

process.env.VITE_MEASUREMENT_LIMITS = "1";
const server = await createServer({
    configFile: false,
    root: REPO,
    mode: "measurement",
    logLevel: "error",
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
});

try {
    const load = (path) => server.ssrLoadModule(path);
    const { decodeBytes } = await load("/web/src/features/upload/decode.js");
    const { LinkedInCleaner } = await load("/web/src/features/cleaning/cleaner.js");
    const { AnalyticsEngine } = await load("/web/src/features/analytics/activity.js");
    const { processPayload, transferablesOf } = await load(
        "/web/src/features/messages/messages-worker.js",
    );
    const { hydrateConnectionState, hydrateMessageState } = await load(
        "/web/src/features/messages/hydrate.js",
    );

    const text = {};
    for (const name of FILES) {
        const bytes = new Uint8Array(await readFile(join(inputDir, name)));
        text[name] = decodeBytes(bytes, name).text;
        line(`input ${name}`, bytes.length, "file size");
    }

    // Cleaned rows: the per-row objects a worker holds before it builds state.
    for (const [name, type] of [
        ["messages.csv", "messages"],
        ["Connections.csv", "connections"],
        ["Shares.csv", "shares"],
        ["Comments.csv", "comments"],
    ]) {
        const base = used();
        const rows = LinkedInCleaner.process(text[name], type).cleanedData;
        line(`rows ${type}`, used() - base, `${rows.length} rows`);
        rows.length = 0;
    }

    // Page-side message state: what the page keeps after the worker transfer.
    let pageBase = used();
    let payload = processPayload({
        messagesCsv: text["messages.csv"],
        connectionsCsv: text["Connections.csv"],
    });
    let received = structuredClone(payload, { transfer: transferablesOf(payload) });
    payload = null;
    const messageState = hydrateMessageState(received.messageState);
    let connectionState = hydrateConnectionState(received.connectionState);
    received = null;
    line("page messages + connections", used() - pageBase);

    pageBase = used();
    connectionState = null;
    line("  connections", pageBase - used(), "freed when dropped");
    for (const field of MESSAGE_FIELDS) {
        pageBase = used();
        messageState[field] = null;
        line(`  messages.${field}`, pageBase - used(), "freed when dropped");
    }

    // Analytics state: what the analytics worker keeps for filter changes,
    // measured after the cleaned rows it was built from are dropped.
    const analyticsBase = used();
    const held = {
        shares: LinkedInCleaner.process(text["Shares.csv"], "shares").cleanedData,
        comments: LinkedInCleaner.process(text["Comments.csv"], "comments").cleanedData,
        analytics: null,
    };
    held.analytics = AnalyticsEngine.compute(held.shares, held.comments);
    held.shares = null;
    held.comments = null;
    line("analytics state", used() - analyticsBase);
    held.analytics = null;
} finally {
    await server.close();
}
