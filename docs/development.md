# Development Setup

## Prerequisites

- Python 3.14 (default; the Docker runtime and primary CI gate use 3.14)
- Node.js 22.13.x or 24+
- uv

The project supports Python 3.11–3.14. 3.14 is the default for local development, the container image, and the primary CI quality gate; 3.11–3.13 are verified in the CI compatibility matrix. See [Using an older Python version](#using-an-older-python-version) if you need to develop or test against 3.11, 3.12, or 3.13.

## Initial setup

```bash
# Install locked Python deps into .venv and Node deps into node_modules
make setup

# Optional: make diagnostics available in local/dev builds
cp .env.example .env
# Set VITE_SENTRY_DSN in .env when needed (still requires in-app opt-in)
```

Python dependencies are declared in `pyproject.toml` and resolved in `uv.lock`. The local environment remains `.venv`; uv creates and syncs it from the lockfile.

Refresh `uv.lock` after Python dependency changes:

```bash
make lock
```

### Using an older Python version

The `make install` target builds the `.venv` against the interpreter named by the `PYTHON` variable, which defaults to `3.14` (uv downloads it if it is not already installed). To work against an older supported version, override `PYTHON`. uv will download and manage the interpreter for you, so you do not need it installed system-wide:

```bash
# Build the .venv against a specific Python (uv fetches it if missing)
rm -rf .venv && make install PYTHON=3.12

# Subsequent targets use that .venv directly — no override needed
make test-py
make typecheck-py
```

`PYTHON` only affects `make install`, which is what creates the `.venv` (it defaults to `3.14`); the other targets always run the `.venv` interpreter you built. uv keeps an existing compatible `.venv` rather than rebuilding it, so remove `.venv` first when you want the interpreter to actually change. To switch back to the default:

```bash
rm -rf .venv && make install
```

You can also point `PYTHON` at an explicit interpreter name on your `PATH` (for example `make install PYTHON=python3.11`). The lockfile (`uv.lock`) is universal and resolves across 3.11–3.14, so no lock changes are needed to switch versions. Type checking (`mypy`) and linting (`ruff`) always target the 3.11 floor regardless of the interpreter you run, so newer-only syntax is caught early.

## Web App

```bash
# Start dev server
make web

# Run tests
make test-js

# Install browser for E2E (one-time)
make setup-all

# CI/Linux setup with Playwright system deps
make setup-ci

# Run browser E2E tests
make test-e2e

# Lint
make lint-js

# Type-check JavaScript with checkJs
make typecheck-web

# Detect unused JS code, exports, and deps (knip)
make dead-code-js

# Format check (docs/config files)
make format-js-check
```

## Python CLI

```bash
# Install or refresh the .venv from uv.lock
make install

# Run Python tests (coverage runs by default)
make test-py

# Coverage HTML report
make test-py ARGS="--cov-report=html"

# Python type checking
make typecheck-py

# Python lint
make lint-py

# Detect unused Python code (vulture)
make dead-code-py

# Format Python, JavaScript, and metadata
make fmt
```

## CI

GitHub Actions runs on pull requests and pushes to `main`:

- **Quality gate**: workflow lint + Python lint/format/typecheck/dead-code/tests + web format/lint/typecheck/dead-code/unit tests
- **Compatibility**: Python 3.11/3.12/3.13 and Node.js 22/24 matrix jobs (the quality gate runs the primary 3.14)
- **Web build**: production build + size-budget check
- **Browser checks**: Playwright E2E in an isolated job with failure artifacts

See `.github/workflows/ci.yml`.

A weekly `dependency-audit.yml` workflow also runs every Monday across two jobs:

- `make audit-node` and `make audit-python` for the npm and Python dependency audits
- `make check-overrides` to verify any future npm overrides remain necessary; the original overrides have been removed (see [ADR-001](adr/001-npm-overrides-for-transitive-dependency-gaps.md))

If either audit job fails, a `report-failure` job opens (or comments on the existing) `dependency-audit`-labeled issue with a link to the run, so a scheduled failure is visible without watching the Actions tab.

Maintenance workflows also keep generated repository state current:

- `refresh-python-locks.yml` + `commit-python-locks.yml` refresh `uv.lock` for Dependabot uv PRs through a validated artifact handoff.
- `refresh-action-shas.yml` converts tag-based GitHub Action references to full commit SHAs when app credentials are configured. Already pinned references are left unchanged; Dependabot handles action-version updates.

## Code Style

### Python

- Type hints everywhere (strict mypy)
- Ruff for linting and formatting
- pytest for tests

### JavaScript

- ESLint for linting
- Vitest for tests
- Vite for bundling

### Tool pinning

Most `devDependencies` track caret ranges, but `actionlint` is pinned to an exact version. It gates the workflow files in CI, and new patch releases can add lint rules; an exact pin keeps `make lint-workflows` reproducible so a tool bump that fails CI is always a deliberate, reviewed change rather than a surprise. Bump it like any other dependency when you want the newer rules.

## Testing

### Python tests

```bash
make test-py                                    # Full suite (coverage gate)
make test-py ARGS="tests/test_text.py --no-cov" # Specific file
make test-py ARGS="-k test_clean --no-cov"      # By name pattern
```

### Web tests

```bash
make test-js
make test-e2e
```

Tests are in `web/tests/`.
