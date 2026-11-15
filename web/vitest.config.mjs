import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

export default defineConfig({
    plugins: [svelte()],
    // Components mount in jsdom and use the browser build of Svelte.
    resolve: { conditions: ["browser"] },
    test: {
        environment: "jsdom",
        include: ["web/tests/**/*.test.js"],
        coverage: {
            provider: "v8",
            reportsDirectory: "./coverage",
            // json-summary feeds `make ci-coverage-summary`. html is written for
            // local runs; text prints to the terminal.
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
