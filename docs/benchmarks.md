# Benchmarks

These targets measure speed and memory of the browser app and the analysis pipeline. CI runs two of them as gates: `web-benchmark` (`make bench-compare`) and `web-page-speed` (`make bench-browser-container`).

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

## Generate a synthetic export

Without a private export, generate one and point the checks at it with `input_dir=path`:

```bash
make gen-large-export size_mb=100
make gen-large-export size_mb=30 dir=/tmp/export-30mb
```

The generator writes `messages.csv`, `Connections.csv`, `Shares.csv`, and `Comments.csv` under the system temp directory by default. Pass `dir=path` to choose another directory. It refuses to write inside the repository. The same size always produces the same bytes. The data has one self account, a few thousand contacts with stable profile URLs (including different people who share a name), conversation IDs tied to participants, multi-year dates, and message bodies with commas, quotes, line breaks, emoji, and non-Latin scripts.

## Measure browser upload and loading

Run `make bench-browser` to measure uploads and screen loading in Chromium. The benchmark builds and serves the app privately in `measurement` mode. Each run opens a fresh browser and uploads the export. `runs` defaults to 3.

The report includes times from file drop to Analytics and Messages showing data, plus one cached Analytics filter change. It also records the combined peak JavaScript heap of the page and workers, and whether the tab crashed. Each run appears in the output, followed by the median and range.

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
- `export=excel`, `export=pdf`, or `export=pdf-summary` runs one export after the Analytics filter check. The report shows its median time, or that the app refused it.
- `budget_mb=N` fails a run when its combined peak JavaScript heap exceeds the budget.
- `budget_s=N` fails when the median time from file drop to the Analytics screen showing data exceeds `N` seconds. The median keeps one slow run from failing the check alone.
- `local_libs=1` routes the browser through the repository-local runtime. Prepare it with `make setup-playwright-local`.

## Understand measurement limits

Runs use reduced motion so timeline animations cannot end a filter timing early. The memory budget compares designs and detects regressions. It does not establish a safe limit for phones. Sampling excludes browser, graphics, and native memory, and can miss short peaks.

CPU throttling slows only the page's main thread. Chromium rejects it on worker targets, so throttled timings understate slow-device time for work done in workers.

[ADR-015](adr/015-large-export-investigation.md) records the large-export investigation and its measurement limitations.

## Check page speed in CI

The `web-page-speed` CI job runs the browser benchmark in the pinned Playwright container, on a 20 MiB synthetic export, three times:

```bash
make bench-browser-container size_mb=20 runs=3 budget_s=3.5
```

The job fails when the median time from file drop to the Analytics screen showing data exceeds 3.5 seconds. It catches large slowdowns in the real browser flow. `web-benchmark` catches smaller slowdowns in the analysis pipeline.

The container needs a running Docker daemon. Without one, run `make bench-browser` with the same options on the host. Host timings are not comparable with the CI budget.

Raise the budget only when a change makes the dashboard slower on purpose, such as new work the page has to do before it can show data. Record the new CI median in the workflow comment beside `budget_s` in `.github/workflows/ci.yml`.

## Compare performance against main

`make bench-compare` fails when the analysis pipeline in your checkout is slower than a base commit. CI runs it as the `web-benchmark` job on every change to the web area.

```bash
make bench-compare
make bench-compare base=abc1234 runs=21 threshold=10
```

The command extracts the base commit's `web/src` twice: once as the base and once as an identical control. It then generates a synthetic export, 20 MiB by default. All three copies run in one Node process on the same input. Each stage runs once per copy per round, after a forced garbage collection, and the copies take turns going first. The stages match `make bench`: decode, clean, analytics compute, view, and insights, then decode, clean, and the message and connection state builders.

Each copy is judged by its fastest round. The control's distance from the base is that run's measured noise. A stage fails only when your checkout is slower than the base by more than `threshold` percent plus that noise, so two identical copies cannot fail the gate. A flagged stage is timed again with twice the rounds, and the command fails only when the regression repeats. Stages shorter than 5 ms appear in the report but never fail it. Design rationale: [ADR-014](adr/014-noise-controlled-benchmark-gate.md).

Read the report from the job summary in CI, or from the terminal locally:

- `same`: within the measured noise.
- `faster` or `slower`: beyond the noise but within the allowance. Neither fails the run.
- `regression`: slower than the allowance in both passes. The run fails.

The report also says whether your checkout produced the same output as the base for every stage. A difference is expected only when your change alters results. When the control's output differs from the base's, the harness is broken, and the command exits 2.

Options:

- `base=REF` sets the commit to compare against. The default is `origin/main`.
- `merge_base=1` compares against the merge base of `REF` and your checkout, which CI uses for pull requests.
- `size_mb=N`, `runs=N`, and `threshold=N` set the export size (default 20 MiB), the rounds (default 15; a whole number, rounded up to a multiple of three), and the allowed slowdown percentage (default 10). An invalid value exits 2 before anything is timed.

The comparison covers the pipeline in Node only. Browser upload handling, worker startup and messaging, and rendering are outside it. Use `make bench-browser` for those.

Only `web/src` is copied from the base, so all three copies load packages from your checkout's `node_modules`. The gate therefore times changes to `web/src`, not dependency upgrades. When a change removes or restructures a package that the base still imports, the base cannot load. The command then skips the comparison, explains why in the report and a CI warning, and exits 0. If your checkout itself cannot load, the command fails.
