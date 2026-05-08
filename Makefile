.DEFAULT_GOAL := help

# ─── Variables ────────────────────────────────────────────────────────────────

PYTHON              ?= python3
UV                  ?= uv
VENV                ?= .venv
VENV_PYTHON         := $(VENV)/bin/python
NPM                 ?= npm
NPX                 ?= npx
PY_PATHS            := src/ tests/ scripts/ci/
PY_SRC              := src/
PLAYWRIGHT_BROWSERS := chromium firefox webkit

REPO ?= $(strip $(shell repo="$$(git remote get-url origin 2>/dev/null | sed -nE 's|.*github\.com[:/]([^/]+/[^/.]+)(\.git)?$$|\1|p')"; \
	if [ -z "$$repo" ]; then repo="$$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)"; fi; \
	printf '%s' "$$repo"))

# ─── Setup ────────────────────────────────────────────────────────────────────

.PHONY: install node-install setup-base setup setup-all setup-ci

install: ## Install locked Python deps into the uv-managed virtual environment
	UV_PROJECT_ENVIRONMENT=$(VENV) $(UV) sync --all-extras --frozen --python $(PYTHON)

node-install: ## Install locked Node deps
	$(NPM) ci

setup-base: install node-install ## Install Python and Node deps

setup: setup-base ## Install Python and Node deps (fast, no browsers)

setup-all: setup-base ## Full local setup including Playwright browsers
	$(NPX) playwright install $(PLAYWRIGHT_BROWSERS)

setup-ci: setup-base ## CI setup including Playwright browsers and system deps
	$(NPX) playwright install --with-deps $(PLAYWRIGHT_BROWSERS)

# ─── Lint ─────────────────────────────────────────────────────────────────────

.PHONY: lint lint-py lint-js lint-workflows workflow-lint check-overrides

lint: lint-py lint-js lint-workflows ## Run all linters

lint-py: ## Run Python linter only
	$(VENV_PYTHON) -m ruff check $(PY_PATHS)

lint-js: ## Run ESLint only
	$(NPM) run lint

lint-workflows: ## Run GitHub workflow linter only
	$(NPM) run lint:workflows

workflow-lint: lint-workflows ## Alias for lint-workflows

check-overrides: ## Check npm overrides are still needed
	$(NPM) run check:overrides

# ─── Format ───────────────────────────────────────────────────────────────────

.PHONY: fmt fmt-py fmt-js format format-check format-py-check format-js-check

fmt: fmt-py fmt-js ## Auto-fix Python, JavaScript, and metadata formatting

fmt-py: ## Auto-fix Python with ruff
	$(VENV_PYTHON) -m ruff check --fix $(PY_PATHS)
	$(VENV_PYTHON) -m ruff format $(PY_PATHS)

fmt-js: ## Auto-fix JavaScript and formatted metadata
	$(NPM) run format
	$(NPM) run lint -- --fix

format: fmt ## Alias for fmt

format-check: format-py-check format-js-check ## Check Python and metadata formatting

format-py-check: ## Check Python formatting only
	$(VENV_PYTHON) -m ruff format --check $(PY_PATHS)

format-js-check: ## Check Prettier formatting only
	$(NPM) run format:check

# ─── Typecheck ────────────────────────────────────────────────────────────────

.PHONY: typecheck typecheck-py typecheck-web

typecheck: typecheck-py ## Run Python type checks

typecheck-py: ## Run mypy only
	$(VENV_PYTHON) -m mypy $(PY_SRC)

typecheck-web: ## Run web type checks only
	$(NPM) run typecheck:web

# ─── Test ─────────────────────────────────────────────────────────────────────

.PHONY: test test-py test-js test-e2e test-e2e-headed test-e2e-ui

test: test-py test-js ## Run non-browser Python and JS tests

test-py: ## Run Python tests only
	$(VENV_PYTHON) -m pytest tests/ -v

test-js: ## Run JS unit tests only
	$(NPM) run test

test-e2e: ## Run Playwright browser tests
	$(NPM) run test:e2e

test-e2e-headed: ## Run Playwright browser tests in headed mode
	$(NPM) run test:e2e:headed

test-e2e-ui: ## Run Playwright UI mode
	$(NPM) run test:e2e:ui

# ─── Web ──────────────────────────────────────────────────────────────────────

.PHONY: web web-preview web-lint web-format-check web-typecheck web-test web-build web-size-check web-build-size web-e2e

