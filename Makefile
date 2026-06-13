.DEFAULT_GOAL := help

# ─── Variables ────────────────────────────────────────────────────────────────

# Default interpreter for `make install`. uv resolves and downloads this version
# if it is not already available. Override for older supported versions, e.g.
# `make install PYTHON=3.12` (see docs/development.md).
PYTHON              ?= 3.14
UV                  ?= uv
VENV                ?= .venv
VENV_PYTHON         := $(VENV)/bin/python
NPM                 ?= npm
NPX                 ?= npx
PY_PATHS            := src/ tests/ scripts/ci/ scripts/gh/
PY_TYPE_PATHS       := src/ scripts/ci/ scripts/gh/
PLAYWRIGHT_BROWSERS := chromium firefox webkit

# Entry point for the GitHub PR/CI helper (scripts/gh). The Makefile targets
# below are thin wrappers; the testable logic (repo and PR auto-detection,
# GraphQL, CI triage) lives in Python.
GH = PYTHONPATH=. $(VENV_PYTHON) -m scripts.gh.cli

# ─── Setup @setup ────────────────────────────────────────────────────────────────────

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

# ─── Lint @lint ─────────────────────────────────────────────────────────────────────

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

# ─── Format @format ───────────────────────────────────────────────────────────────────

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

# ─── Typecheck @typecheck ────────────────────────────────────────────────────────────────

.PHONY: typecheck typecheck-py typecheck-web

typecheck: typecheck-py typecheck-web ## Run all type checks

typecheck-py: ## Run mypy only
	$(VENV_PYTHON) -m mypy $(PY_TYPE_PATHS)

typecheck-web: ## Run web type checks only
	$(NPM) run typecheck:web

# ─── Dead code @deadcode ──────────────────────────────────────────────────────────

.PHONY: dead-code dead-code-py dead-code-js

dead-code: dead-code-py dead-code-js ## Detect unused code (vulture + knip)

dead-code-py: ## Detect unused Python code (vulture)
	$(VENV_PYTHON) -m vulture

dead-code-js: ## Detect unused JS code, exports, and deps (knip)
	$(NPM) run dead-code

# ─── Test @test ─────────────────────────────────────────────────────────────────────

.PHONY: test test-py test-js test-e2e test-e2e-headed test-e2e-ui

test: test-py test-js ## Run non-browser Python and JS tests

test-py: ## Run Python tests only (make test-py ARGS="-k name --no-cov" for a subset)
	$(VENV_PYTHON) -m pytest $(ARGS)

test-js: ## Run JS unit tests only
	$(NPM) run test

test-e2e: ## Run Playwright browser tests
	$(NPM) run test:e2e

test-e2e-headed: ## Run Playwright browser tests in headed mode
	$(NPM) run test:e2e:headed

test-e2e-ui: ## Run Playwright UI mode
	$(NPM) run test:e2e:ui

# ─── Web @web ──────────────────────────────────────────────────────────────────────

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

# ─── Quality gates @quality ────────────────────────────────────────────────────────────

.PHONY: ci-python ci-web ci ci-fast check-local check fix security audit-node audit-python

ci-python: lint-py format-py-check typecheck-py dead-code-py test-py ## Python CI gate

ci-web: format-js-check lint-js typecheck-web dead-code-js test-js web-build-size ## Web CI gate

ci: ci-python lint-workflows ci-web ## Full local CI gate

ci-fast: ## Run the non-browser CI checks in parallel
	$(VENV_PYTHON) scripts/ci/run_parallel_checks.py lint-py format-py-check typecheck-py dead-code-py test-py lint-js format-js-check typecheck-web dead-code-js

check-local: ci ## Alias for the full local CI gate

check: check-local test-e2e ## Full gate including browser tests

fix: fmt ci ## Auto-fix formatting, then run the full local CI gate

security: audit-python audit-node check-overrides ## Run dependency and override audits

audit-node: ## Run npm audit
	$(NPM) audit --audit-level=high

