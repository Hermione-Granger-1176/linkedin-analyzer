import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'jsdom',
        include: ['web/tests/**/*.test.js'],
        exclude: ['web/e2e/**'],
        coverage: {
            provider: 'v8',
            reportsDirectory: './coverage',
            all: true,
            include: ['web/src/**/*.js'],
            thresholds: {
                statements: 95,
                branches: 85,
                functions: 96,
                lines: 96
            }
        }
    }
});
