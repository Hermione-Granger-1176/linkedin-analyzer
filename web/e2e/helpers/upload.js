const { expect } = require("@playwright/test");

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
 * Wait for one file status row to switch from default to loaded, then wait for
 * the progress overlay to disappear.
 * @param {import('@playwright/test').Page} page - Playwright page instance
 * @param {string} id - Status element id
 * @param {number} [timeout=20000] - Maximum wait per assertion in milliseconds
 */
async function waitForLoadedStatus(page, id, timeout = 20000) {
    await expect(page.locator(`#${id}`)).not.toHaveText("Not uploaded", { timeout });
    await expect(page.locator("#progressOverlay")).toBeHidden({ timeout });
}

module.exports = { uploadFiles, waitForLoadedStatus };
