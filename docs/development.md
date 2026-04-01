# Development Setup

## Prerequisites

- Python 3.11+
- Node.js 20.19+ (or 22.13+, or 24+)

## Web App

```bash
# Install dependencies
npm install

# Optional: make diagnostics available in local/dev builds
cp .env.example .env
# Set VITE_SENTRY_DSN in .env when needed (still requires in-app opt-in)

# Start dev server
npm run dev

# Run tests
npm run test

# Install browser for E2E (one-time)
npm run test:e2e:install

# Linux only: install Playwright system deps (requires sudo)
npx playwright install-deps chromium firefox

# Run browser E2E tests
npm run test:e2e

# Lint
npm run lint

# Type-check JavaScript with checkJs
npm run typecheck:web

# Format check (docs/config files)
npm run format:check
```

## Python CLI

```bash
# Create virtual environment
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate

# Install with dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# With coverage
pytest --cov=linkedin_analyzer --cov-report=html

# Type checking
mypy src/linkedin_analyzer

# Lint
ruff check src tests

# Format
ruff format src tests
```

## CI

GitHub Actions runs on pull requests and pushes to `main`:

- **Web**: format check + ESLint + JS typecheck + unit tests + build + size-budget check + Playwright E2E
- **Python**: Ruff + mypy + pytest

See `.github/workflows/ci.yml`.

A weekly `dependency-audit.yml` workflow also runs every Monday:

- `npm audit` and `pip-audit` for security vulnerabilities
- `npm run check:overrides` to flag npm overrides that are no longer needed (see [ADR-001](adr/001-npm-overrides-for-transitive-dependency-gaps.md))

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
pytest                          # All tests
pytest tests/test_text.py -v    # Specific file
pytest -k "test_clean"          # By name pattern
```

### Web tests

```bash
npm run test
npm run test:e2e
```

Tests are in `web/tests/`.
