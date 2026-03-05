const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
    testDir: './web/e2e',
    timeout: 45000,
    expect: {
        timeout: 10000
    },
    fullyParallel: false,
    forbidOnly: Boolean(process.env.CI),
    retries: process.env.CI ? 1 : 0,
    reporter: [
        ['list'],
        ['html', { open: 'never' }]
    ],
    use: {
        baseURL: 'http://127.0.0.1:4173',
        headless: true,
        reducedMotion: 'reduce',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure'
    },
    projects: [
        {
            name: 'chromium',
            use: {
                browserName: 'chromium'
            }
        },
        {
            name: 'firefox',
            use: {
                browserName: 'firefox'
            }
        }
    ],
    webServer: {
        command: 'npm run dev -- --host 127.0.0.1 --port 4173 --strictPort',
        url: 'http://127.0.0.1:4173',
        reuseExistingServer: !process.env.CI,
        timeout: 120000
    }
});
