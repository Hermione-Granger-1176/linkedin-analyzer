/*
 * Main renderer JS heap audit for the real web app over a local export.
 *
 * Builds the production bundle, serves it from a private preview server, then
 * drives the real upload -> analytics -> messages -> connections -> insights
 * flow in Chromium with the real private export. It reports only the main
 * renderer JS heap (Chromium's Performance.getMetrics): used, total, and the
 * peak used seen across screens. Web Worker heaps are not included, so this is
 * the main-thread heap, not a whole-process total. No per-item or content
 * values are read, and traces, screenshots, video, downloads, and telemetry
 * stay disabled. This establishes a measurement, not a budget.
 *
 * Usage (prefer the Makefile):
 *   make audit-memory-browser local_libs=1
 *   make audit-memory-browser local_libs=1 strict=1
 *   make audit-memory-browser local_libs=1 input_dir=/private/export
 *
 * Requires your private LinkedIn export in data/input (never committed). The
 * script skips cleanly when those files are absent. Chromium only; the heap
 * metric is Chromium-specific and its exact value depends on the browser
 * version and garbage-collection timing.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, expect } from "@playwright/test";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
// Match the Makefile's overridable NPM launcher instead of hard-coding "npm".
const NPM = process.env.NPM || "npm";
// A distinct port from the e2e webServer (4173) so the two never collide.
const PORT = 4319;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SERVER_TIMEOUT_MS = 120000;
const STATUS_TIMEOUT_MS = 20000;
const KILL_TIMEOUT_MS = 5000;
// Per-attempt fetch cap so a socket that accepts but never answers cannot hang
// past the overall readiness deadline.
const PROBE_TIMEOUT_MS = 2000;

const FILES = {
    shares: "Shares.csv",
    comments: "Comments.csv",
    messages: "messages.csv",
    connections: "Connections.csv",
};
const STATUS_IDS = ["sharesStatus", "commentsStatus", "messagesStatus", "connectionsStatus"];

// Per-route readiness signals, copied from web/e2e/app.e2e.spec.js, so each
// surface's real IndexedDB reads and Web Worker processing complete before the
// heap is sampled. Keys drive both the hub-card click and the wait.
const ROUTE_READY = {
    analytics: async (page) => {
        await expect(page.getByTestId("analytics-grid")).toBeVisible({
            timeout: STATUS_TIMEOUT_MS,
        });
        await expect(page.getByTestId("analytics-total")).not.toHaveText("0", {
            timeout: STATUS_TIMEOUT_MS,
        });
    },
    messages: async (page) => {
        await expect(page.locator("#messagesLayout")).toBeVisible({ timeout: STATUS_TIMEOUT_MS });
        await expect(page.locator("#topContactsList li").first()).toBeVisible({
            timeout: STATUS_TIMEOUT_MS,
        });
    },
    connections: async (page) => {
        await expect(page.locator("#connectionsGrid")).toBeVisible({ timeout: STATUS_TIMEOUT_MS });
        await expect(page.locator("#connStatTotal")).not.toHaveText("0", {
            timeout: STATUS_TIMEOUT_MS,
        });
    },
    insights: async (page) => {
        await expect(page.locator("#insightsGrid")).toBeVisible({ timeout: STATUS_TIMEOUT_MS });
        await expect(page.locator("#insightsGrid .insight-card h3").first()).toBeVisible({
            timeout: STATUS_TIMEOUT_MS,
        });
    },
};

function parseArgs(argv) {
    const options = { inputDir: join(REPO, "data/input"), strict: false };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--strict") {
            options.strict = true;
        } else if (argument === "--input-dir") {
            index += 1;
            if (index >= argv.length) {
                throw new Error("invalid options");
            }
            options.inputDir = argv[index];
        } else {
            throw new Error("invalid options");
        }
    }
    return options;
}

// Run a child process to completion, rejecting on a nonzero exit.
function run(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: REPO, stdio: "inherit" });
        child.on("error", reject);
        child.on("exit", (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`${command} exited with ${code}`));
            }
        });
    });
}

// Serve the built bundle. detached lets us kill the whole preview process group
// (npm plus vite) on teardown.
function startPreview() {
    return spawn(
        NPM,
        ["run", "preview", "--", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"],
        { cwd: REPO, stdio: "ignore", detached: true },
    );
}

// SIGTERM the preview process group and wait for it to exit, escalating to
// SIGKILL if it lingers. A hard deadline guarantees the promise always resolves
// so teardown can never block shutdown, even if the process never reports exit
// or process-group signals are unsupported on this platform.
function stopPreview(preview) {
    if (!preview || preview.pid === undefined || preview.exitCode !== null) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        let settled = false;
        let killTimer = null;
        let hardTimer = null;
        const finish = () => {
            if (settled) {
                return;
            }
            settled = true;
            if (killTimer) {
                clearTimeout(killTimer);
            }
            if (hardTimer) {
                clearTimeout(hardTimer);
            }
            resolve();
        };
        // Prefer signalling the whole group; fall back to the single pid when
        // negative-pid group signals are unsupported or the group is gone.
        const signal = (name) => {
            try {
                process.kill(-preview.pid, name);
            } catch {
                try {
                    process.kill(preview.pid, name);
                } catch {
                    finish();
                }
            }
        };
        preview.once("exit", finish);
        // Resolve no matter what after a bounded wait past the SIGKILL attempt.
        hardTimer = setTimeout(finish, 2 * KILL_TIMEOUT_MS);
        signal("SIGTERM");
        killTimer = setTimeout(() => signal("SIGKILL"), KILL_TIMEOUT_MS);
    });
}

// Poll until the preview answers, failing fast if its child dies first so a
// stale or unrelated listener on the port can never be mistaken for readiness.
async function waitForServer(url, preview) {
    let childExit = null;
    const onExit = (code, signal) => {
        childExit = signal ? `signal ${signal}` : `code ${code}`;
    };
    const onError = (error) => {
        childExit = error.message;
    };
    preview.on("exit", onExit);
    preview.on("error", onError);
    try {
        const deadline = Date.now() + SERVER_TIMEOUT_MS;
        while (Date.now() < deadline) {
            if (childExit !== null) {
                throw new Error(`preview server exited before becoming ready (${childExit})`);
            }
            try {
                const response = await fetch(url, {
                    redirect: "manual",
                    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
                });
                if (childExit === null && response.status >= 200 && response.status < 500) {
                    return;
                }
            } catch {
                // The server is not accepting connections yet.
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        throw new Error("preview server did not become ready");
    } finally {
        preview.off("exit", onExit);
        preview.off("error", onError);
    }
}

// Read the main renderer JS heap for the page via a CDP session.
async function readHeap(client) {
    const { metrics } = await client.send("Performance.getMetrics");
    const byName = Object.fromEntries(metrics.map((metric) => [metric.name, metric.value]));
    return { used: byName.JSHeapUsedSize ?? 0, total: byName.JSHeapTotalSize ?? 0 };
}

async function measureHeap(browser, inputDir) {
    // Leave traces, screenshots, video, and downloads off; never enable Sentry.
    const context = await browser.newContext({ acceptDownloads: false });
    // Disable the first-run tutorial overlay exactly as the e2e specs do.
    await context.addInitScript(() => {
        window.__LINKEDIN_ANALYZER_DISABLE_TUTORIALS__ = true;
    });
    const page = await context.newPage();
    const client = await context.newCDPSession(page);
    await client.send("Performance.enable");

    let peakUsed = 0;

    try {
        await page.goto(`${BASE_URL}/#home`);
        await page
            .getByTestId("upload-input")
            .setInputFiles(Object.values(FILES).map((name) => join(inputDir, name)));

        for (const id of STATUS_IDS) {
            await page.waitForFunction(
                (statusId) => {
                    const element = document.getElementById(statusId);
                    return Boolean(element) && element.textContent.trim() !== "Not uploaded";
                },
                id,
                { timeout: STATUS_TIMEOUT_MS },
            );
        }
        await page.locator("#progressOverlay").waitFor({
            state: "hidden",
            timeout: STATUS_TIMEOUT_MS,
        });

        const afterUpload = await readHeap(client);
        peakUsed = Math.max(peakUsed, afterUpload.used);

        // Exercise each analytics surface so the heap reflects a full session,
        // waiting for each route's real completion signal before sampling.
        for (const [route, waitReady] of Object.entries(ROUTE_READY)) {
            await page.goto(`${BASE_URL}/#home`);
            await page.locator(`#screen-home a.hub-card[data-route="${route}"]`).click();
            await page.waitForFunction((target) => window.location.hash.includes(target), route, {
                timeout: STATUS_TIMEOUT_MS,
            });
            await waitReady(page);
            const afterRoute = await readHeap(client);
            peakUsed = Math.max(peakUsed, afterRoute.used);
        }

        const final = await readHeap(client);
        peakUsed = Math.max(peakUsed, final.used);
        return { usedBytes: final.used, totalBytes: final.total, peakUsedBytes: peakUsed };
    } finally {
        await context.close();
    }
}

function report({ usedBytes, totalBytes, peakUsedBytes }) {
    const mb = (bytes) => (bytes / (1024 * 1024)).toFixed(1);
    console.log(
        `HEAP     used=${mb(usedBytes)}MB total=${mb(totalBytes)}MB peak-used=${mb(peakUsedBytes)}MB`,
    );
    console.log("RESULT   MEASURED metric=chromium-main-renderer-js-heap");
}

async function main() {
    let options;
    try {
        options = parseArgs(process.argv.slice(2));
    } catch {
        console.error("RESULT   FAILED reason=invalid-options");
        return 1;
    }

    const missing = Object.values(FILES).filter(
        (name) => !existsSync(join(options.inputDir, name)),
    );
    if (missing.length > 0) {
        if (options.strict) {
            console.error(
                `RESULT   FAILED missing-inputs=${missing.length} (missing: ${missing.join(", ")})`,
            );
            return 1;
        }
        console.log(
            `SKIP: no local export in data/input (missing: ${missing.join(", ")}). ` +
                "This audit needs your private LinkedIn export.",
        );
        return 0;
    }

    await run(NPM, ["run", "build"]);
    const preview = startPreview();
    try {
        await waitForServer(BASE_URL, preview);
        const browser = await chromium.launch();
        try {
            report(await measureHeap(browser, options.inputDir));
        } finally {
            await browser.close();
        }
        return 0;
    } finally {
        await stopPreview(preview);
    }
}

process.exitCode = await main();
