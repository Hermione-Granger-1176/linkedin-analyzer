const fs = require("fs");
const path = require("path");

const AxeBuilder = require("@axe-core/playwright").default;
const { expect, test } = require("@playwright/test");

const SHARES_CSV = path.join(__dirname, "fixtures", "Shares.csv");
const COMMENTS_CSV = path.join(__dirname, "fixtures", "Comments.csv");
const MESSAGES_CSV = path.join(__dirname, "fixtures", "Messages.csv");

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

test("save as PDF downloads a real PDF including message contents", async ({ page }, testInfo) => {
    await uploadFiles(page, [SHARES_CSV, COMMENTS_CSV, MESSAGES_CSV]);
    await waitForLoadedStatus(page, "sharesStatus");
    await waitForLoadedStatus(page, "commentsStatus");
    await waitForLoadedStatus(page, "messagesStatus");

    const trigger = page.locator("#pdfExportBtn");
    await expect(trigger).toBeEnabled({ timeout: 20000 });
    await trigger.click();

    const dialog = page.locator("#pdfExportDialog");
    await expect(dialog).toBeVisible();

    const includeMessages = page.locator("#pdfExportIncludeMessages");
    await expect(includeMessages).not.toBeChecked();

    // Axe over the open dialog, matching the scan the other specs run.
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const critical = results.violations.filter(
        (violation) => violation.impact === "critical" || violation.impact === "serious",
    );
    expect(critical).toEqual([]);

    await includeMessages.check();

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#pdfExportConfirmBtn").click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/^linkedin-insights-\d{4}-\d{2}-\d{2}\.pdf$/);

    const outputPath = testInfo.outputPath("linkedin-insights.pdf");
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    await download.saveAs(outputPath);

    const bytes = fs.readFileSync(outputPath);
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("%PDF");
    expect(bytes.byteLength).toBeGreaterThan(5000);

    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
});

test("save as PDF works in dark mode and closes on Escape", async ({ page }) => {
    await uploadFiles(page, [SHARES_CSV, COMMENTS_CSV]);
    await waitForLoadedStatus(page, "sharesStatus");
    await waitForLoadedStatus(page, "commentsStatus");

    await page.locator("#themeToggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    const trigger = page.locator("#pdfExportBtn");
    await expect(trigger).toBeEnabled({ timeout: 20000 });
    await trigger.click();
    await expect(page.locator("#pdfExportDialog")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator("#pdfExportDialog")).toBeHidden();
    await expect(trigger).toBeFocused();

    // The document reads its colors off a detached .theme-light probe, so the
    // warm light palette has to resolve even while the page is dark.
    const probed = await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.className = "theme-light";
        document.body.appendChild(probe);
        const styles = getComputedStyle(probe);
        const read = (token) => styles.getPropertyValue(token).trim();
        const values = {
            bgPrimary: read("--bg-primary"),
            textPrimary: read("--text-primary"),
            accentBlue: read("--accent-blue"),
            accentYellowBg: read("--accent-yellow-bg"),
        };
        probe.remove();
        return values;
    });

    // The build minifies the token values, so these are compared as colors
    // rather than as the exact text in variables.css.
    expect(probed.bgPrimary.toLowerCase()).toMatch(/^(#fffdf7|rgba?\(255,\s?253,\s?247(,\s?1)?\))$/);
    expect(probed.textPrimary.toLowerCase()).toMatch(/^(#1c1917|rgba?\(28,\s?25,\s?23(,\s?1)?\))$/);
    expect(probed.accentBlue.toLowerCase()).toMatch(
        /^(#4285f4|rgba?\(66,\s?133,\s?244(,\s?1)?\))$/,
    );
    // The tinted tokens keep their alpha, in whichever form the minifier picks.
    expect(probed.accentYellowBg.toLowerCase()).toMatch(/^(#fbbc0526|rgba\(251,\s?188,\s?5,\s?\.?0?\.?15\))$/);

    // Opted in with no messages export uploaded: the section is simply omitted
    // and the export still succeeds.
    await trigger.click();
    await page.locator("#pdfExportIncludeMessages").check();
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#pdfExportConfirmBtn").click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toContain("linkedin-insights-");
});
