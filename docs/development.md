# Development

Use the repository's `Makefile` for setup, local commands, checks, and GitHub helpers. Do not call the wrapped tools directly when a Make target exists. Run `make help` for the complete command list.

## Install the prerequisites

Install these tools before you set up the checkout:

- Python 3.12, 3.13, or 3.14.
- Node.js 22.22.2 or newer in the 22 line, or 24.15.0 or newer in the 24 line.
- `uv` 0.11.0 or newer.
- `make` and Git.
- Docker when you want to run the hosted Playwright container or build the CLI image.

The default local Python version is 3.14. The lockfile resolves across Python 3.12 through 3.14, and CI tests all three versions.

## Set up a checkout

Run the fast setup:

```bash
make setup
```

The target installs locked Python dependencies into `.venv` and locked Node dependencies into `node_modules`. It does not install browsers.

Install the local Git hooks when you plan to commit:

```bash
make install-hooks
```

The hooks call Make targets for Python linting, formatting, type checking, Python tests, JavaScript linting, JavaScript formatting, web type checking, and JavaScript tests.

Use the full setup when the host already has the system libraries that Playwright needs:

```bash
make setup-all
```

Use the repository-local runtime when a Debian or Ubuntu host lacks those libraries and you do not have sudo access:

```bash
make setup-playwright-local
make playwright-local-status
make playwright-local-gate
```

The local runtime extracts package files under the ignored `.playwright/` directory. It does not install system packages, change the system package database, or touch the shared Playwright browser cache. Pass `local_libs=1` to browser-running targets after the runtime is ready.

Use `make setup-ci` only on a disposable runner where Playwright can install operating-system dependencies. Hosted GitHub Actions uses `make test-e2e-container` instead.

### Select browser engines

Install only the engines needed for a local run with a hyphen-separated selection:

```bash
make setup-playwright-engines engines=chromium
make setup-playwright-engines engines=chromium-webkit
```

The accepted engine names are `chromium`, `firefox`, and `webkit`. Use `with_deps=1` only on an ephemeral runner where the target is allowed to install operating-system dependencies. Browser-running targets accept `local_libs=1`, including `make test-e2e`, `make test-e2e-headed`, `make test-e2e-ui`, and `make web-screens`.

The repository-local runtime keeps extracted libraries, browser data, configuration, and temporary files under the ignored `.playwright/` directory. It reuses browsers from Playwright's shared cache and never downloads packages during a test run. Use native Playwright host detection. Do not set `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE`.

Use `make playwright-local-clean` or `make clean` to remove this repository's private runtime. Neither target removes the shared browser cache.

## Choose a Python version

`make install` creates or syncs `.venv` with Python 3.14 unless you override `PYTHON`:

```bash
make clean-venv
make install PYTHON=3.12
make test-py
```

The other targets use the interpreter already in `.venv`. Remove the environment before switching versions because `uv` keeps an existing compatible environment. Run `make clean-venv && make install` to return to the default.

## Configure local diagnostics

Copy the example environment file only when you need to test diagnostics:

```bash
cp .env.example .env
```

Set `VITE_SENTRY_DSN` for the browser build. The app still waits for explicit user consent before it initializes Sentry. `VITE_APP_RELEASE` adds a release value to reduced diagnostics. `CSP_REPORT_URI`, `SENTRY_DSN`, and `CSP_REPORT_MAX_PER_MINUTE` are server-side settings for the Vercel function. Do not place those server-side values in `.env` when the file will be exposed to a browser build.

## Run the web app

Start the Vite development server:

```bash
make web
```

Build and preview the production bundle:

```bash
make web-build
make web-preview
```

Enforce the bundle size budgets after a build:

```bash
make web-build-size
```

Capture Chromium screenshots at the configured mobile, tablet, and desktop viewports:

```bash
make web-screens
```

Use `dir=.artifacts/screens` or another `dir` value to change the screenshot directory.

## Run the CLI locally

Use `make run-cli` instead of calling the virtual-environment executable directly:

```bash
make run-cli args="--help"
make run-cli args="all"
```

Put a local export in `data/input/` before you run a command that uses the default paths. See the [CLI reference](cli.md) for command options and the [data formats reference](data-formats.md) for file rules.

## Manage dependencies

Change Python dependencies in `pyproject.toml`, then refresh the Python lockfile:

```bash
make lock
```

Change Node dependencies in `package.json`, then refresh the Node lockfile:

```bash
make lock-node
```

Update selected transitive Node packages without changing `package.json`:

```bash
make lock-node-update packages="package-a package-b"
```

Refresh both lockfiles and reinstall both environments:

```bash
make fix-deps
```

Run the dependency and override policy checks:

```bash
make security
```

Use `make audit-node audit_level=high` for a focused local review. The CI policy runs `make audit-node` without an `audit_level` override. Review `config/security_audit.json` before adding or changing an exception.

Use `make audit-fix-node` only when an audit identifies an automatically fixable Node advisory, then review the lockfile and rerun `make security`. Exceptions are ecosystem-specific, time-bounded, and fail closed when they expire, become unused, become ambiguous, or have a fix available when `ignore_only_without_fix` is enabled. The Python audit also keeps strict skipped-dependency behavior.

