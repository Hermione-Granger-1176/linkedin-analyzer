import globals from "globals";
import importPlugin from "eslint-plugin-import-x";
import jsdoc from "eslint-plugin-jsdoc";

export default [
    {
        files: ["web/src/**/*.js", "web/tests/**/*.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "module",
            globals: {
                ...globals.browser,
                ...globals.es2021,
                CustomEvent: "readonly",
                indexedDB: "readonly",
            },
        },
        plugins: {
            "import-x": importPlugin,
            jsdoc,
        },
        rules: {
            "no-var": "error",
            "prefer-const": "error",
            "no-unused-vars": ["error", { args: "none" }],
            "no-undef": "error",
            eqeqeq: ["error", "always"],
            "no-console": ["error", { allow: ["error"] }],
            "curly": ["error", "all"],
            "no-shadow": "error",
            "no-use-before-define": ["error", { functions: false, classes: true, variables: false }],
            "no-implicit-globals": "error",
            "no-eval": "error",
            "no-implied-eval": "error",
            "no-extend-native": "error",
            "no-throw-literal": "error",
            "prefer-promise-reject-errors": "error",
            "no-async-promise-executor": "error",
            "no-undef-init": "error",
            "no-multi-assign": "error",
            "no-return-await": "error",
            "no-unneeded-ternary": "error",
            "no-useless-catch": "error",
            "no-useless-constructor": "error",
            "object-shorthand": ["error", "always"],
            "prefer-template": "error",
            "prefer-arrow-callback": "error",
            "arrow-body-style": ["error", "as-needed"],
            "consistent-return": "error",
            "default-case-last": "error",
            "dot-notation": "error",
            "yoda": "error",
            "import-x/no-unresolved": "error",
            "import-x/no-duplicates": "error",
            "import-x/newline-after-import": "error",
            "import-x/first": "error",
            "import-x/no-mutable-exports": "error",
            "import-x/no-self-import": "error",
            "import-x/no-cycle": ["error", { maxDepth: 3 }],
            "import-x/order": ["error", {
                groups: ["builtin", "external", "internal", "parent", "sibling", "index"],
                "newlines-between": "always",
                alphabetize: { order: "asc", caseInsensitive: true }
            }],
            "import-x/extensions": ["error", "ignorePackages", { js: "always" }],
            "jsdoc/check-alignment": "error",
            "jsdoc/check-indentation": "error",
            "jsdoc/check-param-names": "error",
            "jsdoc/check-tag-names": "error",
            "jsdoc/check-types": "error",
            "jsdoc/require-param": "error",
            "jsdoc/require-param-type": "error",
            "jsdoc/require-returns": "error",
            "jsdoc/require-returns-type": "error",
            "jsdoc/valid-types": "error",
        },
    },
    {
        files: ["web/src/**/*-worker.js"],
        languageOptions: {
            globals: {
                ...globals.worker,
            },
        },
    },
    {
        files: ["web/src/sw.js"],
        languageOptions: {
            globals: {
                ...globals.serviceworker,
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
        rules: {
            "jsdoc/require-param": "off",
            "jsdoc/require-param-type": "off",
            "jsdoc/require-returns": "off",
            "jsdoc/require-returns-type": "off",
        },
    },
];
