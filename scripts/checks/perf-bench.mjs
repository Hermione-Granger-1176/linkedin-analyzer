/*
 * Perf + correctness check for the upload read/decode layer.
 *
 * The cleaning parser (cleaner.js) is untouched here, so this isolates the file
 * read/decode hot path in upload.js.
 *   - Stream path (files >= 5MB, i.e. messages.csv): OLD did incremental
 *     TextDecoder({stream:true}); NEW buffers raw byte chunks -> concat ->
 *     single decode -> U+FFFD scan.
 *   - Reader path (<5MB): NEW adds an includes("�") scan.
 *
 * It (a) asserts the new decode yields byte-identical text to the old, and
 * (b) times read+decode and clean per file, taking the median over N runs.
 *
 * Usage (prefer the Makefile):
 *   make bench-decode          # 5 runs (median)
 *   make bench-decode runs=11
 *   node scripts/checks/perf-bench.mjs [runs]
 *
 * Requires your private LinkedIn export in data/input (never committed). The
 * script skips cleanly when those files are absent.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const REPO = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const INPUT = join(REPO, "data/input");
const RUNS = Number(process.argv[2] || 5);
const STREAM_THRESHOLD = 5 * 1024 * 1024;
const CHUNK = 64 * 1024; // simulate a ReadableStream reader's chunking

const FILES = {
    shares: "Shares.csv",
    comments: "Comments.csv",
    messages: "messages.csv",
    connections: "Connections.csv",
};

const missing = Object.values(FILES).filter((name) => !existsSync(join(INPUT, name)));
if (missing.length > 0) {
    console.log(
        `SKIP: no local export in data/input (missing: ${missing.join(", ")}). ` +
            "This benchmark needs your private LinkedIn export.",
    );
    process.exit(0);
}

const { LinkedInCleaner } = await import(join(REPO, "web/src/cleaner.js"));

function chunkize(bytes) {
    const out = [];
    for (let i = 0; i < bytes.length; i += CHUNK) {
        out.push(bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
    }
    return out;
}

// OLD stream decode: incremental, mirrors the pre-rewrite readFileAsTextStream.
function decodeOldStream(chunks) {
    const decoder = new TextDecoder("utf-8");
    let text = "";
    for (const c of chunks) {
        text += decoder.decode(c, { stream: true });
    }
    text += decoder.decode();
    return text;
}

// NEW decode: mirrors upload.js decodeBytes — fatal UTF-8 validation with a
// windows-1252 fallback only on a genuine decode error (no U+FFFD heuristic).
function decodeBytesNew(bytes) {
    let text;
    let usedFallback = false;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        text = new TextDecoder("windows-1252").decode(bytes);
        usedFallback = true;
    }
    return { text, usedFallback };
}

// NEW stream decode: buffer bytes, concat, then decodeBytes.
function decodeNewStream(chunks, totalBytes) {
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const c of chunks) {
        bytes.set(c, offset);
        offset += c.byteLength;
    }
    return decodeBytesNew(bytes);
}

// Reader path: OLD = single utf-8 decode; NEW = byte-based decodeBytes.
function decodeOldReader(bytes) {
    return new TextDecoder("utf-8").decode(bytes);
}
function decodeNewReader(bytes) {
    return decodeBytesNew(bytes);
}

function ms(fn) {
    const t0 = performance.now();
    const r = fn();
    return { dt: performance.now() - t0, r };
}

function avg(fn) {
    const times = [];
    let last;
    for (let i = 0; i < RUNS; i += 1) {
        const { dt, r } = ms(fn);
        times.push(dt);
        last = r;
    }
    times.sort((a, b) => a - b);
    return { median: times[Math.floor(times.length / 2)], last };
}

console.log(`runs=${RUNS}, chunk=${CHUNK / 1024}KB\n`);
console.log(
    "type".padEnd(12),
    "path".padEnd(8),
    "MB".padStart(6),
    "decodeOLD".padStart(11),
    "decodeNEW".padStart(11),
    "Δdecode".padStart(9),
    "clean".padStart(9),
    "rows".padStart(7),
    "fallback".padStart(9),
    "identical",
);

// Expected cleaned row counts on the real export (2026-06-12 baseline).
const EXPECTED_ROWS = { shares: 886, comments: 7820, messages: 57898, connections: 5989 };
let anyDiff = false;
for (const [type, name] of Object.entries(FILES)) {
    const buf = await readFile(join(INPUT, name));
    const bytes = new Uint8Array(buf);
    const mb = bytes.length / (1024 * 1024);
    const isStream = bytes.length >= STREAM_THRESHOLD;

    let oldDecode;
    let newDecode;
    let text;
    if (isStream) {
        const chunks = chunkize(bytes);
        oldDecode = avg(() => decodeOldStream(chunks));
        newDecode = avg(() => decodeNewStream(chunks, bytes.length));
        text = newDecode.last.text;
        if (oldDecode.last !== text) {
            anyDiff = true;
        }
    } else {
        oldDecode = avg(() => decodeOldReader(bytes));
        newDecode = avg(() => decodeNewReader(bytes));
        text = newDecode.last.text;
        if (oldDecode.last !== text) {
            anyDiff = true;
        }
    }

    const clean = avg(() => LinkedInCleaner.process(text, type));
    const identical = oldDecode.last === text || oldDecode.last === newDecode.last.text;
    const delta = newDecode.median - oldDecode.median;
    const rows = clean.last.success ? clean.last.cleanedData.length : "ERR";
    const usedFallback = newDecode.last.usedFallback;

    // Real export is valid UTF-8, so the fatal decode must succeed without the
    // windows-1252 fallback and must yield byte-identical text and row counts.
    if (!identical || usedFallback || rows !== EXPECTED_ROWS[type]) {
        anyDiff = true;
    }

    console.log(
        type.padEnd(12),
        (isStream ? "stream" : "reader").padEnd(8),
        mb.toFixed(1).padStart(6),
        `${oldDecode.median.toFixed(1)}ms`.padStart(11),
        `${newDecode.median.toFixed(1)}ms`.padStart(11),
        `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}ms`.padStart(9),
        `${clean.median.toFixed(1)}ms`.padStart(9),
        String(rows).padStart(7),
        String(usedFallback).padStart(9),
        identical && !usedFallback && rows === EXPECTED_ROWS[type] ? "YES" : "NO  <-- DIFF",
    );
}

console.log(
    anyDiff
        ? "\nRESULT: new decode DIFFERS from old, triggered a fallback, or row counts drifted."
        : "\nRESULT: new fatal decode is byte-identical to old, no fallback, row counts match.",
);
process.exitCode = anyDiff ? 1 : 0;
