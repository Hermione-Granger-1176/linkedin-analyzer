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
    // A test that fails and then passes on its retry is reported flaky and, by
    // default, exits zero, so the job goes green with the failure buried in its
    // log. The retry stays, because passing on a second run is what tells a
    // flake apart from a break, but on CI the flake is the result rather than a
    // footnote nobody reads.
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
        command: "npm run build && npm run preview -- --host 127.0.0.1 --port 4173 --strictPort",
        url: "http://127.0.0.1:4173",
        reuseExistingServer: !process.env.CI,
        timeout: 120000,
    },
});
