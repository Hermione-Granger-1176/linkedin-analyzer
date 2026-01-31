module.exports = {
    root: true,
    env: {
        browser: true,
        node: true,
        es2022: true,
        worker: true
    },
    parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'script'
    },
    globals: {
        SketchCharts: 'readonly',
        Storage: 'readonly',
        LinkedInCleaner: 'readonly',
        ExcelGenerator: 'readonly',
        AnalyticsEngine: 'readonly',
        XLSX: 'readonly',
        rough: 'readonly',
        CustomEvent: 'readonly',
        indexedDB: 'readonly',
        importScripts: 'readonly'
    },
    rules: {
        'no-var': 'error',
        'prefer-const': 'error',
        'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^(Storage)$' }],
        'no-undef': 'error',
        'eqeqeq': ['error', 'always'],
        'no-console': 'off'
    },
    overrides: [
        {
            files: ['web/js/analytics-worker.js'],
            env: {
                worker: true
            }
        },
        {
            files: ['web/tests/**/*.js'],
            env: {
                node: true
            }
        }
    ]
};
