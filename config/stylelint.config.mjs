export default {
    // Relative to config/, not to the repository root. Stylelint resolves
    // ignoreFiles against the basedir, and `--config config/stylelint.config.mjs`
    // with no `--config-basedir` makes that this file's own directory, so every
    // pattern has to climb out of config/ first. Written root-relative, as they
    // were, they resolved to config/node_modules, config/coverage and so on:
    // the whole list matched nothing, and a local `make test-js` before
    // `make lint-css` linted the coverage report.
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
