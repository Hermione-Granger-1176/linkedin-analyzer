# Development Setup

## Prerequisites

- Python 3.11+
- Node.js 18+

## Web App

```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# Run tests
npm run test:web

# Lint
npm run lint:web
```

## Python CLI

```bash
# Create virtual environment
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate

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

GitHub Actions runs on every push:

- **Web**: ESLint + Node tests
- **Python**: Ruff + mypy + pytest

See `.github/workflows/ci.yml`.

## Code Style

### Python

- Type hints everywhere (strict mypy)
- Ruff for linting and formatting
- pytest for tests

### JavaScript

- ESLint for linting
- Node's built-in test runner
- No build step (vanilla JS)

## Testing

### Python tests

```bash
pytest                          # All tests
pytest tests/test_text.py -v    # Specific file
pytest -k "test_clean"          # By name pattern
```

### Web tests

```bash
npm run test:web
```

Tests are in `web/tests/`.
