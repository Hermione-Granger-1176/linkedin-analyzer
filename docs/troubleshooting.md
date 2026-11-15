# Troubleshooting

Start with `make status`. It reports Git state, dependency availability, lockfile drift, web build state, and pull request state. It runs without the virtual environment.

## Setup fails because `.venv` is missing

The environment was never created, the default Python is not installed, or `uv` is missing or below 0.11.0.

1. Run `make setup`.
2. If `uv` is missing or below 0.11.0, install or update it, then run `make setup` again. The floor is set in `pyproject.toml`.
3. To use an older supported Python, such as 3.12, remove the environment and reinstall with that interpreter:

```bash
make clean-venv
make install PYTHON=3.12
```

## Node dependencies are missing

The Node packages are not installed from the locked `package-lock.json`.

1. Run `make node-install`.
2. If the lockfile changed, review the `package.json` change, run `make lock-node`, then run `make node-install` again.

Do not delete `package-lock.json` to fix an install.

## Playwright cannot launch a browser

The Playwright browsers are not installed, or the host lacks the libraries they need.

1. Install the browsers:

```bash
make setup-playwright
```

2. If the host lacks browser libraries and you cannot use sudo, prepare the private runtime and run the browser tests through it:

```bash
make setup-playwright-local
make playwright-local-gate
make test-e2e local_libs=1
```

3. On a disposable CI runner that allows system package installs, run `make setup-ci`. With Docker available, run `make test-e2e-container` to use the pinned CI runtime.

Do not set `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE`. The local wrapper detects the platform.

## The web app does not start

The production build fails, or a stale service worker breaks a build that succeeds.

1. Run `make web-build` and fix the first error it reports.
2. If the build succeeds, run `make web-preview`.
3. If the preview still fails, unregister the service worker and clear the site data with the browser's site storage controls. Then reload the preview.

## Uploads fail with a worker error

A content blocker's filter rule blocks a local script that the upload worker needs. The activity engine lives at `web/src/features/analytics/activity.js` to avoid EasyPrivacy's `/analytics/analytics.js` rule.

1. Find the blocked script URL in the browser's Network panel, and the matching rule in the content blocker's filtering log.
2. Run the development regression test for this filter collision:

```bash
make test-e2e-dev ARGS="--project=chromium web/e2e/worker-blocking.e2e.spec.js"
```

3. If the deployed build still fails, capture its blocked URL separately.

The development test simulates one URL rule, not every AdGuard, AdBlock, or browser privacy setting. Do not disable your blocker globally to make processing work.

## A CSV is rejected

The file is over a browser or CLI limit, or its header names do not match the required columns.

1. Confirm the browser accepts the file. The browser rejects files above 128 MiB, decoded text above 128 Mi characters, rows above 1,000,000, columns above 256, and fields above 200,000 characters.
2. Compare the header row with the required columns in [data formats](data-formats.md).
3. The CLI rejects files above 128 MiB or rows above 1,000,000 by default. To change those limits, pass `--max-input-bytes`, `--max-rows`, or their environment variables.

## Characters are missing or garbled

Without an explicit encoding, the tool tries UTF-8 and then WHATWG Windows-1252, so the file may be read in an encoding other than its own.

1. Pass the encoding the file uses. An explicit encoding turns off the Windows-1252 fallback:

```bash
linkedin-analyzer --encoding utf-8 shares
linkedin-analyzer --encoding iso-8859-1 shares
```

## The app says the last processing run did not finish

A run ended without recording success or an error. The browser usually stopped the tab after running out of memory, or the browser crashed or was force-quit.