audit-python: ## Run pip-audit against the frozen uv lock export
	$(UV) export --all-extras --frozen --no-emit-project --format requirements.txt --output-file /tmp/linkedin-analyzer-requirements.txt
	$(UV) run --with pip-audit pip-audit --strict -r /tmp/linkedin-analyzer-requirements.txt

# ─── Dependency maintenance @deps ──────────────────────────────────────────────────

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

# ─── Utilities @util ────────────────────────────────────────────────────────────────

.PHONY: run-cli status clean help help-json

run-cli: ## Run the linkedin-analyzer CLI (args="shares|comments|messages|connections|all ...")
	$(VENV)/bin/linkedin-analyzer $(args)

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
	@echo
	@echo "=== Pull request ==="
	@$(GH) summary || true

clean: ## Remove local environments, build outputs, and caches
	rm -rf $(VENV) node_modules web/dist .artifacts .pytest_cache .ruff_cache .mypy_cache .coverage htmlcov coverage playwright-report test-results build dist *.egg-info

help: ## Show command groups (expand one with make help-<group>)
	@printf '\n  \033[1mmake <target>\033[0m   ·   expand a group: \033[1mmake help-<group>\033[0m   ·   machine-readable: \033[1mmake help-json\033[0m\n'
	@printf '\n  \033[1mGroups\033[0m\n'
	@awk ' \
		/^# ─── .*@/ { \
			line = $$0; sub(/^# ─── /, "", line); \
			ti = index(line, " @"); \
			if (ti == 0) next; \
			title = substr(line, 1, ti - 1); \
			rest = substr(line, ti + 2); sp = index(rest, " "); \
			slug = (sp ? substr(rest, 1, sp - 1) : rest); \
			printf "    %-12s %s\n", slug, title; \
		}' $(MAKEFILE_LIST)
	@printf '\n'

help-%: ## List the commands in one group (e.g. make help-pr)
	@awk -v want="$*" ' \
		/^# ─── / { \
			line = $$0; sub(/^# ─── /, "", line); ti = index(line, " @"); \
			if (ti > 0) { rest = substr(line, ti + 2); sp = index(rest, " "); \
				slug = (sp ? substr(rest, 1, sp - 1) : rest); title = substr(line, 1, ti - 1); } \
			else { slug = ""; title = line; sub(/ *─+$$/, "", title); } \
			inwant = (slug != "" && slug == want); \
			if (inwant) printf "\n  \033[1m%s\033[0m\n", title; \
			next; \
		} \
		inwant && /^[a-zA-Z0-9_-]+:.*## / { \
			target = $$1; sub(/:.*/, "", target); \
			desc = $$0; sub(/.*## /, "", desc); \
			printf "    %-22s %s\n", target, desc; \
		}' $(MAKEFILE_LIST)
	@printf '\n'

help-json: ## Emit groups and commands as JSON
	@awk ' \
		BEGIN { printf "{\"groups\":["; ng = 0; nc = 0; cmds = ""; slug = "" } \
		/^# ─── / { \
			line = $$0; sub(/^# ─── /, "", line); ti = index(line, " @"); \
			if (ti == 0) { slug = ""; next; } \
			rest = substr(line, ti + 2); sp = index(rest, " "); \
			slug = (sp ? substr(rest, 1, sp - 1) : rest); title = substr(line, 1, ti - 1); \
			gsub(/"/, "\\\"", title); \
			printf "%s{\"slug\":\"%s\",\"title\":\"%s\"}", (ng++ ? "," : ""), slug, title; \
			next; \
		} \
		/^[a-zA-Z0-9_-]+:.*## / { \
			if (slug == "") next; \
			target = $$1; sub(/:.*/, "", target); \
			desc = $$0; sub(/.*## /, "", desc); gsub(/"/, "\\\"", desc); \
			cmds = cmds (nc++ ? "," : "") "{\"name\":\"" target "\",\"group\":\"" slug "\",\"desc\":\"" desc "\"}"; \
		} \
		END { printf "],\"commands\":[%s]}\n", cmds }' $(MAKEFILE_LIST)

