const fs = require("fs");
const path = require("path");

const { expect, test } = require("@playwright/test");

// Synthetic comments export with known cleaned outputs: a plain row, four
// formula-injection payloads (= + - @), and a row whose message carries an
// XML-illegal control character. The Python validator asserts the workbook
// internals; this spec only proves the real browser produces and saves the file.
const FIXTURE = path.join(__dirname, "fixtures", "BrowserXlsx.csv");

/**
 * Upload one or more CSV fixtures using the hidden file input.
 * @param {import('@playwright/test').Page} page - Playwright page instance
 * @param {string[]} files - Absolute fixture paths
 */
async function uploadFiles(page, files) {
    await page.goto("/#home");
    await page.getByTestId("upload-input").setInputFiles(files);
}

/**
 * Wait for one file status row to switch from default to loaded,
 * then wait for the progress overlay to disappear.
 * @param {import('@playwright/test').Page} page - Playwright page instance
 * @param {string} id - Status element id
 */
async function waitForLoadedStatus(page, id) {
    await expect(page.locator(`#${id}`)).not.toHaveText("Not uploaded", { timeout: 20000 });
    await expect(page.locator("#progressOverlay")).toBeHidden({ timeout: 20000 });
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        window.__LINKEDIN_ANALYZER_DISABLE_TUTORIALS__ = true;
    });
});

test("browser generates and downloads a real comments xlsx workbook", async ({ page }, testInfo) => {
    await uploadFiles(page, [FIXTURE]);
    await waitForLoadedStatus(page, "commentsStatus");

    await page.locator('#screen-home a.hub-card[data-route="clean"]').click();
    await expect(page).toHaveURL(/#clean/);

    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("clean-download-btn").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename().toLowerCase()).toContain("comments");

    // The Make target points BROWSER_XLSX_OUT at a private temp file it later
    // validates and removes. Without it, fall back to a per-test, per-project
    // output path so a direct `make test-e2e` run cannot collide across browsers.
    const outputPath = process.env.BROWSER_XLSX_OUT || testInfo.outputPath("Comments.xlsx");
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    await download.saveAs(outputPath);
    expect(fs.existsSync(outputPath)).toBe(true);
});
