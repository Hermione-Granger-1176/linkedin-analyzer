const path = require("path");

const { expect, test } = require("@playwright/test");

const { uploadFiles, waitForLoadedStatus } = require("./helpers/upload.js");

const ROUTES = ["home", "clean", "analytics", "connections", "messages", "insights"];

test.use({ deviceScaleFactor: 2 });

test("dashboard layout stays bounded and charts redraw across viewport changes", async ({
    page,
}) => {
    test.setTimeout(120000);
    await page.addInitScript(() => {
        /** @type {Window & { __LINKEDIN_ANALYZER_DISABLE_TUTORIALS__?: boolean }} */
        const globalWindow = window;
        globalWindow.__LINKEDIN_ANALYZER_DISABLE_TUTORIALS__ = true;
    });
    await uploadFiles(
        page,
        ["Shares", "Comments", "Messages", "Connections"].map((name) =>
            path.join(__dirname, "fixtures", `${name}.csv`),
        ),
    );
    for (const name of ["shares", "comments", "messages", "connections"]) {
        await waitForLoadedStatus(page, `${name}Status`);
    }

    for (const width of [320, 375, 540, 541, 615, 616, 768, 1024, 1440, 1920, 2560]) {
        await page.setViewportSize({ width, height: width === 1920 ? 1080 : 900 });
        for (const route of ROUTES) {
            await page.evaluate((name) => {
                window.location.hash = name;
            }, route);
            const screen = page.locator(`#screen-${route}`);
            await expect(screen).toHaveClass(/\bactive\b/);
            await expect(page.locator(".screen.is-loading")).toHaveCount(0);
            await expect(page.locator("#appFooter")).toBeVisible();
            await expect(async () => {
                const dimensions = await screen
                    .locator(".chart-canvas-wrap canvas")
                    .evaluateAll((canvases) =>
                        canvases
                            .filter((canvas) => canvas.getBoundingClientRect().width > 0)
                            .map((element) => {
                                const canvas = /** @type {HTMLCanvasElement} */ (element);
                                const box = canvas.getBoundingClientRect();
                                return {
                                    actual: [canvas.width, canvas.height],
                                    expected: [
                                        Math.round(Math.round(box.width) * window.devicePixelRatio),
                                        Math.round(
                                            Math.round(box.height) * window.devicePixelRatio,
                                        ),
                                    ],
                                };
                            }),
                    );
                for (const dimensionsOfChart of dimensions) {
                    expect(dimensionsOfChart.actual).toEqual(dimensionsOfChart.expected);
                }
            }).toPass({ timeout: 5000 });

            const layout = await screen.evaluate((element) => {
                const cards = [
                    ...element.querySelectorAll(".chart-card, .message-panel, .insight-card"),
                ];
                return {
                    height: document.documentElement.scrollHeight,
                    chartOverflow: [...element.querySelectorAll(".chart-canvas-wrap")].map(
                        (wrap) => ({
                            mobileHeatmap:
                                window.innerWidth <= 540 && wrap.parentElement?.id === "heatmapCard",
                            horizontal: wrap.scrollWidth - wrap.clientWidth,
                            vertical: wrap.scrollHeight - wrap.clientHeight,
                        }),
                    ),
                    overflowingCards: cards.filter((card) => {
                        const box = card.getBoundingClientRect();
                        return box.left < 0 || box.right > window.innerWidth;
                    }).length,
                };
            });
            expect(layout.overflowingCards, `${route} at ${width}px`).toBe(0);
            for (const overflow of layout.chartOverflow) {
                if (!overflow.mobileHeatmap) {
                    expect(overflow.horizontal, `${route} chart at ${width}px`).toBeLessThanOrEqual(
                        1,
                    );
                }
                expect(overflow.vertical, `${route} chart at ${width}px`).toBeLessThanOrEqual(1);
            }
            await page.waitForTimeout(250);
            expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(
                layout.height,
            );
        }
    }

    await page.setViewportSize({ width: 320, height: 900 });
    await page.evaluate(() => {
        window.location.hash = "analytics";
    });
    const heatmap = page.locator("#heatmapChart");
    await expect(heatmap).toBeVisible();
    const box = await heatmap.evaluate((canvas) => ({
        width: canvas.clientWidth,
        height: canvas.clientHeight,
    }));
    await heatmap.evaluate((canvas) => {
        const wrap = canvas.parentElement;
        if (!wrap) {
            throw new Error("Heatmap is missing its scroll wrapper");
        }
        wrap.scrollLeft = wrap.scrollWidth;
    });
    // On phones, the final hour stays reachable through the heatmap's own scroller.
    await heatmap.click({ position: { x: box.width - 22, y: box.height - 30 } });
    await expect(page.locator("#screen-analytics .active-filters")).toContainText("Hour: 23:00");
    await expect(page.locator("#screen-analytics .active-filters")).toContainText("Day: Sun");
});