# ─── Git @git ──────────────────────────────────────────────────────────────────────

.PHONY: git branch log diff diff-staged

git: ## Git commands (make git)
	@$(MAKE) --no-print-directory help-git

branch: ## Create and switch to a new branch from main (make branch name=X)
	@test -n "$(name)" || (printf 'Usage: make branch name=my-feature\n' >&2; exit 1)
	git checkout main && git pull && git checkout -b "$(name)"

log: ## Show recent commit log
	git log --oneline -20

diff: ## Show unstaged changes
	git diff

diff-staged: ## Show staged changes
	git diff --cached

# ─── Pull requests @pr ────────────────────────────────────────────────────────────

.PHONY: pr pr-create pr-edit pr-list pr-status pr-checks pr-diff pr-comments pr-comment pr-review-comments pr-reply pr-resolve pr-address pr-comments-list pr-comment-delete pr-summary pr-merge pr-merge-admin pr-reviewers pr-label pr-close

pr: ## PR commands (make pr)
	@$(MAKE) --no-print-directory help-pr

pr-create: ## Open a pull request for the current branch
	gh pr create --fill

pr-edit: ## Edit the current PR title/body (make pr-edit title="..." [body="..."] [pr_num=N])
	@test -n "$(title)$(body)" || (printf 'Usage: make pr-edit title="New title" [body="..."]\n' >&2; exit 1)
	gh pr edit $(if $(pr_num),$(pr_num)) $(if $(title),--title "$(title)") $(if $(body),--body "$$(printf '%b' "$(body)")")

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

pr-review-comments: ## List review threads with ids (make pr-review-comments [pr_num=N] [show=all])
	@$(GH) list $(if $(pr_num),--pr $(pr_num)) $(if $(filter all,$(show)),--all)

pr-reply: ## Reply to a review thread (make pr-reply thread=PRRT_... body="msg")
	@test -n "$(thread)" -a -n "$(body)" || (printf 'Usage: make pr-reply thread=PRRT_... body="Fixed"\n' >&2; exit 1)
	@$(GH) reply --thread "$(thread)" --body "$(body)"

pr-resolve: ## Resolve a review thread (make pr-resolve thread=PRRT_...)
	@test -n "$(thread)" || (printf 'Usage: make pr-resolve thread=PRRT_...\n' >&2; exit 1)
	@$(GH) resolve --thread "$(thread)"

pr-address: ## Reply to and resolve a review thread (make pr-address thread=PRRT_... body="msg")
	@test -n "$(thread)" -a -n "$(body)" || (printf 'Usage: make pr-address thread=PRRT_... body="Fixed in abc123"\n' >&2; exit 1)
	@$(GH) address --thread "$(thread)" --body "$(body)"

pr-comments-list: ## List individual review comments with node ids (make pr-comments-list [pr_num=N])
	@$(GH) list-comments $(if $(pr_num),--pr $(pr_num))

pr-comment-delete: ## Delete a review comment by node id (make pr-comment-delete comment=PRRC_...)
	@test -n "$(comment)" || (printf 'Usage: make pr-comment-delete comment=PRRC_...\n' >&2; exit 1)
	@$(GH) delete-comment --comment "$(comment)"

pr-summary: ## One-screen PR overview: state, CI rollup, open threads (make pr-summary [pr_num=N])
	@$(GH) summary $(if $(pr_num),--pr $(pr_num))

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

# ─── CI @ci ───────────────────────────────────────────────────────────────────────

.PHONY: ci-runs ci-watch ci-failures issues

ci-runs: ## List recent CI workflow runs
	gh run list -L 10

ci-watch: ## Watch the latest CI run until done
	gh run watch

ci-failures: ## Show failed-step logs for this branch's latest run (make ci-failures [run=ID])
	@$(GH) ci-failures $(if $(run),--run $(run))

issues: ## List open issues
	gh issue list
