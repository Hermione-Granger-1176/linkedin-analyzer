import globals from "globals";

export default [
    {
        files: ["web/js/**/*.js", "web/tests/**/*.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "script",
            globals: {
                ...globals.browser,
                ...globals.node,
                ...globals.es2021,
                SketchCharts: "readonly",
                Storage: "readonly",
                LinkedInCleaner: "readonly",
                ExcelGenerator: "readonly",
                AnalyticsEngine: "readonly",
                XLSX: "readonly",
                rough: "readonly",
                CustomEvent: "readonly",
                indexedDB: "readonly",
                importScripts: "readonly",
            },
        },
        rules: {
            "no-var": "error",
            "prefer-const": "error",
            "no-unused-vars": ["error", { args: "none", varsIgnorePattern: "^(Storage)$" }],
            "no-undef": "error",
            eqeqeq: ["error", "always"],
            "no-console": "off",
        },
    },
    {
        files: ["web/js/analytics-worker.js"],
        languageOptions: {
            globals: {
                ...globals.worker,
            },
        },
    },
    {
        files: ["web/tests/**/*.js"],
        languageOptions: {
            globals: {
                ...globals.node,
            },
        },
    },
];