web: ## Start the Vite dev server
	$(NPM) run dev

web-preview: ## Preview the production web build
	$(NPM) run preview

web-lint: lint-js ## Alias for lint-js

web-format-check: format-js-check ## Alias for format-js-check

web-typecheck: typecheck-web ## Alias for typecheck-web

web-test: test-js ## Alias for test-js

web-build: ## Build the production web bundle
	$(NPM) run build

web-size-check: ## Enforce web bundle size budgets
	$(NPM) run size:check

web-build-size: web-build web-size-check ## Build web and enforce size budgets

web-e2e: test-e2e ## Alias for test-e2e

# ─── Quality gates ────────────────────────────────────────────────────────────

.PHONY: ci-python ci-web ci check-local check security audit-node audit-python

ci-python: lint-py format-py-check typecheck-py test-py ## Python CI gate

ci-web: format-js-check lint-js typecheck-web test-js web-build-size ## Web CI gate

ci: ci-python lint-workflows ci-web ## Full local CI gate

check-local: ci ## Alias for the full local CI gate

check: check-local test-e2e ## Full gate including browser tests

security: audit-python audit-node check-overrides ## Run dependency and override audits

audit-node: ## Run npm audit
	$(NPM) audit --audit-level=high

audit-python: ## Run pip-audit against the frozen uv lock export
	$(UV) export --all-extras --frozen --no-emit-project --format requirements.txt --output-file /tmp/linkedin-analyzer-requirements.txt
	$(UV) run --with pip-audit pip-audit --strict -r /tmp/linkedin-analyzer-requirements.txt

# ─── Dependency maintenance ──────────────────────────────────────────────────

.PHONY: lock lock-node fix-deps

lock: ## Refresh uv.lock after Python dependency changes
	$(UV) lock

lock-node: ## Refresh package-lock.json after Node dependency changes
	$(NPM) install --package-lock-only

fix-deps: ## Refresh locks and reinstall local environments
	$(MAKE) lock
	$(MAKE) lock-node
	$(MAKE) install
	$(MAKE) node-install

# ─── Utilities ────────────────────────────────────────────────────────────────

.PHONY: status clean help

status: ## Show workspace health
	@echo "=== Git ==="
	@git status -sb
	@echo
	@echo "=== Python ==="
	@test -x $(VENV_PYTHON) && echo "OK: $(VENV_PYTHON) exists" || echo "MISSING: run make setup"
	@$(UV) lock --check >/dev/null 2>&1 && echo "OK: uv.lock is current" || echo "STALE: run make lock"
	@echo
	@echo "=== Node ==="
	@test -d node_modules && echo "OK: node_modules exists" || echo "MISSING: run make setup"
	@$(NPM) install --package-lock-only --ignore-scripts --dry-run >/dev/null 2>&1 && echo "OK: package-lock.json is current" || echo "STALE: run make lock-node"
	@echo
	@echo "=== Web build ==="
	@test -d web/dist && echo "OK: web/dist exists" || echo "NOT BUILT: run make web-build"

clean: ## Remove local environments, build outputs, and caches
	rm -rf $(VENV) node_modules web/dist .pytest_cache .ruff_cache .mypy_cache .coverage htmlcov coverage playwright-report test-results build dist *.egg-info

help: ## Show this help
	@awk ' \
		/^# ─── .+ ───/ { \
			gsub(/^# ─── | ─+$$/, ""); \
			section = $$0; \
			printed = 0; \
		} \
		/^[a-zA-Z0-9_-]+:.*## / { \
			if (section && !printed) { printf "\n  \033[1m%s\033[0m\n", section; printed = 1 } \
			target = $$1; sub(/:.*/, "", target); \
			desc = $$0; sub(/.*## /, "", desc); \
			printf "    %-22s %s\n", target, desc; \
		}' $(MAKEFILE_LIST)

# ─── Git ──────────────────────────────────────────────────────────────────────

.PHONY: git branch log diff diff-staged

git: ## Git commands (make git)
	@grep -E '^(branch|log|diff|diff-staged):.*##' $(MAKEFILE_LIST) | awk -F ':.*## ' '{ printf "    %-22s %s\n", $$1, $$2 }'

branch: ## Create and switch to a new branch from main (make branch name=X)
	@test -n "$(name)" || (printf 'Usage: make branch name=my-feature\n' >&2; exit 1)
	git checkout main && git pull && git checkout -b "$(name)"

