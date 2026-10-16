/*
 * Shared helpers for scripts that drive the built web app in Chromium.
 *
 * Builds and serves the production bundle from a private preview server,
 * uploads an export, and waits for each analytics route to finish its real
 * IndexedDB reads and Web Worker processing. heap-audit.mjs and
 * browser-bench.mjs both use it, so their upload and readiness logic stays
 * identical.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "@playwright/test";

export const REPO = fileURLToPath(new URL("../..", import.meta.url));
// Match the Makefile's overridable NPM launcher instead of hard-coding "npm".
const NPM = process.env.NPM || "npm";
const SERVER_TIMEOUT_MS = 120000;
const KILL_TIMEOUT_MS = 5000;
// Per-attempt fetch cap so a socket that accepts but never answers cannot hang
// past the overall readiness deadline.
const PROBE_TIMEOUT_MS = 2000;

export const EXPORT_FILES = {
    shares: "Shares.csv",
    comments: "Comments.csv",
    messages: "messages.csv",
    connections: "Connections.csv",
};
const STATUS_IDS = ["sharesStatus", "commentsStatus", "messagesStatus", "connectionsStatus"];
// Confirms a readiness response is our own app, not an unrelated listener that
// held the port before strictPort forced the preview process to exit.
const APP_TITLE_MARKER = "<title>LinkedIn Analyzer</title>";
// Persisted consent plus a build-time DSN is what starts Sentry; clearing this
// key before boot keeps measurement runs reliably no-telemetry.
const TELEMETRY_CONSENT_KEY = "linkedin-analyzer:telemetry-consent";

/**
 * Per-route readiness signals, copied from web/e2e/app.e2e.spec.js, so each
 * route's real IndexedDB reads and Web Worker processing complete before a
 * measurement. Keys drive both the hash navigation and the wait.
 * @param {number} timeout - Wait limit in milliseconds.
 */
export function routeReady(timeout) {
    return {
        analytics: async (page) => {
            await expect(page.getByTestId("analytics-grid")).toBeVisible({ timeout });
            await expect(page.getByTestId("analytics-total")).not.toHaveText("0", { timeout });
        },
        messages: async (page) => {
            await expect(page.locator("#messagesLayout")).toBeVisible({ timeout });
            await expect(page.locator("#topContactsList li").first()).toBeVisible({ timeout });
        },
        connections: async (page) => {
            await expect(page.locator("#connectionsGrid")).toBeVisible({ timeout });
            await expect(page.locator("#connStatTotal")).not.toHaveText("0", { timeout });
        },
        insights: async (page) => {
            await expect(page.locator("#insightsGrid")).toBeVisible({ timeout });
            await expect(page.locator("#insightsGrid .insight-card h3").first()).toBeVisible({
                timeout,
            });
        },
    };
}

/**
 * Run a child process to completion, rejecting on a nonzero exit.
 * @param {string} command - Executable.
 * @param {string[]} args - Arguments.
 */
export function run(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: REPO, stdio: "inherit" });
        child.on("error", reject);
        child.on("exit", (code, signal) => {
            if (code === 0) {
                resolve();
            } else {
                const reason = signal ? `signal ${signal}` : `code ${code}`;
                reject(new Error(`${command} exited with ${reason}`));
            }
        });
    });
}

/** Build the production bundle. */
export function buildApp() {
    return run(NPM, ["run", "build"]);
}

/**
 * Serve the built bundle. detached lets us kill the whole preview process group
 * (npm plus vite) on teardown.
 * @param {number} port - Port to listen on.
 */
export function startPreview(port) {
    return spawn(
        NPM,
        ["run", "preview", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
        { cwd: REPO, stdio: "ignore", detached: true },
    );
}

/**
 * SIGTERM the preview process group and wait for it to exit, escalating to
 * SIGKILL if it lingers. A hard deadline guarantees the promise always resolves
 * so teardown can never block shutdown, even if the process never reports exit
 * or process-group signals are unsupported on this platform.
 * @param {import("node:child_process").ChildProcess} preview - Preview process.
 */
export function stopPreview(preview) {
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

/**
 * Poll until the preview answers, failing fast if its child dies first so a
 * stale or unrelated listener on the port can never be mistaken for readiness.
 * @param {string} url - Preview URL.
 * @param {import("node:child_process").ChildProcess} preview - Preview process.
 */
export async function waitForServer(url, preview) {
    let childExit = null;
    const onExit = (code, signal) => {
        childExit = signal ? `signal ${signal}` : `code ${code}`;
    };
    const onError = (error) => {
        childExit = error.message;
    };
    preview.on("exit", onExit);
    preview.on("error", onError);
    // The child may have already exited (for example strictPort found the port
    // taken) before these listeners attached; seed from its recorded state so
    // fail-fast stays reliable.
    if (preview.exitCode !== null) {
        childExit = `code ${preview.exitCode}`;
    } else if (preview.signalCode !== null) {
        childExit = `signal ${preview.signalCode}`;
    }
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
                const body = response.ok ? await response.text() : "";
                if (childExit === null && body.includes(APP_TITLE_MARKER)) {
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

/**
 * Open a measurement context: no traces, screenshots, video, or downloads, no
 * first-run tutorial, and no stored telemetry consent.
 * @param {import("@playwright/test").Browser} browser - Browser.
 * @param {object} [options] - Extra context options, such as a mobile device.
 */
export async function newMeasurementContext(browser, options = {}) {
    const context = await browser.newContext({ ...options, acceptDownloads: false });
    await context.addInitScript((consentKey) => {
        window.__LINKEDIN_ANALYZER_DISABLE_TUTORIALS__ = true;
        try {
            localStorage.removeItem(consentKey);
        } catch {
            // localStorage may be unavailable before first navigation.
        }
    }, TELEMETRY_CONSENT_KEY);
    return context;
}

/**
 * Upload the four export files and wait until every status leaves "Not
 * uploaded" and the progress overlay closes.
 * @param {import("@playwright/test").Page} page - App page on #home.
 * @param {string} inputDir - Directory holding the export files.
 * @param {number} timeout - Wait limit in milliseconds.
 */
export async function uploadExport(page, inputDir, timeout) {
    await page
        .getByTestId("upload-input")
        .setInputFiles(Object.values(EXPORT_FILES).map((name) => join(inputDir, name)));
    for (const id of STATUS_IDS) {
        await page.waitForFunction(
            (statusId) => {
                const element = document.getElementById(statusId);
                return Boolean(element) && element.textContent.trim() !== "Not uploaded";
            },
            id,
            { timeout },
        );
    }
    await page.locator("#progressOverlay").waitFor({ state: "hidden", timeout });
}

/**
 * Navigate within the SPA by changing the hash rather than reloading, so the
 * upload and every screen accumulate in one continuous session.
 * @param {import("@playwright/test").Page} page - App page.
 * @param {string} route - Route name without the hash.
 * @param {number} timeout - Wait limit in milliseconds.
 */
export async function openRoute(page, route, timeout) {
    await page.evaluate((target) => {
        window.location.hash = target;
    }, `#${route}`);
    await page.waitForFunction((target) => window.location.hash.includes(target), route, {
        timeout,
    });
}
