/*
 * Time the real browser flow on a large export, with simulated slow devices
 * and a combined page-plus-worker heap budget.
 *
 * Builds the bundle in "measurement" mode, which raises the upload limits
 * (128 MiB per file, 128 Mi characters, 1,000,000 rows; see
 * web/src/shared/limits.js) so exports above the public limits can be timed.
 * It serves the bundle from a private preview server, and for each run opens
 * a fresh Chromium, uploads the export, and records:
 *   - time from file drop to the Analytics screen showing data,
 *   - time from file drop to the Messages screen showing data (opened after
 *     Analytics, so it includes the Analytics time),
 *   - time for one cached filter change on Analytics,
 *   - the peak combined JS heap of the page and every worker, sampled through
 *     CDP (Runtime.getHeapUsage on the page and on each auto-attached worker),
 *   - whether the tab crashed.
 *
 * Slow devices are simulated with CDP CPU throttling (Emulation.setCPUThrottlingRate),
 * --disable-gpu, and a mobile viewport with touch. CPU throttling slows only
 * the page's main thread: Chromium rejects it on worker targets, and a
 * measured worker loop ran at the same speed at rates 1 and 4. Throttled runs
 * therefore understate slow-device time for work done in workers. Desktop Chromium never kills
 * a tab at a phone's memory limit, so budget_mb stands in for it: a provisional
 * engineering budget for comparing designs and catching regressions, not a
 * phone safety threshold. It counts only sampled JavaScript heap, not browser,
 * graphics, or native memory, and sampling can miss short peaks.
 *
 * Usage (prefer the Makefile):
 *   make bench-browser size_mb=100
 *   make bench-browser size_mb=55 cpu=4 gpu=0 mobile=1 budget_mb=300
 *   make bench-browser input_dir=/private/export runs=5
 *
 * With size_mb and no input_dir, a synthetic export of that size is generated
 * under the system temp directory first. Otherwise input_dir defaults to
 * data/input. Traces, screenshots, video, downloads, and telemetry stay off.
 */
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, devices } from "@playwright/test";

import { generateLargeExport } from "../fixtures/gen-large-export.mjs";
import {
    EXPORT_FILES,
    REPO,
    buildApp,
    newMeasurementContext,
    openRoute,
    routeReady,
    startPreview,
    stopPreview,
    uploadExport,
    waitForServer,
} from "./app-preview.mjs";

// Distinct from the e2e webServer (4173) and heap-audit (4319).
const PORT = 4321;
const BASE_URL = `http://127.0.0.1:${PORT}`;
// Throttled runs on large files are slow by design; allow minutes, not seconds.
const STEP_TIMEOUT_MS = 10 * 60 * 1000;
const SAMPLE_INTERVAL_MS = 200;
const FILTER_SETTLE_TIMEOUT_MS = 10000;
const MOBILE_DEVICE = "Pixel 7";
const MB = 1024 * 1024;

/**
 * Parse CLI arguments.
 * @param {string[]} argv - Arguments after the script path.
 */
export function parseArgs(argv) {
    const options = {
        inputDir: "",
        sizeMb: 0,
        runs: 3,
        cpu: 1,
        gpu: true,
        mobile: false,
        budgetMb: 0,
    };
    const number = (value, name, min) => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < min) {
            throw new Error(`invalid ${name}: ${value}`);
        }
        return parsed;
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        const value = argv[index + 1];
        if (value === undefined) {
            throw new Error(`missing value for ${argument}`);
        }
        index += 1;
        if (argument === "--input-dir") {
            options.inputDir = value;
        } else if (argument === "--size-mb") {
            options.sizeMb = number(value, "size_mb", 0);
        } else if (argument === "--runs") {
            options.runs = Math.round(number(value, "runs", 1));
        } else if (argument === "--cpu") {
            options.cpu = number(value, "cpu", 1);
        } else if (argument === "--gpu") {
            options.gpu = value !== "0";
        } else if (argument === "--mobile") {
            options.mobile = value === "1";
        } else if (argument === "--budget-mb") {
            options.budgetMb = number(value, "budget_mb", 0);
        } else {
            throw new Error(`invalid option: ${argument}`);
        }
    }
    return options;
}

/**
 * Median and range of a list of numbers.
 * @param {number[]} values - Samples.
 * @returns {{ median: number, min: number, max: number }}
 */
export function summarize(values) {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    return { median, min: sorted[0], max: sorted[sorted.length - 1] };
}

/**
 * Sample the page heap and every worker heap through one CDP session. Workers
 * are auto-attached in non-flat mode, so commands reach them through
 * Target.sendMessageToTarget on the page session.
 * @param {import("@playwright/test").CDPSession} client - Page CDP session.
 */
