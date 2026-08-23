# Troubleshooting

Start with `make status`. It reports Git state, dependency availability, lockfile drift, web build state, and pull request state without requiring the virtual environment.

## Setup fails because `.venv` is missing

Run:

```bash
make setup
```

If you need a supported older Python version, remove the existing environment and choose the interpreter explicitly:

```bash
make clean-venv
make install PYTHON=3.12
```

If `uv` is missing or below 0.11.0, install or update it, then run `make setup` again. The repository does not pin an exact `uv` version. It requires the floor recorded in `pyproject.toml`.

## Node dependencies are missing

Run:

```bash
make node-install
```

If the lockfile changed, run `make lock-node` only after you have reviewed the `package.json` change, then run `make node-install` again. Do not delete `package-lock.json` to fix an install.

## Playwright cannot launch a browser

Install the browsers:

```bash
make setup-playwright
```

If the host lacks browser libraries and you cannot use sudo, prepare the private runtime and pass `local_libs=1`:

```bash
make setup-playwright-local
make playwright-local-gate
make test-e2e local_libs=1
```

Use `make setup-ci` on a disposable runner that permits system dependency installation. Use `make test-e2e-container` when Docker is available and you want the pinned CI runtime.

Do not set `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE`. The local wrapper detects the native host platform.

## The web app does not start

Run the build and inspect the first error:

```bash
make web-build
```

If the build succeeds, run:

```bash
make web-preview
```

A browser failure after a successful build usually comes from a stale service worker. Use the browser's site storage controls to unregister the worker and clear the site data, then reload the preview.

## A CSV is rejected

Check the file size and the required header names in [data formats](data-formats.md). The browser rejects files above 80 MiB, decoded text above 60 MiB, rows above 500,000, columns above 256, and fields above 200,000 characters.

The CLI rejects files above 100 MiB or rows above 1,000,000 by default. Pass `--max-input-bytes`, `--max-rows`, or their environment variables when you have a reason to change the limits.

For missing or garbled characters, pass an explicit encoding:

```bash
linkedin-analyzer --encoding utf-8 shares
linkedin-analyzer --encoding iso-8859-1 shares
```

The CLI and browser try UTF-8 first and then use WHATWG Windows-1252 when no explicit encoding is set. An explicit encoding disables that fallback.

## A cleaner reports missing columns

Inspect the header row and compare it with the required columns in [data formats](data-formats.md). The cleaner trims header whitespace and removes a leading byte-order mark, but it does not rename arbitrary columns.

For `Connections.csv`, keep the original three-row preamble. The cleaner skips those rows before it reads the header.

## `all` fails on a partial export

Pass `--skip-missing` when a missing file is expected:

```bash
linkedin-analyzer all --skip-missing
```

The option skips only files that do not exist. It does not hide malformed CSV, missing required columns, or output errors.

## Stored browser data is missing

The app clears data after 24 hours without activity. IndexedDB can also be unavailable in a private or restricted browser context. When IndexedDB fails, the app switches to memory and cannot restore files after a reload.

Upload the files again and avoid reloading until the work is complete. Use **Clear data** when you want to remove stored files yourself.

## A PDF does not contain names or messages

The two PDF choices are independent and unchecked by default. Select **Name people in the dashboards** for contact names in the message dashboards. Select **Include message contents** for the last five messages from the ten most recently messaged contacts.

A browser without Web Workers can select message threads on the main thread only when the stored message text is under 5 MiB. Larger message sections are omitted to keep the interface responsive.

If the PDF export fails before the dialog finishes loading, try again. The export chunk is loaded on demand, and a failed chunk load is not cached as a permanent failure.

## Diagnostics are not arriving

Check all of these conditions:

1. The build has `VITE_SENTRY_DSN`.
2. The user selected the diagnostics consent control.
3. The browser has network access to the configured Sentry host.
4. The deployment has a valid `VITE_APP_RELEASE` when release grouping matters.

The app intentionally drops file contents, names, URLs, breadcrumbs, and arbitrary error values. An absent event can mean no error, no consent, a filtered browser-noise event, or a reduced event that the collector rejected.

For CSP forwarding, set `CSP_REPORT_URI` or `SENTRY_DSN` on the server. The browser always posts to `/api/csp-report`; the function returns `204` when no forwarding destination exists.

## A deployed smoke check fails

Run the same check locally:

```bash
make web-smoke url=https://your-production-domain.example
```

The check covers the app shell, expected security headers, and `/api/csp-report`. If only a header fails, inspect `vercel.json`. If the app shell fails, compare the deployment's `web/dist/` output with a local `make web-build` result. Roll back the deployment when the release cannot serve the shell or when user data could be affected.

## CI is red

Inspect the latest run and failed steps through the Make wrappers:

```bash
make ci-runs
make ci-jobs run=123456
make ci-failures run=123456
```

Use `make ci-cancel run=123456` before retrying a run that is still in progress. Re-run only failed jobs with:

```bash
make ci-rerun run=123456 failed=1
```

If a required job skipped unexpectedly, inspect the changed-area decision and the `CI result` output. Run `make ci-changed-areas base=SHA head=SHA` locally when the area classification looks wrong.

## A documentation check fails

Run the checks separately to see which rule failed:

```bash
make lint-doc-commands
make lint-make-targets
make align-tables-check
```

Use real Make target names in code spans and fenced command blocks. Put prose in standard Markdown paragraphs. Run `make format-js-diff path=docs/troubleshooting.md` to inspect the configured formatter result without changing the file.
