const { expect, test } = require("@playwright/test");

const OVERRIDE_KEY = "linkedin-analyzer-effects";
// Keyframe keys that describe timing rather than an animated property.
const KEYFRAME_META = new Set(["offset", "computedOffset", "easing", "composite"]);

// The suite runs with reduced motion, which always wins over the tier. These
// tests compare the tiers' own animations, so they allow motion.
test.use({ reducedMotion: "no-preference" });

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        /** @type {Window & { __LINKEDIN_ANALYZER_DISABLE_TUTORIALS__?: boolean }} */
        const globalWindow = window;
        globalWindow.__LINKEDIN_ANALYZER_DISABLE_TUTORIALS__ = true;
    });
});

/**
 * Open the app and wait until the effects tier has been picked.
 * @param {import('@playwright/test').Page} page - Playwright page instance
 * @returns {Promise<string|undefined>} The tier on the root element
 */
async function openAndReadTier(page) {
    await page.goto("/#home");
    await expect(page.getByTestId("effects-toggle")).toHaveAttribute("data-override", /.+/);
    return page.evaluate(() => document.documentElement.dataset.effects);
}

/**
 * Count WebGL context requests the page makes from now on.
 * @param {import('@playwright/test').Page} page - Playwright page instance
 */
async function countWebglRequests(page) {
    await page.addInitScript(() => {
        const globalWindow = /** @type {Window & { __webglRequests: number }} */ (
            /** @type {unknown} */ (window)
        );
        globalWindow.__webglRequests = 0;
        /** @param {{ getContext: (...args: never[]) => unknown } | null} proto */
        const wrap = (proto) => {
            if (!proto) {
                return;
            }
            const original = proto.getContext;
            /** @this {unknown} */
            proto.getContext = function getContext(type, ...rest) {
                if (String(type).startsWith("webgl")) {
                    globalWindow.__webglRequests += 1;
                }
                return original.call(this, type, ...rest);
            };
        };
        wrap(HTMLCanvasElement.prototype);
        wrap(typeof OffscreenCanvas === "function" ? OffscreenCanvas.prototype : null);
    });
}

/**
 * List the properties every running animation changes.
 * @param {import('@playwright/test').Page} page - Playwright page instance
 * @returns {Promise<string[]>}
 */
function readAnimatedProperties(page) {
    return page.evaluate(
        (meta) =>
            document.getAnimations().flatMap((animation) =>
                /** @type {KeyframeEffect} */ (animation.effect)
                    .getKeyframes()
                    .flatMap((frame) => Object.keys(frame))
                    .filter((key) => !meta.includes(key)),
            ),
        [...KEYFRAME_META],
    );
}

const isCompositorOnly = (/** @type {string} */ name) => name === "transform" || name === "opacity";

/**
 * Read how many WebGL contexts the page has asked for.
 * @param {import('@playwright/test').Page} page - Playwright page instance
 * @returns {Promise<number>}
 */
function readWebglRequests(page) {
    return page.evaluate(
        () => /** @type {Window & { __webglRequests?: number }} */ (window).__webglRequests || 0,
    );
}

test("without a GPU, gets no higher than the standard tier", async ({
    baseURL,
    browserName,
    playwright,
}) => {
    test.skip(browserName !== "chromium", "--disable-gpu is a Chromium switch");
    // A browser of its own, because the switch applies at launch.
    const browser = await playwright.chromium.launch({ args: ["--disable-gpu"] });
    try {
        const page = await browser.newPage({ baseURL });
        await page.addInitScript(() => {
            /** @type {Window & { __LINKEDIN_ANALYZER_DISABLE_TUTORIALS__?: boolean }} */
            const globalWindow = window;
            globalWindow.__LINKEDIN_ANALYZER_DISABLE_TUTORIALS__ = true;
        });
        expect(["lite", "standard"]).toContain(await openAndReadTier(page));
    } finally {
        await browser.close();
    }
});

test("Save-Data gets the lite tier", async ({ page }) => {
    await page.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, "connection", {
            configurable: true,
            get: () => ({ saveData: true }),
        });
    });
    expect(await openAndReadTier(page)).toBe("lite");
});

test("the Lite override creates no WebGL context and animates only transform and opacity", async ({
    page,
}) => {
    await countWebglRequests(page);
    await page.addInitScript((key) => {
        localStorage.setItem(key, "lite");
    }, OVERRIDE_KEY);

    expect(await openAndReadTier(page)).toBe("lite");
    await expect(page.getByTestId("effects-toggle")).toHaveAttribute("data-override", "lite");

    expect(await readWebglRequests(page)).toBe(0);
    // Wait for the decoration layer to start its animations before checking them.
    await expect.poll(async () => (await readAnimatedProperties(page)).length).toBeGreaterThan(0);
    const animated = await readAnimatedProperties(page);
    expect(animated.filter((name) => !isCompositorOnly(name))).toEqual([]);
});

test("Auto probes WebGL once and the toggle cycles through every choice", async ({ page }) => {
    await countWebglRequests(page);
    const tier = await openAndReadTier(page);
    // Above lite, the home screen runs repaint-heavy moves too, which is what
    // makes the Lite check above meaningful.
    if (tier !== "lite") {
        await expect
            .poll(async () =>
                (await readAnimatedProperties(page)).some((name) => !isCompositorOnly(name)),
            )
            .toBe(true);
    }
    const probes = await readWebglRequests(page);
    expect(probes).toBeGreaterThan(0);
    expect(probes).toBeLessThanOrEqual(2);

    const toggle = page.getByTestId("effects-toggle");
    await toggle.click();
    await expect(toggle).toHaveAttribute("data-override", "lite");
    await expect(page.locator("html")).toHaveAttribute("data-effects", "lite");
    await toggle.click();
    await expect(toggle).toHaveAttribute("data-override", "full");
    await toggle.click();
    await expect(toggle).toHaveAttribute("data-override", "auto");
    await expect(toggle).toHaveAccessibleName("Visual effects: Auto. Select to change.");

    // The choice persists across a reload.
    await toggle.click();
    await page.reload();
    await expect(page.getByTestId("effects-toggle")).toHaveAttribute("data-override", "lite");
    // Changing the choice never probes WebGL again in this page.
    expect(await readWebglRequests(page)).toBe(0);
});
