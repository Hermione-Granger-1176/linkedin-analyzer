.PHONY: lint format typecheck test web-lint web-test web ci

lint:
	.venv/bin/ruff check src/ tests/

format:
	.venv/bin/ruff format src/ tests/

typecheck:
	.venv/bin/mypy src/

test:
	.venv/bin/pytest tests/ -v

web-lint:
	npm run lint:web

web-test:
	npm run test:web

web:
	npm run dev

ci: lint typecheck test web-lint web-test
