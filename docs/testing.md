# Testing

The repository tests the Python package, browser application, cross-runtime cleaner behavior, repository automation, and production build. Use the narrowest target that answers your question, then run the full gate before review.

Speed and memory checks live in [Benchmarks](benchmarks.md).

## Run Python tests

Run the Python suite with coverage:

```bash
make test-py
```

The suite covers `src/linkedin_analyzer/` and `scripts/`. Python coverage must reach 100 percent for statements and branches. The test command writes a machine-readable report to `.artifacts/coverage/python-coverage.json`.

Generate an HTML report when you need to inspect missing lines:

```bash
make test-py ARGS="--cov-report=html"
```

Run a subset while iterating:

```bash
make test-py ARGS="-k cleaner --no-cov"
```

The `--no-cov` option is for local iteration only. The normal target includes coverage and the 100 percent threshold.

## Run browser unit tests

Run the Vitest suite:

```bash
make test-js
```

Vitest uses `jsdom`, includes every JavaScript module under `web/src/` and `api/`, and writes its reports under `coverage/`. The JavaScript thresholds are 99 percent for statements, lines, and functions, and 95 percent for branches.

Run a focused Vitest subset without coverage:

```bash
make test-js-quick ARGS="analytics"
```

Use `make test-js` before review so the configured coverage thresholds run.

## Run browser end-to-end tests

Install the browsers first:

```bash
make setup-playwright
```

Run headless tests on Chromium, Firefox, and WebKit:

```bash
make test-e2e
```

Select one project or one spec:

```bash
make test-e2e ARGS="--project=chromium web/e2e/app.e2e.spec.js"
```

Use headed or UI mode while debugging:

```bash
make test-e2e-headed
make test-e2e-ui
```

On a host without browser libraries, run `make setup-playwright-local`, then pass `local_libs=1`:

```bash
make test-e2e local_libs=1
```

Use the hosted CI container when Docker is available. It runs the same browser runtime as GitHub Actions:

```bash
make test-e2e-container
```

The Playwright configuration uses a built preview server at `http://127.0.0.1:4173`, four workers, and retries only in CI. Set `PLAYWRIGHT_DEV_SERVER=1` to use the Vite dev server instead. A test that passes on its retry fails the CI job as flaky.

## Validate exported workbooks

Run the browser download check when a change affects Excel generation or browser file handling:

```bash
make test-browser-xlsx local_libs=1
```

The target downloads a real browser workbook, then validates it with `openpyxl` against `web/e2e/fixtures/BrowserXlsx.expected.json`.

## Check cleaner parity

The Python and browser cleaners must produce matching cleaned values for the parity fixtures. Run both test suites with:

```bash
make test
```

Regenerate the synthetic corpus only after an intentional cleaner behavior change:

```bash
make gen-parity-corpus
make test
```

The generator writes checked-in fixtures. Review the fixture diff and expected output before you accept it.

Use the local cross-runtime checks for a private export in `data/input/`:

```bash
make cleaner-diff
make xrt-diff
```

Pass `strict=1` when missing private input or an unavailable comparison should fail. Use `input_dir=path` and `xlsx_dir=path` when the export does not use the default directories.

## Run documentation and repository checks

Run the checks that protect the repository interface:

```bash
make editorconfig-check
make lint-doc-commands
make lint-make-targets
make align-tables-check
make lint-workflows
```

`make lint-doc-commands` checks that contributor docs use Make targets. `make lint-make-targets` checks that named targets exist and rejects new raw shell control flow in Make recipes. `make align-tables-check` checks Markdown table pipes without modifying files.

## Run the full gate and print coverage totals

Run the full non-browser gate with `make ci`. Run browser tests too with `make check`. The [CI page](ci.md#understand-ci) lists the workflow jobs and explains path gating and failure triage.

After `make test`, print the coverage totals CI uses:

```bash
make ci-coverage-summary
```

The summary reads `.artifacts/coverage/python-coverage.json` and `coverage/coverage-summary.json`. Missing reports become notes when an earlier test failed. An unreadable report remains an error.
