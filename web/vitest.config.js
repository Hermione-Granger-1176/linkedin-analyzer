import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "jsdom",
        include: ["web/tests/**/*.test.js"],
        exclude: ["web/e2e/**"],
        coverage: {
            provider: "v8",
            reportsDirectory: "./coverage",
            all: true,
            include: ["web/src/**/*.js", "api/**/*.mjs"],
            thresholds: {
                statements: 99,
                branches: 95,
                functions: 99,
                lines: 99,
            },
        },
    },
});
