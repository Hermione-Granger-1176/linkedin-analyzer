# Development

Use the repository's `Makefile` for setup, local commands, checks, and GitHub helpers. Do not call the wrapped tools directly when a Make target exists. Run `make help` for the complete command list.

## Install the prerequisites

Install these tools before you set up the checkout:

- Python 3.12, 3.13, or 3.14.
- Node.js 22.22.2 or newer in the 22 line, or 24.15.0 or newer in the 24 line.
- `uv` 0.11.0 or newer.
- `make` and Git.
- Docker when you want to run the hosted Playwright container or build the CLI image.

The default local Python version is 3.14. The lockfile resolves across Python 3.12 through 3.14.

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

The hooks run the lint, format, type, and test targets for Python and JavaScript.

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

The local runtime extracts package files under the ignored `.playwright/` directory. It does not install system packages or change the system package database. It reads browsers from Playwright's shared cache and never downloads packages during a test run. Pass `local_libs=1` to browser-running targets after the runtime is ready.

Use `make playwright-local-clean` or `make clean` to remove this repository's private runtime. Neither target removes the shared browser cache.

Use `make setup-ci` only on a disposable runner where Playwright can install operating-system dependencies. Hosted CI runs browser tests in a container instead.

### Select browser engines

Install only the engines needed for a local run with a hyphen-separated selection:

```bash
make setup-playwright-engines engines=chromium
make setup-playwright-engines engines=chromium-webkit
```

The accepted engine names are `chromium`, `firefox`, and `webkit`. Use `with_deps=1` only on an ephemeral runner where the target is allowed to install operating-system dependencies.

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

Use `make audit-node audit_level=high` for a focused local review. Use `make audit-fix-node` only when an audit identifies an automatically fixable Node advisory. Then review the lockfile and rerun `make security`. The Python audit keeps strict skipped-dependency behavior.

Audit exceptions live in `config/security_audit.json`. See [supply chain](ci.md#protect-the-supply-chain) for the entry format and expiry rules.

The `tool.uv.required-version` setting in `pyproject.toml` is a minimum version, not an exact pin. Raise it only when a repository feature needs a newer `uv`.

## Run common checks

```bash
make lint-py
make lint-js
make lint-css
make typecheck-py
make typecheck-web
make test-py
make test-js
make ci-fast
make ci
make check
```

See [testing](testing.md) for what each target covers.

## Keep Make references valid

Docs, workflow shell commands, and backticked source comments must name real Make targets. Put a target name in backticks when it appears in a source comment, docstring, or string. The checker then tells it apart from ordinary prose.

Markdown checks inspect inline code and fenced command blocks. Workflow checks inspect `run:` values. Source checks inspect backticked spans. Test files are excluded because their fixtures name missing targets on purpose. The checks are listed in [testing](testing.md#run-documentation-and-repository-checks).

## Format without losing review control

Auto-fix commands change files. Run them only when you want those changes:

```bash
make fmt
make align-tables
```

Targets that take files read them from stdin, one path per line, so a path with spaces or quotes is just a line. Without paths on stdin, a check covers its default scope, usually the whole repository.

Preview Python changes without writing them:

```bash
make format-py-diff
```

```bash
make format-py-diff <<'EOF'
src
tests
EOF
```

Preview Prettier changes for specific files:

```bash
make format-js-diff <<'EOF'
docs/development.md
EOF
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

Stage paths, one per line on stdin:

```bash
make stage <<'EOF'
docs/index.md
path with spaces.md
EOF
```

Commit messages come from standard input. Put the title and body in the repository's commit format:

```bash
make commit <<'EOF'
Document local development workflow

- Add setup and testing commands
- Link the new troubleshooting guide
EOF
```

Committing, pushing, and opening or merging a pull request are maintainer decisions. Run `make help-git` for the Git targets.

## Work with GitHub and CI

Use [GitHub helpers](github-helpers.md) for the pull request, issue, and Actions targets. CI workflows, scheduled automation, and credentials are in [CI and repository automation](ci.md).

## Keep documentation current

Update the page that owns a fact instead of repeating it elsewhere. Follow the [documentation rules](style-guide.md#update-documentation) when you change a page, then run the [documentation checks](testing.md#run-documentation-and-repository-checks).