log: ## Show recent commit log
	git log --oneline -20

diff: ## Show unstaged changes
	git diff

diff-staged: ## Show staged changes
	git diff --cached

# ─── Pull requests ────────────────────────────────────────────────────────────

.PHONY: pr pr-create pr-list pr-status pr-checks pr-diff pr-comments pr-comment pr-review-comments pr-reply pr-resolve pr-merge pr-merge-admin pr-reviewers pr-label pr-close

pr: ## PR commands (make pr)
	@grep -E '^pr-[a-zA-Z0-9_-]+:.*##' $(MAKEFILE_LIST) | awk -F ':.*## ' '{ printf "    %-22s %s\n", $$1, $$2 }'

pr-create: ## Open a pull request for the current branch
	gh pr create --fill

pr-list: ## List open pull requests
	gh pr list

pr-status: ## Show current PR status and CI checks
	gh pr checks

pr-checks: ## Watch CI checks until done
	gh pr checks --watch --fail-fast || true

pr-diff: ## Show the diff for the current PR
	gh pr diff

pr-comments: ## Show all comments on the current PR
	gh pr view --comments

pr-comment: ## Add a comment to the current PR (make pr-comment body="msg")
	@test -n "$(body)" || (printf 'Usage: make pr-comment body="Looks good"\n' >&2; exit 1)
	gh pr comment --body "$(body)"

pr-review-comments: ## List review threads with resolution status (make pr-review-comments pr_num=N)
	@test -n "$(pr_num)" || (printf 'Usage: make pr-review-comments pr_num=19\n' >&2; exit 1)
	@printf '%s\n' "$(REPO)" | grep -Eq '^[^/]+/[^/]+$$' || (printf 'Error: REPO must be set to owner/name (e.g. REPO=octocat/Hello-World)\n' >&2; exit 1)
	@owner=$$(echo "$(REPO)" | cut -d/ -f1) && \
	 name=$$(echo "$(REPO)" | cut -d/ -f2) && \
	 gh api graphql -F pr_num:='$(pr_num)' -F owner="$$owner" -F name="$$name" -f query='query($$pr_num: Int!, $$owner: String!, $$name: String!) { repository(owner: $$owner, name: $$name) { pullRequest(number: $$pr_num) { reviewThreads(first: 50) { nodes { id isResolved comments(first: 10) { nodes { body author { login } createdAt } } } } } } }'

pr-reply: ## Reply to a review comment (make pr-reply pr_num=N comment=ID body="msg")
	@test -n "$(pr_num)" -a -n "$(comment)" -a -n "$(body)" || (printf 'Usage: make pr-reply pr_num=19 comment=123456 body="Fixed"\n' >&2; exit 1)
	@gh api repos/$(REPO)/pulls/$(pr_num)/comments/$(comment)/replies -f body="$(body)"

pr-resolve: ## Resolve a review thread (make pr-resolve thread=PRRT_...)
	@test -n "$(thread)" || (printf 'Usage: make pr-resolve thread=PRRT_kwDO...\n' >&2; exit 1)
	@gh api graphql -F thread="$(thread)" -f query='mutation($$thread: ID!) { resolveReviewThread(input: { threadId: $$thread }) { thread { id isResolved } } }'

pr-merge: ## Merge the current PR (squash, delete branch)
	gh pr merge --squash --delete-branch

pr-merge-admin: ## Force merge bypassing branch protection (admin)
	gh pr merge --squash --delete-branch --admin

pr-reviewers: ## Add reviewers (make pr-reviewers users="user1,user2")
	@test -n "$(users)" || (printf 'Usage: make pr-reviewers users="octocat"\n' >&2; exit 1)
	gh pr edit --add-reviewer $(users)

pr-label: ## Add labels (make pr-label labels="bug")
	@test -n "$(labels)" || (printf 'Usage: make pr-label labels="bug"\n' >&2; exit 1)
	gh pr edit --add-label "$(labels)"

pr-close: ## Close the current PR and delete branch
	gh pr close --delete-branch

# ─── CI ───────────────────────────────────────────────────────────────────────

.PHONY: ci-runs ci-watch issues

ci-runs: ## List recent CI workflow runs
	gh run list -L 10

ci-watch: ## Watch the latest CI run until done
	gh run watch

issues: ## List open issues
	gh issue list
