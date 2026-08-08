const path = require("path");

const { expect, test } = require("@playwright/test");

const { waitForLoadedStatus } = require("./helpers/upload.js");

const FIXTURES = path.join(__dirname, "fixtures");
const SHARES_CSV = path.join(FIXTURES, "Shares.csv");
const COMMENTS_CSV = path.join(FIXTURES, "Comments.csv");
const MESSAGES_CSV = path.join(FIXTURES, "Messages.csv");
const CONNECTIONS_CSV = path.join(FIXTURES, "Connections.csv");

// Viewport presets to audit each screen at (name drives the output subfolder).
const VIEWPORTS = [
    { name: "mobile", width: 375, height: 812 },
    { name: "tablet", width: 768, height: 1024 },
    { name: "desktop", width: 1440, height: 900 },
];

// Hash routes / screen sections rendered by the SPA.
const ROUTES = ["home", "clean", "analytics", "connections", "messages", "insights"];

/**
 * Navigate to a hash route and wait for its screen section to activate and any
 * route-level loading + finite animations to settle before capturing.
 * @param {import('@playwright/test').Page} page - Playwright page instance
 * @param {string} route - Route name (also the screen section suffix)
 */
async function gotoRoute(page, route) {
    await page.evaluate((name) => {
        window.location.hash = `#${name}`;
    }, route);

    const screen = page.locator(`#screen-${route}`);
    await expect(screen).toHaveClass(/\bactive\b/, { timeout: 15000 });
    await expect(screen).toBeVisible({ timeout: 15000 });

    // Route content may hydrate asynchronously (workers, charts).
    await expect(page.locator(".screen.is-loading")).toHaveCount(0, { timeout: 15000 });

    // Let finite animations finish so canvases and layout settle.
    await page.waitForFunction(
        () =>
            document
                .getAnimations()
                .filter(
                    (animation) =>
                        animation.effect && animation.effect.getTiming().iterations !== Infinity,
                )
                .every((animation) => animation.playState === "finished"),
        { timeout: 10000 },
    );

    // A short beat past a couple of rAF ticks lets ResizeObserver-driven charts
    // redraw after any viewport change before we snapshot.
    await page.evaluate(
        () =>
            new Promise((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined)));
            }),
    );
    await page.waitForTimeout(400);
}

test.describe("viewport screenshots", () => {
    // Opt-in capture harness: no-op unless an output dir is requested.
    test.skip(!process.env.SCREENS_DIR, "Set SCREENS_DIR to capture screenshots");

    test("capture every screen at each viewport", async ({ page }, testInfo) => {
        test.skip(testInfo.project.name !== "chromium", "Capture on chromium only");
        test.setTimeout(240000);

        const outDir = process.env.SCREENS_DIR;
        if (!outDir) {
            return;
        }

        await page.addInitScript(() => {
            /** @type {Window & { __LINKEDIN_ANALYZER_DISABLE_TUTORIALS__?: boolean }} */
            const globalWindow = window;
            globalWindow.__LINKEDIN_ANALYZER_DISABLE_TUTORIALS__ = true;
        });

        // Upload every fixture once so all screens have real content.
        await page.goto("/#home");
        await page
            .getByTestId("upload-input")
            .setInputFiles([SHARES_CSV, COMMENTS_CSV, MESSAGES_CSV, CONNECTIONS_CSV]);
        await waitForLoadedStatus(page, "sharesStatus", 30000);
        await waitForLoadedStatus(page, "commentsStatus", 30000);
        await waitForLoadedStatus(page, "messagesStatus", 30000);
        await waitForLoadedStatus(page, "connectionsStatus", 30000);

        for (const viewport of VIEWPORTS) {
            await page.setViewportSize({ width: viewport.width, height: viewport.height });
            for (const route of ROUTES) {
                await gotoRoute(page, route);
                await page.screenshot({
                    path: path.join(outDir, viewport.name, `${route}.png`),
                    fullPage: true,
                });
            }
        }

        // Extra mobile capture: the home nav expanded via the hamburger toggle.
        await page.setViewportSize({ width: 375, height: 812 });
        await gotoRoute(page, "home");
        await page.locator("#screen-home .nav-toggle").click();
        await expect(page.locator("#topNav-home")).toBeVisible();
        await page.screenshot({
            path: path.join(outDir, "mobile", "home-menu-open.png"),
            fullPage: true,
        });
    });
});
