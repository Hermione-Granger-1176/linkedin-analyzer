# Contributing

Thanks for contributing to LinkedIn Analyzer. This repo contains a Python CLI and a browser-based web app.

## Development setup

1. Install Python 3.11+ and Node.js 20+
2. Create a Python virtual environment and install dependencies:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

3. Install web dependencies:

```bash
npm install
cp .env.example .env  # optional; configure VITE_SENTRY_DSN if needed
```

4. Install git hooks:

```bash
pre-commit install
```

See [`docs/style-guide.md`](docs/style-guide.md) for code conventions.

## Running locally

- CLI: `linkedin-analyzer --help`
- Web app: `npm run dev`

## Checks

- Python lint: `make lint`
- Python typecheck: `make typecheck`
- Python tests: `make test`
- Web lint: `make web-lint`
- Web typecheck: `npm run typecheck:web`
- Web format check: `npm run format:check`
- Web tests: `make web-test`
- Web E2E tests: `npm run test:e2e`
- Web build: `make web-build`

## Pull requests

- Keep changes focused and describe why the change is needed.
- Add tests for new behavior.
- Ensure all checks pass before requesting review.
