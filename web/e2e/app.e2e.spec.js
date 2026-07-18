const path = require("path");

const AxeBuilder = require("@axe-core/playwright").default;
const { expect, test } = require("@playwright/test");

const SHARES_CSV = path.join(__dirname, "fixtures", "Shares.csv");
const COMMENTS_CSV = path.join(__dirname, "fixtures", "Comments.csv");
const MESSAGES_CSV = path.join(__dirname, "fixtures", "Messages.csv");
const CONNECTIONS_CSV = path.join(__dirname, "fixtures", "Connections.csv");
const INVALID_CSV = path.join(__dirname, "fixtures", "Invalid.csv");

/**
 * Upload one or more CSV fixtures using the hidden file input.
 * @param {import('@playwright/test').Page} page - Playwright page instance
 * @param {string[]} files - Absolute fixture paths
 */
async function uploadFiles(page, files) {
    await page.goto("/#home");
    await page.getByTestId("upload-input").setInputFiles(files);
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        window.__LINKEDIN_ANALYZER_DISABLE_TUTORIALS__ = true;
    });
});

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

/**
 * Run an axe scan after route-level loading and finite animations settle.
 * @param {import('@playwright/test').Page} page - Playwright page instance
 */
async function runAxeScan(page) {
    await expect(page.locator(".screen.is-loading")).toHaveCount(0, { timeout: 5000 });
    await page.waitForFunction(
        () =>
            document
                .getAnimations()
                .filter(
                    (animation) =>
                        animation.effect && animation.effect.getTiming().iterations !== Infinity,
                )
                .every((animation) => animation.playState === "finished"),
        { timeout: 5000 },
    );

    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();

    const critical = results.violations.filter(
        (violation) => violation.impact === "critical" || violation.impact === "serious",
    );
    expect(critical).toEqual([]);
}

