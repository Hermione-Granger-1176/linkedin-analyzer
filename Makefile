.PHONY: lint format typecheck test web-lint web-format-check web-typecheck web-test web-build web ci

lint:
	.venv/bin/ruff check src/ tests/

format:
	.venv/bin/ruff format src/ tests/

typecheck:
	.venv/bin/mypy src/

test:
	.venv/bin/pytest tests/ -v

web-lint:
	npm run lint

web-format-check:
	npm run format:check

web-typecheck:
	npm run typecheck:web

web-test:
	npm run test

web:
	npm run dev

web-build:
	npm run build

ci: lint typecheck test web-format-check web-lint web-typecheck web-test