async function startHeapSampler(client) {
    const workers = new Set();
    const pending = new Map();
    let nextId = 0;

    const sendToWorker = (sessionId, method, params = {}) =>
        new Promise((resolve) => {
            nextId += 1;
            const id = nextId;
            pending.set(id, resolve);
            client
                .send("Target.sendMessageToTarget", {
                    sessionId,
                    message: JSON.stringify({ id, method, params }),
                })
                .catch(() => {
                    pending.delete(id);
                    resolve({ error: "detached" });
                });
        });

    client.on("Target.attachedToTarget", (event) => {
        if (event.targetInfo.type !== "worker") {
            return;
        }
        workers.add(event.sessionId);
    });
    client.on("Target.detachedFromTarget", (event) => {
        workers.delete(event.sessionId);
    });
    client.on("Target.receivedMessageFromTarget", (event) => {
        const message = JSON.parse(event.message);
        const resolve = pending.get(message.id);
        if (resolve) {
            pending.delete(message.id);
            resolve(message);
        }
    });
    await client.send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: false,
    });

    const peak = { combined: 0, page: 0, workers: 0 };
    let busy = false;
    let stopped = false;
    const sample = async () => {
        if (busy || stopped) {
            return;
        }
        busy = true;
        try {
            const pageHeap = await client.send("Runtime.getHeapUsage").catch(() => null);
            const replies = await Promise.all(
                [...workers].map((sessionId) => sendToWorker(sessionId, "Runtime.getHeapUsage")),
            );
            const pageUsed = pageHeap ? pageHeap.usedSize : 0;
            const workersUsed = replies.reduce(
                (sum, reply) => sum + (reply.result ? reply.result.usedSize : 0),
                0,
            );
            peak.page = Math.max(peak.page, pageUsed);
            peak.workers = Math.max(peak.workers, workersUsed);
            peak.combined = Math.max(peak.combined, pageUsed + workersUsed);
        } finally {
            busy = false;
        }
    };
    const timer = setInterval(sample, SAMPLE_INTERVAL_MS);
    return {
        sample,
        stop() {
            stopped = true;
            clearInterval(timer);
            return { peak };
        },
    };
}

/**
 * Time one cached filter change on Analytics: switch the range away and back,
 * and time the switch back, which the analytics cache serves. A change counts
 * as done when the total settles, or after two animation frames when the total
 * does not change between the two ranges.
 * @param {import("@playwright/test").Page} page - App page on Analytics.
 */
async function timeCachedFilterChange(page) {
    return page.evaluate(async (settleTimeout) => {
        const total = document.querySelector('[data-testid="analytics-total"]');
        const select = document.getElementById("analyticsTimeRangeSelect");
        const useSelect = select && select.offsetParent !== null;
        const apply = (range) => {
            if (useSelect) {
                select.value = range;
                select.dispatchEvent(new Event("change", { bubbles: true }));
            } else {
                document
                    .querySelector(`#analyticsTimeRangeButtons [data-range="${range}"]`)
                    .click();
            }
        };
        const frames = () =>
            new Promise((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(resolve));
            });
        const change = async (range) => {
            const before = total.textContent;
            const started = performance.now();
            const settled = new Promise((resolve) => {
                const observer = new MutationObserver(() => {
                    if (total.textContent !== before) {
                        observer.disconnect();
                        resolve();
                    }
                });
                observer.observe(total, { childList: true, characterData: true, subtree: true });
                setTimeout(() => {
                    observer.disconnect();
                    resolve();
                }, settleTimeout);
            });
            apply(range);
            await Promise.race([settled, frames().then(() => settled)]);
            await frames();
            return performance.now() - started;
        };
        const active = document.querySelector("#analyticsTimeRangeButtons .active");
        const original = active ? active.dataset.range : "12m";
        const other = original === "all" ? "12m" : "all";
        await change(other);
        return change(original);
    }, FILTER_SETTLE_TIMEOUT_MS);
}

/**
 * One measured run in a fresh browser.
 * @param {ReturnType<typeof parseArgs>} options - Parsed options.
 * @param {string} inputDir - Export directory.
 */
async function measureRun(options, inputDir) {
    const browser = await chromium.launch({ args: options.gpu ? [] : ["--disable-gpu"] });
    const result = {
        analyticsMs: Number.NaN,
        messagesMs: Number.NaN,
        filterMs: Number.NaN,
        peak: { combined: 0, page: 0, workers: 0 },
        crashed: false,
        error: "",
    };
    let sampler = null;
    try {
        const context = await newMeasurementContext(
            browser,
            options.mobile ? devices[MOBILE_DEVICE] : {},
        );
        const page = await context.newPage();
        page.on("crash", () => {
            result.crashed = true;
        });
        const client = await context.newCDPSession(page);
        if (options.cpu > 1) {
            await client.send("Emulation.setCPUThrottlingRate", { rate: options.cpu });
        }
        await page.goto(`${BASE_URL}/#home`);
        sampler = await startHeapSampler(client);
        const ready = routeReady(STEP_TIMEOUT_MS);

        const dropped = performance.now();
        await uploadExport(page, inputDir, STEP_TIMEOUT_MS);
        await openRoute(page, "analytics", STEP_TIMEOUT_MS);
        await ready.analytics(page);
        result.analyticsMs = performance.now() - dropped;
        result.filterMs = await timeCachedFilterChange(page);
        await openRoute(page, "messages", STEP_TIMEOUT_MS);
        await ready.messages(page);
        result.messagesMs = performance.now() - dropped;
        await sampler.sample();
    } catch (error) {
        result.error = result.crashed ? "tab crashed" : error.message.split("\n")[0];
    } finally {
        if (sampler) {
            Object.assign(result, sampler.stop());
        }
        await browser.close();
    }
    return result;
}

