const path = require("path");

const { expect, test } = require("@playwright/test");

const { uploadFiles, waitForLoadedStatus } = require("./helpers/upload.js");

test("local data processing does not match the tracking-script filter", async ({
    page,
    context,
}) => {
    // EasyPrivacy's /analytics/analytics.js filter also matches local module URLs.
    // Development serves those modules individually, unlike the bundled build.
    const blocked = [];
    await context.route(/\/analytics\/analytics\.js/, async (route) => {
        blocked.push(route.request().url());
        await route.abort("blockedbyclient");
    });
    await page.addInitScript(() => {
        /** @type {Window & { __LINKEDIN_ANALYZER_DISABLE_TUTORIALS__?: boolean }} */
        const globalWindow = window;
        globalWindow.__LINKEDIN_ANALYZER_DISABLE_TUTORIALS__ = true;
    });
    await uploadFiles(page, [path.join(__dirname, "fixtures", "Shares.csv")]);
    await waitForLoadedStatus(page, "sharesStatus");
    await expect(page.getByTestId("open-analytics-btn")).toBeEnabled();
    await page.getByTestId("open-analytics-btn").click();
    await expect(page.getByTestId("analytics-total")).toHaveText("1");
    expect(blocked).toEqual([]);
});
