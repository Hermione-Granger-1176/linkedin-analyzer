# Contributing

Thanks for contributing to LinkedIn Analyzer. This repo contains a Python CLI and a browser-based web app.

## Development setup

1. Install Python 3.11+, uv, and Node.js 20.19+, 22.13+, or 24+
2. Install locked Python and Node dependencies:

```bash
make setup
```

3. Configure optional local diagnostics:

```bash
cp .env.example .env  # optional; configure VITE_SENTRY_DSN if needed for opt-in diagnostics
```

4. Install git hooks:

```bash
pre-commit install
```

See [`docs/style-guide.md`](../docs/style-guide.md) for code conventions.

## Running locally

- CLI: `linkedin-analyzer --help`
- Web app: `make web`

## Checks

- All linters: `make lint`
- Python lint: `make lint-py`
- Python typecheck: `make typecheck-py`
- Python tests: `make test-py`
- Web lint: `make lint-js`
- Web typecheck: `make typecheck-web`
- Web format check: `make format-js-check`
- Web tests: `make test-js`
- Web E2E tests: `make test-e2e`
- Web build: `make web-build`
- Full local gate: `make ci`

## Pull requests

- Keep changes focused and describe why the change is needed.
- Add tests for new behavior.
- Ensure all checks pass before requesting review.

## Maintainer-first workflow

- Treat existing project conventions as the default unless a maintainer-approved change says otherwise.
- Keep docs, comments, and naming aligned with the current repository voice.
- Prefer incremental refactors over broad stylistic rewrites so history stays easy to review.