const seconds = (ms) => (Number.isFinite(ms) ? (ms / 1000).toFixed(2) : "n/a");
const megabytes = (bytes) => (bytes / MB).toFixed(1);

/**
 * Print per-run lines and the median and range summary.
 * @param {object[]} runs - Run results.
 * @param {ReturnType<typeof parseArgs>} options - Parsed options.
 * @returns {boolean} Whether every run finished within the budget.
 */
function report(runs, options) {
    runs.forEach((result, index) => {
        console.log(
            `RUN ${index + 1}    analytics=${seconds(result.analyticsMs)}s ` +
                `messages=${seconds(result.messagesMs)}s ` +
                `filter=${Number.isFinite(result.filterMs) ? result.filterMs.toFixed(0) : "n/a"}ms ` +
                `peak=${megabytes(result.peak.combined)}MB ` +
                `(page ${megabytes(result.peak.page)}MB, workers ${megabytes(result.peak.workers)}MB) ` +
                `crashed=${result.crashed ? "yes" : "no"}` +
                (result.error ? ` error="${result.error}"` : ""),
        );
    });
    const finished = runs.filter((result) => !result.error);
    const line = (label, values, format) => {
        if (!values.length) {
            return;
        }
        const { median, min, max } = summarize(values);
        console.log(
            `SUMMARY  ${label.padEnd(10)} median=${format(median)} range=${format(min)}-${format(max)}`,
        );
    };
    const inSeconds = (value) => `${seconds(value)}s`;
    const inMilliseconds = (value) => `${value.toFixed(0)}ms`;
    const inMegabytes = (value) => `${megabytes(value)}MB`;
    const pick = (list, key) => list.map((result) => result[key]);
    const peaks = runs.map((result) => result.peak.combined);
    line("analytics", pick(finished, "analyticsMs"), inSeconds);
    line("messages", pick(finished, "messagesMs"), inSeconds);
    line("filter", pick(finished, "filterMs"), inMilliseconds);
    line("peak-heap", peaks, inMegabytes);
    console.log(
        `SETUP    runs=${runs.length} cpu=${options.cpu} gpu=${options.gpu ? 1 : 0} ` +
            `mobile=${options.mobile ? 1 : 0} budget_mb=${options.budgetMb || "none"}` +
            (options.cpu > 1 ? " (cpu throttles the page main thread only)" : ""),
    );
    const worstPeak = Math.max(...peaks);
    const overBudget = options.budgetMb > 0 && worstPeak > options.budgetMb * MB;
    const failed = runs.length - finished.length;
    if (overBudget || failed) {
        const reasons = [
            overBudget ? `peak=${megabytes(worstPeak)}MB budget=${options.budgetMb}MB` : "",
            failed ? `unfinished-runs=${failed}` : "",
        ].filter(Boolean);
        console.log(`RESULT   FAILED ${reasons.join(" ")}`);
        return false;
    }
    console.log("RESULT   MEASURED metric=chromium-page-plus-worker-js-heap");
    return true;
}

async function main() {
    let options;
    try {
        options = parseArgs(process.argv.slice(2));
    } catch (error) {
        console.error(`RESULT   FAILED reason=invalid-options (${error.message})`);
        return 1;
    }

    let inputDir = options.inputDir || join(REPO, "data/input");
    if (!options.inputDir && options.sizeMb > 0) {
        inputDir = join(tmpdir(), `linkedin-analyzer-export-${options.sizeMb}mb`);
        generateLargeExport({ sizeMb: options.sizeMb, dir: inputDir });
        console.log(`INPUT    synthetic export size_mb=${options.sizeMb} dir=${inputDir}`);
    }
    const missing = Object.values(EXPORT_FILES).filter((name) => !existsSync(join(inputDir, name)));
    if (missing.length > 0) {
        console.error(
            `RESULT   FAILED missing-inputs=${missing.length} (missing: ${missing.join(", ")}). ` +
                "Pass size_mb=N for a synthetic export or input_dir=path for your own.",
        );
        return 1;
    }

    await buildApp({ measurementLimits: true });
    const preview = startPreview(PORT);
    try {
        await waitForServer(BASE_URL, preview);
        const runs = [];
        for (let index = 0; index < options.runs; index += 1) {
            runs.push(await measureRun(options, inputDir));
        }
        return report(runs, options) ? 0 : 1;
    } finally {
        await stopPreview(preview);
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        process.exitCode = await main();
    } catch (error) {
        // main() tears the preview down in its finally block; this only
        // guarantees a structured RESULT line on unexpected failures, matching
        // heap-audit.mjs.
        console.error(error);
        console.error("RESULT   FAILED reason=unexpected");
        process.exitCode = 1;
    }
}
