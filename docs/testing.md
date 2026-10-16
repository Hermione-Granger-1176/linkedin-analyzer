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
make explore
```

Use these commands to investigate performance or memory. Do not commit private exports or generated reports.

Without a private export, generate a synthetic one and point the checks at it with `input_dir=path`:

```bash
make gen-large-export size_mb=100
make gen-large-export size_mb=30 dir=/tmp/export-30mb
```

The generator writes `messages.csv`, `Connections.csv`, `Shares.csv`, and `Comments.csv` under the system temp directory by default and refuses to write inside the repository. The same size always produces the same bytes. The data has one self account, a few thousand contacts with stable profile URLs (including different people who share a name), conversation IDs tied to participants, multi-year dates, and message bodies with commas, quotes, line breaks, emoji, and non-Latin scripts.

`make bench-browser` times the real browser flow. It builds the bundle in `measurement` mode, which raises the upload limits to 128 MiB per file, 128 Mi characters, and 1,000,000 rows (`web/src/shared/limits.js`; a production build always ignores this), serves it privately, and for each run (3 by default) opens a fresh Chromium, uploads the export, and reports the time from file drop to Analytics and to Messages showing data, one cached Analytics filter change, the combined peak JS heap of the page and every worker, and whether the tab crashed. It prints each run, then the median and range:

```bash
make bench-browser size_mb=55
make bench-browser size_mb=100 cpu=6 gpu=0 mobile=1 budget_mb=300
make bench-browser input_dir=data/input runs=5
```

`size_mb=N` generates a synthetic export of that size first; otherwise `input_dir` defaults to `data/input`. `cpu=N` applies Chromium CPU throttling, `gpu=0` launches with `--disable-gpu`, and `mobile=1` uses a Pixel 7 viewport with touch. `budget_mb=N` fails the run when the combined peak goes over it. The budget is a provisional engineering budget for comparing designs and catching regressions, not a phone safety threshold: it counts only sampled JavaScript heap, not browser, graphics, or native memory, and sampling can miss short peaks.

CPU throttling slows only the page's main thread. Chromium rejects it on worker targets, and a measured worker loop ran at the same speed at rates 1 and 4, so throttled timings understate slow-device time for work done in workers.

### Large-export baselines

Measured on 2026-10-16 at commit `aeaaa15`, before any large-file pipeline work, on a 4-core Intel Xeon at 2.10 GHz with 15 GB RAM, Chromium 141.0.7390.37 headless, and Node 24.15.0. Each row is 3 runs of `make bench-browser size_mb=N runs=3` with the listed options, on the synthetic export from `make gen-large-export`. Values are medians with the range in parentheses. Messages time is from file drop and includes opening Analytics first. Peak heap is the combined sampled JavaScript heap of the page and its workers. No run crashed or failed to finish.

| Size  | Options | Analytics ready    | Messages ready       | Cached filter    | Peak heap        |
| ----- | ------- | ------------------ | -------------------- | ---------------- | ---------------- |
| 10 MB | `cpu=1` | 1.59 s (1.31-1.79) | 2.00 s (1.72-2.21)   | 176 ms (170-179) | 73 MB (69-90)    |
| 10 MB | `cpu=4` | 2.22 s (1.96-2.23) | 2.87 s (2.47-2.91)   | 168 ms (167-281) | 78 MB (70-88)    |
| 10 MB | `cpu=6` | 3.07 s (3.00-3.18) | 4.05 s (3.80-4.26)   | 262 ms (231-410) | 83 MB (79-96)    |
| 10 MB | `gpu=0` | 1.69 s (1.13-1.70) | 2.09 s (1.58-2.11)   | 178 ms (140-193) | 81 MB (70-100)   |
| 30 MB | `cpu=1` | 2.43 s (2.40-2.69) | 2.84 s (2.81-3.16)   | 186 ms (173-208) | 204 MB (196-204) |
| 30 MB | `cpu=4` | 3.48 s (3.28-3.51) | 4.19 s (3.92-4.27)   | 209 ms (190-274) | 247 MB (227-257) |
| 30 MB | `cpu=6` | 4.89 s (4.79-5.29) | 5.83 s (5.64-6.22)   | 306 ms (287-323) | 247 MB (203-251) |
| 30 MB | `gpu=0` | 2.57 s (2.46-2.64) | 2.98 s (2.91-3.24)   | 224 ms (162-292) | 204 MB (186-213) |
| 55 MB | `cpu=1` | 3.48 s (3.30-3.74) | 3.85 s (3.72-4.21)   | 181 ms (157-207) | 359 MB (355-359) |
| 55 MB | `cpu=4` | 5.77 s (5.57-5.78) | 6.43 s (6.30-6.55)   | 224 ms (193-241) | 475 MB (464-618) |
| 55 MB | `cpu=6` | 9.38 s (7.44-9.39) | 10.38 s (8.26-10.42) | 267 ms (254-282) | 436 MB (418-440) |
| 55 MB | `gpu=0` | 3.49 s (3.44-3.59) | 3.90 s (3.84-3.94)   | 152 ms (94-204)  | 359 MB (349-397) |

What the baselines show:

- Peak heap grows about 6.4 MB per MB of export between 10 and 55 MB, and a 55 MB export already peaks near 360 MB, over the provisional 300 MB budget. Reducing whole-file copies and retained analysis state matters more than speed.
- Throttled runs report higher peaks. The likely cause is that slower runs let the 200 ms sampler catch more short-lived allocations; this was not measured separately.
- CPU throttling reaches only the main thread, so the throttled timings are a lower bound for a slow device.
- Disabling the GPU changes nothing measurable, because no screen uses WebGL today.

At 100 MB, measured with the `measurement` build's higher limits before step 4b of the large-file pipeline, on the same machine. `cpu=1` is 3 runs; `cpu=4` and `cpu=6` are one run each:

| Size   | Options | Analytics ready     | Messages ready      | Cached filter    | Peak heap         |
| ------ | ------- | ------------------- | ------------------- | ---------------- | ----------------- |
| 100 MB | `cpu=1` | 7.62 s (7.20-10.67) | 8.05 s (7.65-11.14) | 174 ms (163-184) | 934 MB (919-1101) |
| 100 MB | `cpu=4` | 10.68 s             | 11.35 s             | 206 ms           | 945 MB            |
| 100 MB | `cpu=6` | 13.43 s             | 14.31 s             | 280 ms           | 833 MB            |

- At 100 MB the workers hold about 800 MB of the peak and the page about 150 MB, roughly three times the 300 MB budget. Heap grows faster than linearly between 55 and 100 MB.
- The Python CLI peaks at 1.44 GB RSS on a 107 MiB `messages.csv` from a 128 MiB synthetic export (`make audit-memory-python`), 399 MB on its 10.7 MiB `Connections.csv`, and under 200 MB on the shares and comments files.

After step 4b (the analytics worker reads the uploaded `File` itself), 3 runs at `cpu=1` on the same machine and export:

| Size   | Options | Analytics ready    | Messages ready     | Cached filter    | Peak heap          |
| ------ | ------- | ------------------ | ------------------ | ---------------- | ------------------ |
| 100 MB | `cpu=1` | 7.09 s (7.09-7.24) | 7.54 s (7.53-7.72) | 179 ms (144-188) | 1000 MB (997-1001) |

- The workers now hold about 670 MB and the page about 330 MB. The page still receives the decoded text back from the worker for storage, so the total peak did not fall; step 4e removes that copy.

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
