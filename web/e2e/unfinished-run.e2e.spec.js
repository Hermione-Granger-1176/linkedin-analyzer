const fs = require("fs");
const os = require("os");
const path = require("path");

const { expect, test } = require("@playwright/test");

const MARKER_PREFIX = "linkedin-analyzer:run:";
const CONSENT_KEY = "linkedin-analyzer:telemetry-consent";
// A recent marker with no answering owner is rechecked once it turns stale
// (three 5-second heartbeats), so the "did not finish" notice can take up to
// about 15 seconds after a crash.
const NOTICE_TIMEOUT_MS = 30000;

let exportDir = "";
let messagesCsv = "";

// A synthetic messages file large enough that processing is still running
// when the test acts on it.
test.beforeAll(async () => {
    const { generateLargeExport } = await import("../../scripts/fixtures/gen-large-export.mjs");
    exportDir = fs.mkdtempSync(path.join(os.tmpdir(), "unfinished-run-e2e-"));
    generateLargeExport({ sizeMb: 40, dir: exportDir });
    messagesCsv = path.join(exportDir, "messages.csv");
});

test.afterAll(() => {
    fs.rmSync(exportDir, { recursive: true, force: true });
});

test.beforeEach(async ({ context }) => {
    await context.addInitScript((consentKey) => {
        /** @type {Window & { __LINKEDIN_ANALYZER_DISABLE_TUTORIALS__?: boolean, __LINKEDIN_ANALYZER_TELEMETRY_SINK__?: unknown[] }} */
        const globalWindow = window;
        globalWindow.__LINKEDIN_ANALYZER_DISABLE_TUTORIALS__ = true;
        globalWindow.__LINKEDIN_ANALYZER_TELEMETRY_SINK__ = [];
        localStorage.setItem(consentKey, "granted");
    }, CONSENT_KEY);
});

/**
 * Start processing the large file and wait until its run marker exists.
 * @param {import('@playwright/test').Page} page - Playwright page instance
 */
async function startProcessing(page) {
    await page.goto("/#home");
    await page.getByTestId("upload-input").setInputFiles([messagesCsv]);
    await page.waitForFunction(
        (prefix) => Object.keys(localStorage).some((key) => key.startsWith(prefix)),
        MARKER_PREFIX,
    );
}

/**
 * Read the telemetry events the app recorded to the test sink.
 * @param {import('@playwright/test').Page} page - Playwright page instance
 * @returns {Promise<unknown[]|undefined>}
 */
function readTelemetrySink(page) {
    return page.evaluate(() => {
        /** @type {Window & { __LINKEDIN_ANALYZER_TELEMETRY_SINK__?: unknown[] }} */
        const globalWindow = window;
        return globalWindow.__LINKEDIN_ANALYZER_TELEMETRY_SINK__;
    });
}

/**
 * Count run markers left in localStorage.
 * @param {import('@playwright/test').Page} page - Playwright page instance
 * @returns {Promise<number>}
 */
function countMarkers(page) {
    return page.evaluate(
        (prefix) => Object.keys(localStorage).filter((key) => key.startsWith(prefix)).length,
        MARKER_PREFIX,
    );
}

test("a crash during processing shows the notice and reports once", async ({
    browserName,
    context,
    page,
}) => {
    test.skip(browserName !== "chromium", "Page.crash is a Chromium DevTools command");
    await startProcessing(page);

    const client = await context.newCDPSession(page);
    // The renderer dies before it can answer, so do not wait for a reply.
    client.send("Page.crash").catch(() => {});
    await page.waitForEvent("crash");

    const next = await context.newPage();
    await next.goto("/#home");
    await expect(next.getByTestId("unfinished-run-banner")).toBeVisible({
        timeout: NOTICE_TIMEOUT_MS,
    });
    await expect(next.getByTestId("unfinished-run-banner")).toContainText("did not finish");
    expect(await readTelemetrySink(next)).toEqual([
        {
            message: "processing-unfinished",
            sizeBucket: "30-60mb",
            memoryBucket: expect.any(String),
            mode: "single",
        },
    ]);
    expect(await countMarkers(next)).toBe(0);

    await next.locator("#unfinishedRunDismissBtn").click();
    await expect(next.getByTestId("unfinished-run-banner")).toBeHidden();
});

test("a reload during processing shows no notice", async ({ page }) => {
    await startProcessing(page);
    await page.reload();

    // The left marker is removed at startup without a report.
    await expect.poll(() => countMarkers(page)).toBe(0);
    await expect(page.getByTestId("unfinished-run-banner")).toBeHidden();
    expect(await readTelemetrySink(page)).toEqual([]);
});

test("a second tab does not report a run still going in the first", async ({ context, page }) => {
    await startProcessing(page);

    const second = await context.newPage();
    await second.goto("/#home");
    // Let the ownership check settle while the first tab is still processing.
    await second.waitForTimeout(1000);
    await expect(second.getByTestId("unfinished-run-banner")).toBeHidden();

    await expect(page.locator("#messagesStatus")).not.toHaveText("Not uploaded", {
        timeout: 60000,
    });
    await expect.poll(() => countMarkers(page), { timeout: 10000 }).toBe(0);
    await expect(second.getByTestId("unfinished-run-banner")).toBeHidden();
    expect(await readTelemetrySink(second)).toEqual([]);
});
