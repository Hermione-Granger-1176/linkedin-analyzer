# Development Setup

## Prerequisites

- Python 3.11+
- Node.js 20.19+ (or 22.13+, or 24+)
- uv

## Initial setup

```bash
# Install locked Python deps into .venv and Node deps into node_modules
make setup

# Optional: make diagnostics available in local/dev builds
cp .env.example .env
# Set VITE_SENTRY_DSN in .env when needed (still requires in-app opt-in)
```

Python dependencies are declared in `pyproject.toml` and resolved in `uv.lock`. The local
environment remains `.venv`; uv creates and syncs it from the lockfile.

Refresh `uv.lock` after Python dependency changes:

```bash
make lock
```

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

# Format check (docs/config files)
make format-js-check
```

## Python CLI

```bash
# Install or refresh the .venv from uv.lock
make install

# Run Python tests
make test-py

# With coverage
uv run pytest --cov=linkedin_analyzer --cov-report=html

# Python type checking
make typecheck-py

# Python lint
make lint-py

# Format Python, JavaScript, and metadata
make fmt
```

## CI

GitHub Actions runs on pull requests and pushes to `main`:

- **Quality gate**: workflow lint + Python lint/format/typecheck/tests + web format/lint/typecheck/unit tests
- **Compatibility**: Python 3.11/3.13 and Node.js 20/24 matrix jobs
- **Web build**: production build + size-budget check
- **Browser checks**: Playwright E2E in an isolated job with failure artifacts

See `.github/workflows/ci.yml`.

A weekly `dependency-audit.yml` workflow also runs every Monday:

- `make security` for npm, Python, and override audits
- `make check-overrides` to flag npm overrides that are no longer needed (see [ADR-001](adr/001-npm-overrides-for-transitive-dependency-gaps.md))

Maintenance workflows also keep generated repository state current:

- `refresh-python-locks.yml` + `commit-python-locks.yml` refresh `uv.lock` for Dependabot uv PRs through a validated artifact handoff.
- `refresh-action-shas.yml` refreshes pinned GitHub Action SHAs when app credentials are configured.

## Code Style

### Python

- Type hints everywhere (strict mypy)
- Ruff for linting and formatting
- pytest for tests

### JavaScript

- ESLint for linting
- Vitest for tests
- Vite for bundling

## Testing

### Python tests

```bash
make test-py                                # Python tests
uv run pytest tests/test_text.py -v        # Specific file
uv run pytest -k "test_clean"              # By name pattern
```

### Web tests

```bash
make test-js
make test-e2e
```

Tests are in `web/tests/`.
