import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'jsdom',
        coverage: {
            provider: 'v8',
            thresholds: {
                lines: 90,
                branches: 85,
                functions: 90
            }
        }
    }
});
