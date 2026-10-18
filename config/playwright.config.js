const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
    testDir: "../web/e2e",
    timeout: 45000,
    expect: {
        timeout: 10000,
    },
    fullyParallel: false,
    workers: 4,
    forbidOnly: Boolean(process.env.CI),
    retries: process.env.CI ? 1 : 0,
    // Keep retries to identify flaky tests, but fail CI when a retry passes.
    // Playwright otherwise reports those tests with a successful exit status.
    failOnFlakyTests: Boolean(process.env.CI),
    reporter: [["list"], ["html", { open: "never" }]],
    use: {
        baseURL: "http://127.0.0.1:4173",
        headless: true,
        reducedMotion: "reduce",
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
    },
    projects: [
        {
            name: "chromium",
            use: {
                browserName: "chromium",
            },
        },
        {
            name: "firefox",
            use: {
                browserName: "firefox",
            },
        },
        {
            name: "webkit",
            use: {
                browserName: "webkit",
            },
        },
    ],
    webServer: {
        command:
            process.env.PLAYWRIGHT_DEV_SERVER === "1"
                ? "npm run dev -- --host 127.0.0.1 --port 4173 --strictPort"
                : "npm run build && npm run preview -- --host 127.0.0.1 --port 4173 --strictPort",
        url: "http://127.0.0.1:4173",
        reuseExistingServer: !process.env.CI && process.env.PLAYWRIGHT_DEV_SERVER !== "1",
        timeout: 120000,
    },
});