The `tool.uv.required-version` setting in `pyproject.toml` is a minimum version, not an exact pin. Raise that floor only when a repository feature needs a newer `uv`. The Python lockfile remains the source of dependency resolution, while the monthly action refresh intentionally leaves the `uv` floor unchanged.

## Run common checks

Run one layer when you are iterating:

```bash
make lint-py
make lint-js
make lint-css
make typecheck-py
make typecheck-web
make test-py
make test-js
```

Run the full non-browser gate:

```bash
make ci
```

Run the same quick and heavy order used by the primary CI workflow:

```bash
make ci-platform-checks
```

Use `make ci-fast` when you want the non-browser checks in parallel without the web build size check. Use `make check` when you also want browser tests.

## Keep Make references valid

Documentation, workflow shell commands, and backticked source comments must use real Make targets. `make lint-doc-commands` checks contributor-facing files, while `make lint-make-targets` checks target names throughout the repository and rejects new raw shell control flow in recipes. Put a Make target name in backticks when it appears inside a source comment, docstring, or string so the checker can distinguish it from ordinary prose.

Markdown checks inspect inline code and fenced command blocks. Workflow checks inspect `run:` values. Source checks inspect backticked spans. Tests are excluded because their fixtures intentionally mention targets that do not exist.

## Format without losing review control

Auto-fix commands change files. Run them only when you want those changes:

```bash
make fmt
make align-tables
```

Preview Python changes without writing them:

```bash
make format-py-diff
make format-py-diff paths="src tests"
```

Preview Prettier changes for one file:

```bash
make format-js-diff path=docs/development.md
```

Check the result without changing files:

```bash
make format-check
make align-tables-check
```

## Work with branches and commits

Create a branch from `main`:

```bash
make branch name=describe-the-change
```

Create a branch from the current checkout without updating its base:

```bash
make branch-current name=follow-up-change
```

Check workspace health and inspect diffs:

```bash
make status
make diff
make diff-staged
```

Stage paths through the tested helper:

```bash
make stage files="docs/index.md docs/development.md"
make stage file="path with spaces.md"
```

Commit messages come from standard input. Put the title and body in the repository's commit format:

```bash
make commit <<'EOF'
Document local development workflow

- Add setup and testing commands
- Link the new troubleshooting guide
EOF
```

Committing, pushing, and opening or merging a pull request are maintainer decisions. The available targets are documented by `make help-git` and `make help-pr`.

## Use GitHub helpers

Use the Make wrappers for pull requests, issues, and Actions. Run `make help-pr`, `make help-issue`, or `make help-ci` for every target and argument.

Free-text bodies come from standard input. Titles come from the `TITLE` environment variable. Do not pass a body as a Make argument.

```bash
make pr-comment < notes.md
TITLE='Fix the export error' make issue-create < issue.md
make ci-failures
make ci-watch
```

A review thread can be listed, answered, and resolved with:

```bash
make pr-review-comments
make pr-address thread=PRRT_... < response.md
```

The Make wrappers keep paths and prose out of shell source text. That is why the input convention is part of the repository interface.

## Understand CI path gating

GitHub Actions classifies changed paths into Python, Web, Both, or Neither. Quick gates always run. Heavy checks, compatibility matrices, and browser checks run when their area changed. An unrecognized path fails open to Both, so a new top-level area receives the full matrix until the rules document it.

### Which jobs a change pays for

The classifier in `scripts/ci/job_gating.py` contributes every matching rule instead of stopping at the first match. This makes `.github/SECURITY.md` Both because it matches both the `.github/` and `*.md` rules.

| Paths                                                                                                                                                                                         | Area    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `src/`, `tests/package/`, `tests/integration/`, `tests/support/`, `tests/__init__.py`, `pyproject.toml`, `uv.lock`                                                                            | Python  |
| `web/`, `api/`, `config/`, `package.json`, `package-lock.json`, `vercel.json`                                                                                                                 | Web     |
| `Makefile`, `.github/`, `scripts/`, `tests/tooling/`, `tests/fixtures/`, `constraints/`, `Dockerfile`, `.dockerignore`, `.editorconfig`, `.npmrc`, `.pre-commit-config.yaml`, `.yamllint.yml` | Both    |
| `.agents/skills/`, `docs/`, any `*.md`, `data/`, `LICENSE`, `.gitignore`, `.env.example`                                                                                                      | Neither |
| anything else                                                                                                                                                                                 | Both    |

`tests/fixtures/` is Both because the browser parity suite reads the shared corpus directly. Renames are compared with `--no-renames`, so both the deleted and added paths contribute to the area decision. The required `CI result` job checks that every job expected for the detected areas ran and succeeded.

Read [operations](operations.md#understand-ci) for workflow order, scheduled automation, alert issues, and CI recovery.

## Keep documentation current

Update documentation when a command, flag, route, output file, limit, workflow, or privacy rule changes. Use the real path and symbol name in the text. Run `make lint-doc-commands` and `make lint-make-targets` after documentation changes.