1. Upload fewer files at once.
2. Close other tabs.
3. Process the export with the Python CLI on a computer. See [configurable resource limits](cli.md#set-global-options).
4. If the notice keeps appearing for the same export on a computer, run `make bench-browser input_dir=path` and share the result.

## A cleaner reports missing columns

A required column is absent or misnamed, and the cleaner does not rename columns.

1. Compare the header row with the required columns in [data formats](data-formats.md).
2. Correct the header name in the file, then run the cleaner again.
3. For `Connections.csv`, keep the original three-row preamble. The cleaner skips those rows before it reads the header.

The cleaner trims header whitespace and removes a leading byte-order mark.

## `all` fails on a partial export

A file that `all` expects is missing.

1. Run the command with `--skip-missing`:

```bash
linkedin-analyzer all --skip-missing
```

The option skips only files that do not exist. It does not hide malformed CSV, missing required columns, or output errors.

## Stored browser data is missing

The app clears stored data after 24 hours without activity. A private or restricted browser context can block IndexedDB, which leaves the app in memory only.

1. Upload the files again.
2. Finish the work before you reload. Memory-only storage cannot restore files after a reload.
3. To remove stored files yourself, click **Clear data**.

## A PDF does not contain names or messages

Both PDF options are off by default.

1. To include contact names in the message dashboards, select **Name people in the dashboards**.
2. To include message contents for the last five messages from the ten most recently messaged contacts, select **Include message contents**.
3. If the export fails before the dialog finishes loading, try again. A failed load of the export code is not cached.

Browsers without Web Workers select message threads on the main thread only when the stored message text is under 5 MiB. Larger message sections are omitted.

## Diagnostics are not arriving

Diagnostics send only when the build has a DSN, the user has consented, and the deployment serves the relay.

1. Confirm the build has `VITE_SENTRY_DSN`.
2. Select the diagnostics consent control in the app.
3. Confirm the deployment serves `/api/sentry-tunnel`, and that the relay can read `VITE_SENTRY_DSN` or `SENTRY_DSN` at runtime. The Vite dev server has no `/api` functions, so a local dev build never delivers diagnostics.
4. Set a valid `VITE_APP_RELEASE` when release grouping matters.
5. To forward CSP reports, set `CSP_REPORT_URI` or `SENTRY_DSN` on the server. The browser always posts to `/api/csp-report`, and the function returns `204` when no forwarding destination exists.

The app drops file contents, names, URLs, breadcrumbs, and arbitrary error values. A missing event can also mean no error, a filtered browser-noise event, or a reduced event that the collector rejected.

## A deployed smoke check fails

The deployment fails the app shell, a security header, or the `/api/csp-report` check.

1. Run the check from your machine:

```bash
make web-smoke url=https://your-production-domain.example
```

2. If only a header fails, inspect `vercel.json`.
3. If the app shell fails, compare the deployment's `web/dist/` output with a local `make web-build` result.
4. Roll back when the release cannot serve the app shell or user data could be affected. See [roll back a release](operations.md#roll-back-a-release).

## CI is red

A job in the current branch's latest run failed, or a required job skipped unexpectedly.

1. Read the failed-step logs:

```bash
make ci-failures
```

2. Check per-job status with `make ci-jobs`. Add `run=ID` from `make ci-runs` to inspect another run.
3. Stop a run that is still in progress with `make ci-cancel run=ID` before you retry it.
4. Re-run only the failed jobs of the latest run with `make ci-rerun failed=1`.
5. If a required job skipped unexpectedly, run `make ci-changed-areas base=SHA head=SHA` to check which areas the change touched.

For the workflows, see [CI and repository automation](ci.md). For the `make ci-*` wrappers, see [GitHub helpers](github-helpers.md).

## A documentation check fails

The page names a Make target that does not exist, runs a tool directly instead of through Make, or has misaligned table pipes.

1. Run each check to see which rule failed:

```bash
make lint-doc-commands
make lint-make-targets
make align-tables-check
```

2. Name only real Make targets in code spans and command blocks. `make help-json` lists them. Align table columns with `make align-tables`, or by hand.
3. To see the formatter's changes without editing the file, pass its path on stdin:

```bash
make format-js-diff <<'EOF'
docs/troubleshooting.md
EOF
```

4. Apply the diff by hand.
