export default {
    // Stylelint resolves ignoreFiles against the directory holding this config,
    // not the working directory, so every pattern climbs out of config/ first.
    // Written without the prefix they matched nothing at all, and a local
    // `make test-js` before `make lint-css` linted the coverage report.
    ignoreFiles: [
        "../node_modules/**",
        "../.venv/**",
        "../.playwright/**",
        "../coverage/**",
        "../web/coverage/**",
        "../web/dist/**",
        "../playwright-report/**",
        "../test-results/**",
    ],
    rules: {
        "block-no-empty": true,
        "color-no-invalid-hex": true,
        "declaration-block-no-duplicate-properties": true,
        "font-family-no-duplicate-names": true,
        "function-calc-no-unspaced-operator": true,
        "keyframe-block-no-duplicate-selectors": true,
        "media-feature-name-no-unknown": true,
        "named-grid-areas-no-invalid": true,
        "no-descending-specificity": null,
        "no-duplicate-at-import-rules": true,
        "no-duplicate-selectors": null,
        "property-no-unknown": true,
        "selector-pseudo-class-no-unknown": true,
        "selector-pseudo-element-no-unknown": true,
        "string-no-newline": true,
        "unit-no-unknown": true,
    },
};
