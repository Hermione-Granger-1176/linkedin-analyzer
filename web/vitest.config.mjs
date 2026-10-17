import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

export default defineConfig({
    plugins: [svelte()],
    // Components mount in jsdom, so tests need the browser build of Svelte.
    resolve: { conditions: ["browser"] },
    test: {
        environment: "jsdom",
        include: ["web/tests/**/*.test.js"],
        exclude: ["web/e2e/**"],
        coverage: {
            provider: "v8",
            reportsDirectory: "./coverage",
            // json-summary feeds `make ci-coverage-summary`; html stays for
            // reading a local run, text keeps the terminal output unchanged.
            reporter: ["text", "html", "json-summary"],
            all: true,
            include: ["web/src/**/*.{js,ts,svelte}", "api/**/*.mjs"],
            thresholds: {
                statements: 99,
                branches: 95,
                functions: 99,
                lines: 99,
            },
        },
    },
});