test("upload shares and render clean preview", async ({ page }) => {
    await uploadFiles(page, [SHARES_CSV]);
    await waitForLoadedStatus(page, "sharesStatus");

    await page.locator('#screen-home a.hub-card[data-route="clean"]').click();
    await expect(page).toHaveURL(/#clean/);

    const previewTable = page.getByTestId("clean-preview-table");
    await expect(previewTable.locator("tbody tr").first()).toBeVisible();
    await expect(page.locator("#cleanFileInfo")).toContainText("Shares -");
});

test("download cleaned excel from clean screen", async ({ page }) => {
    await uploadFiles(page, [SHARES_CSV]);
    await waitForLoadedStatus(page, "sharesStatus");

    await page.locator('#screen-home a.hub-card[data-route="clean"]').click();
    await expect(page).toHaveURL(/#clean/);

    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("clean-download-btn").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename().toLowerCase()).toContain("shares");
});

test("upload shares+comments and render analytics", async ({ page }) => {
    await uploadFiles(page, [SHARES_CSV, COMMENTS_CSV]);
    await waitForLoadedStatus(page, "sharesStatus");
    await waitForLoadedStatus(page, "commentsStatus");

    const openAnalyticsBtn = page.getByTestId("open-analytics-btn");
    await expect(openAnalyticsBtn).toBeEnabled({ timeout: 20000 });
    await openAnalyticsBtn.click();

    await expect(page).toHaveURL(/#analytics/);
    await expect(page.getByTestId("analytics-grid")).toBeVisible();
    await expect(page.getByTestId("analytics-empty")).toBeHidden();
    await expect(page.getByTestId("analytics-total")).not.toHaveText("0");
});

test("upload connections and render connections dashboard", async ({ page }) => {
    await uploadFiles(page, [CONNECTIONS_CSV]);
    await waitForLoadedStatus(page, "connectionsStatus");

    await page.locator('#screen-home a.hub-card[data-route="connections"]').click();
    await expect(page).toHaveURL(/#connections/);

    await expect(page.locator("#connectionsGrid")).toBeVisible();
    await expect(page.locator("#connectionsEmpty")).toBeHidden();
    await expect(page.locator("#connStatTotal")).not.toHaveText("0");
});

test("upload messages+connections and render relationship insights", async ({ page }) => {
    await uploadFiles(page, [MESSAGES_CSV, CONNECTIONS_CSV]);
    await waitForLoadedStatus(page, "messagesStatus");
    await waitForLoadedStatus(page, "connectionsStatus");

    await page.locator('#screen-home a.hub-card[data-route="messages"]').click();
    await expect(page).toHaveURL(/#messages/);

    await expect(page.locator("#messagesLayout")).toBeVisible();
    await expect(page.locator("#messagesEmpty")).toBeHidden();
    await expect(page.locator("#topContactsList li").first()).toBeVisible();
});

test("upload shares+comments and render insights", async ({ page }) => {
    await uploadFiles(page, [SHARES_CSV, COMMENTS_CSV]);
    await waitForLoadedStatus(page, "sharesStatus");
    await waitForLoadedStatus(page, "commentsStatus");

    await page.locator('#screen-home a.hub-card[data-route="insights"]').click();
    await expect(page).toHaveURL(/#insights/);

    await expect(page.locator("#insightsGrid")).toBeVisible();
    await expect(page.locator("#insightsEmpty")).toBeHidden();
    // A real insight card (not a loading skeleton) has a heading and body.
    await expect(page.locator("#insightsGrid .insight-card h3").first()).toBeVisible();
    await expect(page.locator("#insightsGrid .insight-card p").first()).not.toBeEmpty();

    await runAxeScan(page);
});

test("mobile hamburger menu opens, navigates, and closes", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/#home");

    const toggle = page.locator("#screen-home .nav-toggle");
    const nav = page.locator("#topNav-home");

    // The pill row is collapsed behind the toggle at this width.
    await expect(toggle).toBeVisible();
    await expect(nav).toBeHidden();

    await toggle.click();
    await expect(nav).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");

    // Accessibility check with the menu open at the mobile viewport.
    await runAxeScan(page);

    await page.locator('#topNav-home a.top-link[data-route="analytics"]').click();
    await expect(page).toHaveURL(/#analytics/);
    await expect(nav).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("mobile time-range select replaces the chip row on analytics", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await uploadFiles(page, [SHARES_CSV, COMMENTS_CSV]);
    await waitForLoadedStatus(page, "sharesStatus");
    await waitForLoadedStatus(page, "commentsStatus");

    const openAnalyticsBtn = page.getByTestId("open-analytics-btn");
    await expect(openAnalyticsBtn).toBeEnabled({ timeout: 20000 });
    await openAnalyticsBtn.click();
    await expect(page).toHaveURL(/#analytics/);
    await expect(page.getByTestId("analytics-grid")).toBeVisible();

    // At this width the chip row collapses into the compact native select.
    await expect(page.locator("#analyticsTimeRangeButtons")).toBeHidden();
    const select = page.locator("#analyticsTimeRangeSelect");
    await expect(select).toBeVisible();

    // Selecting a range drives the same route sync as the chips.
    await select.selectOption("all");
    await expect(page).toHaveURL(/range=all/);

    // The label wires an accessible name onto the select; keep the state clean.
    await runAxeScan(page);
});

test("shows an error hint for malformed CSV uploads", async ({ page }) => {
    await uploadFiles(page, [INVALID_CSV]);
    await expect(page.locator("#uploadHint")).toContainText("Could not auto-detect file type");
});

const TELEMETRY_CONSENT_KEY = "linkedin-analyzer:telemetry-consent";

test("telemetry consent: grant, dismiss, and revoke flow", async ({ page }) => {
    // Force the diagnostics offer without baking a Sentry DSN into the build, so
    // the banner/footer render but enabling never actually starts the SDK.
    await page.addInitScript(() => {
        window.__LINKEDIN_ANALYZER_FORCE_TELEMETRY_OFFER__ = true;
    });
    await page.goto("/#home");

    const banner = page.locator("#telemetryBanner");
    const toggle = page.getByTestId("telemetry-toggle");
    const footer = page.locator("#appFooter");

    // Banner prompts and the footer toggle starts in the off state.
    await expect(banner).toBeVisible();
    await expect(footer).toBeVisible();
    await expect(toggle).toHaveText(/Turn on/);
    await expect(toggle).toHaveAttribute("aria-pressed", "false");

    // Dismissing the banner leaves the footer control in place.
    await page.locator("#telemetryDismissBtn").click();
    await expect(banner).toBeHidden();
    await expect(footer).toBeVisible();

    // Enabling from the footer persists consent and flips the control on.
    await toggle.click();
    await expect(toggle).toHaveText(/Turn off/);
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate((key) => localStorage.getItem(key), TELEMETRY_CONSENT_KEY)).toBe(
        "granted",
    );

    // Consent survives a reload, and the banner no longer re-prompts.
    await page.reload();
    await expect(banner).toBeHidden();
    await expect(toggle).toHaveText(/Turn off/);

    // Revoking clears stored consent.
    await toggle.click();
    await expect(toggle).toHaveText(/Turn on/);
    expect(
        await page.evaluate((key) => localStorage.getItem(key), TELEMETRY_CONSENT_KEY),
    ).toBeNull();
});

test("analytics screen has no critical accessibility violations", async ({ page }) => {
    await uploadFiles(page, [SHARES_CSV, COMMENTS_CSV]);
    await waitForLoadedStatus(page, "sharesStatus");
    await waitForLoadedStatus(page, "commentsStatus");

    const openAnalyticsBtn = page.getByTestId("open-analytics-btn");
    await expect(openAnalyticsBtn).toBeEnabled({ timeout: 20000 });
    await openAnalyticsBtn.click();
    await expect(page).toHaveURL(/#analytics/);
    await expect(page.getByTestId("analytics-grid")).toBeVisible();

    await runAxeScan(page);
});

test("core data screens have no critical accessibility violations", async ({ page }) => {
    await uploadFiles(page, [SHARES_CSV, COMMENTS_CSV, MESSAGES_CSV, CONNECTIONS_CSV]);
    await waitForLoadedStatus(page, "sharesStatus");
    await waitForLoadedStatus(page, "commentsStatus");
    await waitForLoadedStatus(page, "messagesStatus");
    await waitForLoadedStatus(page, "connectionsStatus");

    await runAxeScan(page);

    await page.locator('#screen-home a.hub-card[data-route="clean"]').click();
    await expect(page).toHaveURL(/#clean/);
    await expect(page.getByTestId("clean-preview-table").locator("tbody tr").first()).toBeVisible();
    await runAxeScan(page);

    await page.goto("/#home");
    await page.locator('#screen-home a.hub-card[data-route="connections"]').click();
    await expect(page).toHaveURL(/#connections/);
    await expect(page.locator("#connectionsGrid")).toBeVisible();
    await expect(page.locator("#connectionsEmpty")).toBeHidden();
    await runAxeScan(page);

    await page.goto("/#home");
    await page.locator('#screen-home a.hub-card[data-route="messages"]').click();
    await expect(page).toHaveURL(/#messages/);
    await expect(page.locator("#messagesLayout")).toBeVisible();
    await expect(page.locator("#messagesEmpty")).toBeHidden();
    await expect(page.locator("#topContactsList li").first()).toBeVisible();
    await runAxeScan(page);
});
