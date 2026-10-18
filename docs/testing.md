# Testing

The repository tests the Python package, browser application, cross-runtime cleaner behavior, repository automation, and production build. Use the narrowest target that answers your question, then run the full gate before review.

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

On a host that needs the repository-local runtime, prepare it with `make setup-playwright-local`, then pass `local_libs=1`:

```bash
make test-e2e local_libs=1
```

Use the hosted CI container when Docker is available and you want the same immutable browser runtime as GitHub Actions:

```bash
make test-e2e-container
```

The Playwright configuration uses a built preview server at `http://127.0.0.1:4173`, four workers, and retries only in CI. A test that passes on its retry fails the CI job as flaky.

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

## Run local checks and benchmarks

The checks below read a private export when one exists. They skip cleanly when the input directory is absent unless you pass `strict=1`:

```bash
make bench
make bench-decode
make audit-memory-python
make audit-memory-browser local_libs=1
make audit-state
make explore
```

Use these commands to investigate performance or memory. Do not commit private exports or generated reports.

Without a private export, generate a synthetic one and point the checks at it with `input_dir=path`:

```bash
make gen-large-export size_mb=100
make gen-large-export size_mb=30 dir=/tmp/export-30mb
```

The generator writes `messages.csv`, `Connections.csv`, `Shares.csv`, and `Comments.csv` under the system temp directory by default and refuses to write inside the repository. The same size always produces the same bytes. The data has one self account, a few thousand contacts with stable profile URLs (including different people who share a name), conversation IDs tied to participants, multi-year dates, and message bodies with commas, quotes, line breaks, emoji, and non-Latin scripts.

Run `make bench-browser` to measure uploads and screen loading in Chromium. The benchmark builds and serves the app privately in `measurement` mode. Each run opens a fresh browser and uploads the export. The default is three runs.

The report includes times from file drop to Analytics and Messages showing data, plus one cached Analytics filter change. It also records the combined peak JavaScript heap of the page and workers, and whether the tab crashed. Output includes each run, followed by the median and range.

Measurement limits in `web/src/shared/limits.js` match the production limits of 128 MiB per file, 128 Mi characters, and 1,000,000 rows. To investigate larger inputs, change the measurement limits there. Production builds ignore those measurement settings.

```bash
make bench-browser size_mb=55
make bench-browser size_mb=100 cpu=6 gpu=0 mobile=1 budget_mb=300
make bench-browser input_dir=data/input runs=5
```

Use `size_mb=N` to generate a synthetic export before the run. Otherwise, `input_dir` defaults to `data/input`. The generated `messages.csv` occupies 80% of the export size. If any file exceeds the measurement limit, the benchmark stops before launching a browser.

Use these options to change the run:

- `cpu=N` applies Chromium CPU throttling.
- `gpu=0` launches with `--disable-gpu`.
- `mobile=1` uses a Pixel 7 viewport with touch.
- `budget_mb=N` fails a run when its combined peak JavaScript heap exceeds the budget.

Runs use reduced motion so timeline animations cannot end a filter timing early. The memory budget compares designs and detects regressions. It does not establish a safe limit for phones. Sampling excludes browser, graphics, and native memory, and can miss short peaks.

CPU throttling slows only the page's main thread. Chromium rejects it on worker targets, and a measured worker loop ran at the same speed at rates 1 and 4, so throttled timings understate slow-device time for work done in workers.

The [large-export investigation](large-export-investigation.md) records the October 2026 measurements, intermediate designs, and measurement limitations.

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

## Run the full gate

Run the full non-browser gate with:

```bash
make ci
```

Run browser tests too with:

```bash
make check
```

The primary CI workflow runs quick gates, heavy checks, Python compatibility, Node compatibility, browser E2E, and one `CI result` rollup. The workflow skips area-specific heavy jobs only when `make ci-changed-areas` proves that the area did not change. Read [operations](operations.md#understand-ci) for the workflow order and failure triage.

## Interpret coverage summaries

After `make test`, print the totals used by CI:

```bash
make ci-coverage-summary
```

The summary reads `.artifacts/coverage/python-coverage.json` and `coverage/coverage-summary.json`. Missing reports become notes when an earlier test failed. An unreadable report remains an error.
