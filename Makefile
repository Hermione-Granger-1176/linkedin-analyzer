.DEFAULT_GOAL := help

# ─── Variables ────────────────────────────────────────────────────────────────

# Default interpreter for `make install`. uv resolves and downloads this version
# if it is not already available. Override for older supported versions, e.g.
# `make install PYTHON=3.12` (see docs/development.md).
PYTHON              ?= 3.14
UV                  ?= uv
UVX                 ?= uvx
VENV                ?= .venv
VENV_PYTHON         := $(VENV)/bin/python
NPM                 ?= npm
NPX                 ?= npx
NODE                ?= node
PY_PATHS            := src/ tests/ scripts/ci/ scripts/gh/ scripts/setup/
PY_TYPE_PATHS       := src/ scripts/ci/ scripts/gh/ scripts/setup/
PLAYWRIGHT_BROWSERS := chromium firefox webkit

# Browser targets opt into the private Linux runtime only with local_libs=1.
# Browsers install into Playwright's shared cache so every project reuses one
# copy; only the extracted shared libraries and per-run scratch live below the
# ignored .playwright cache. The wrapper refuses to download packages mid-run.
PLAYWRIGHT_LOCAL_RUNTIME := $(VENV_PYTHON) scripts/setup/playwright_local_runtime.py
PLAYWRIGHT_LOCAL_RUN = $(if $(filter 1,$(local_libs)),$(PLAYWRIGHT_LOCAL_RUNTIME) run --,)

# Entry point for the GitHub PR/CI helper (scripts/gh). The Makefile targets
# below are thin wrappers; the testable logic (repo and PR auto-detection,
# GraphQL, CI triage) lives in Python.
GH = PYTHONPATH=. $(VENV_PYTHON) -m scripts.gh.cli

# ─── Setup @setup ────────────────────────────────────────────────────────────────────

.PHONY: install node-install install-hooks setup-base setup setup-all setup-ci setup-playwright setup-playwright-ci setup-playwright-local playwright-local-status playwright-local-gate playwright-local-clean

install: ## Install locked Python deps into the uv-managed virtual environment
	UV_PROJECT_ENVIRONMENT=$(VENV) $(UV) sync --all-groups --frozen --python $(PYTHON)

node-install: ## Install locked Node deps
	$(NPM) ci

install-hooks: ## Install local pre-commit Git hooks
	$(UVX) pre-commit install

setup-base: install node-install ## Install Python and Node deps

setup: setup-base ## Install Python and Node deps (fast, no browsers)

setup-all: setup-base setup-playwright ## Full local setup with Playwright browsers, no system deps or sudo

setup-ci: setup-base setup-playwright-ci ## CI-only setup with Playwright browsers and system deps

setup-playwright: ## Install Playwright browsers locally, no system deps or sudo
	$(NPX) playwright install $(PLAYWRIGHT_BROWSERS)

setup-playwright-ci: ## Install Playwright browsers with system deps for CI
	$(NPX) playwright install --with-deps $(PLAYWRIGHT_BROWSERS)

setup-playwright-local: ## Install shared browsers and the private Ubuntu/Debian runtime without sudo
	$(PLAYWRIGHT_LOCAL_RUNTIME) prepare
	PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1 $(NPX) playwright install $(PLAYWRIGHT_BROWSERS)
	$(PLAYWRIGHT_LOCAL_RUNTIME) prepare

playwright-local-status: ## Show repository-local Playwright runtime status
	$(PLAYWRIGHT_LOCAL_RUNTIME) status

playwright-local-gate: ## Launch Chromium, Firefox, and WebKit in the private runtime
	$(PLAYWRIGHT_LOCAL_RUNTIME) probe

playwright-local-clean: ## Remove only the repository-local Playwright cache (keeps shared browsers)
	$(PLAYWRIGHT_LOCAL_RUNTIME) clean

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

.PHONY: test test-py test-js test-js-quick test-e2e test-e2e-headed test-e2e-ui test-browser-xlsx

test: test-py test-js ## Run non-browser Python and JS tests

test-py: ## Run Python tests only (make test-py ARGS="-k name --no-cov" for a subset)
	$(VENV_PYTHON) -m pytest $(ARGS)

test-js: ## Run JS unit tests only
	$(NPM) run test

test-js-quick: ## Run a subset of JS tests without coverage (make test-js-quick ARGS="analytics")
	$(NPX) vitest run --config web/vitest.config.js $(ARGS)

test-e2e: ## Run Playwright browser tests (make test-e2e ARGS="--project=chromium web/e2e/app.e2e.spec.js")
	$(PLAYWRIGHT_LOCAL_RUN) $(NPM) run test:e2e -- $(ARGS)

test-e2e-headed: ## Run Playwright browser tests in headed mode
	$(PLAYWRIGHT_LOCAL_RUN) $(NPM) run test:e2e:headed

test-e2e-ui: ## Run Playwright UI mode
	$(PLAYWRIGHT_LOCAL_RUN) $(NPM) run test:e2e:ui

test-browser-xlsx: ## Download the real browser xlsx (chromium) and validate it with openpyxl (make test-browser-xlsx local_libs=1)
	@set -eu; \
	out_dir=$$(mktemp -d "$${TMPDIR:-/tmp}/linkedin-analyzer-browser-xlsx.XXXXXX"); \
	chmod 700 "$$out_dir"; \
	trap 'rm -rf -- "$$out_dir"' EXIT; \
	BROWSER_XLSX_OUT="$$out_dir/Comments.xlsx" $(PLAYWRIGHT_LOCAL_RUN) $(NPM) run test:e2e -- --project=chromium web/e2e/browser-xlsx.e2e.spec.js; \
	$(VENV_PYTHON) scripts/checks/validate_browser_xlsx.py --workbook "$$out_dir/Comments.xlsx" --expected web/e2e/fixtures/BrowserXlsx.expected.json

# ─── Web @web ──────────────────────────────────────────────────────────────────────

.PHONY: web web-preview web-lint web-format-check web-typecheck web-test web-build web-size-check web-build-size web-smoke web-screens web-e2e

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

web-smoke: ## Smoke-check a deployed web app (make web-smoke url=https://example.com)
	@test -n "$(url)" || (printf 'Usage: make web-smoke url=https://example.com\n' >&2; exit 1)
	$(NODE) scripts/web-smoke.mjs "$(url)"

web-screens: ## Capture all screens at mobile/tablet/desktop viewports (dir=.artifacts/screens)
	SCREENS_DIR="$(or $(dir),.artifacts/screens)" $(PLAYWRIGHT_LOCAL_RUN) $(NPM) run test:e2e -- --project=chromium web/e2e/screenshots.e2e.spec.js

web-e2e: test-e2e ## Alias for test-e2e

# ─── Checks @checks ──────────────────────────────────────────────────────────────────
# Local-only tools that run against your private export in data/input (never
# committed). They skip cleanly when it is absent unless strict=1 is set. Any
# cross-runtime row dumps use a private temporary directory and are always removed.
# See docs/development.md (Local checks and benchmarks).

.PHONY: cleaner-diff xrt-diff bench bench-decode audit-memory-python audit-memory-browser explore

cleaner-diff: ## Compare web cleaner behavior across refs (make cleaner-diff [args="oldRef newRef"] [strict=1] [input_dir=path])
	$(NODE) scripts/checks/cleaner-diff.mjs $(if $(strict),--strict) $(if $(input_dir),--input-dir "$(input_dir)") $(args)

xrt-diff: ## Stage one web ref and compare its rows with CLI xlsx output (make xrt-diff [ref=worktree] [strict=1] [input_dir=path] [xlsx_dir=path])
	@set -eu; \
	temp_dir=$$(mktemp -d "$${TMPDIR:-/tmp}/linkedin-analyzer-xrt.XXXXXX"); \
	chmod 700 "$$temp_dir"; \
	trap 'rm -rf -- "$$temp_dir"' EXIT; \
	$(NODE) scripts/checks/cleaner-diff.mjs --output-dir "$$temp_dir" $(if $(strict),--strict) $(if $(input_dir),--input-dir "$(input_dir)") "$(or $(ref),worktree)"; \
	$(VENV_PYTHON) scripts/checks/xrt-diff.py --json-dir "$$temp_dir" $(if $(strict),--strict) $(if $(xlsx_dir),--xlsx-dir "$(xlsx_dir)")

bench: ## Benchmark read, clean, and analytics on your export (make bench [runs=N])
	$(NODE) scripts/checks/pipeline-bench.mjs $(runs)

bench-decode: ## Benchmark and verify the upload decode layer (make bench-decode [runs=N])
	$(NODE) scripts/checks/perf-bench.mjs $(runs)

audit-memory-python: ## Measure per-cleaner peak RSS on your export (make audit-memory-python [strict=1] [input_dir=path])
	$(VENV_PYTHON) scripts/checks/audit_memory_python.py $(if $(strict),--strict) $(if $(input_dir),--input-dir "$(input_dir)")

audit-memory-browser: ## Measure browser JS heap on your export in Chromium (make audit-memory-browser local_libs=1 [strict=1] [input_dir=path])
	NPM="$(NPM)" $(PLAYWRIGHT_LOCAL_RUN) $(NODE) scripts/checks/heap-audit.mjs $(if $(strict),--strict) $(if $(input_dir),--input-dir "$(input_dir)")

explore: ## Print ad-hoc statistics over your export
	$(VENV_PYTHON) scripts/checks/li_explore.py

# ─── Quality gates @quality ────────────────────────────────────────────────────────────

.PHONY: ci-python ci-web ci ci-fast check-local check fix security audit-node audit-python

ci-python: lint-py format-py-check typecheck-py dead-code-py test-py ## Python CI gate

ci-web: format-js-check lint-js typecheck-web dead-code-js test-js web-build-size ## Web CI gate

ci: ci-python lint-workflows ci-web ## Full local CI gate

ci-fast: ## Run the non-browser CI checks in parallel (excludes web-build-size)
	$(VENV_PYTHON) scripts/ci/run_parallel_checks.py lint-py format-py-check typecheck-py dead-code-py test-py lint-workflows lint-js format-js-check typecheck-web dead-code-js test-js

check-local: ci ## Alias for the full local CI gate

check: check-local test-e2e ## Full gate including browser tests

fix: fmt ci ## Auto-fix formatting, then run the full local CI gate

security: audit-python audit-node check-overrides ## Run dependency and override audits

audit-node: ## Run npm audit
	$(NPM) audit --audit-level=high

audit-python: ## Run pip-audit against the frozen uv lock export
	$(UV) export --all-groups --frozen --no-emit-project --format requirements.txt --output-file /tmp/linkedin-analyzer-requirements.txt
	$(UV) run --with pip-audit pip-audit --strict -r /tmp/linkedin-analyzer-requirements.txt

# ─── Dependency maintenance @deps ──────────────────────────────────────────────────

.PHONY: lock lock-node lock-node-update fix-deps

lock: ## Refresh uv.lock after Python dependency changes
	$(UV) lock

lock-node: ## Refresh package-lock.json after Node dependency changes
	$(NPM) install --package-lock-only

lock-node-update: ## Update selected transitive Node packages in the lockfile (packages="name ...")
	@test -n "$(packages)" || (printf 'Usage: make lock-node-update packages="package ..."\n' >&2; exit 1)
	$(NPM) update --package-lock-only $(packages)

fix-deps: ## Refresh locks and reinstall local environments
	$(MAKE) lock
	$(MAKE) lock-node
	$(MAKE) install
	$(MAKE) node-install

# ─── Utilities @util ────────────────────────────────────────────────────────────────

.PHONY: run-cli gen-parity-corpus status clean help help-json

run-cli: ## Run the linkedin-analyzer CLI (args="shares|comments|messages|connections|all ...")
	$(VENV)/bin/linkedin-analyzer $(args)

gen-parity-corpus: ## Regenerate the synthetic cross-runtime parity corpus fixtures
	$(NODE) scripts/gen-parity-corpus.mjs

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

clean: ## Remove local environments, build outputs, and caches (keeps shared Playwright browsers)
	rm -rf $(VENV) node_modules web/dist .artifacts .playwright .pytest_cache .ruff_cache .mypy_cache .coverage htmlcov coverage playwright-report test-results build dist *.egg-info

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

.PHONY: git branch branch-current rebase log diff diff-staged stage-all commit push release-create

git: ## Git commands (make git)
	@$(MAKE) --no-print-directory help-git

branch: ## Create and switch to a new branch off main, or off base for a stacked branch (make branch name=X [base=branch])
	@test -n "$(name)" || (printf 'Usage: make branch name=my-feature [base=other-branch]\n' >&2; exit 1)
	git checkout "$(if $(base),$(base),main)" && \
	if git rev-parse --symbolic-full-name --abbrev-ref '@{u}' >/dev/null 2>&1; then git pull; fi && \
	git checkout -b "$(name)"

branch-current: ## Create a branch from the current checkout without updating its base
	@test -n "$(name)" || (printf 'Usage: make branch-current name=my-feature\n' >&2; exit 1)
	git checkout -b "$(name)"

rebase: ## Rebase the current branch onto its remote base (make rebase base=origin/main)
	@test -n "$(base)" || (printf 'Usage: make rebase base=origin/main\n' >&2; exit 1)
	git rebase "$(base)"

log: ## Show recent commit log
	git log --oneline -20

diff: ## Show unstaged changes
	git diff

diff-staged: ## Show staged changes
	git diff --cached

stage-all: ## Stage all working tree changes
	git add -A

commit: export COMMIT_TITLE := $(title)
commit: export COMMIT_BODY := $(body)
commit: ## Commit staged changes (make commit title="Subject" [body="- Detail"])
	@test -n "$$COMMIT_TITLE" || (printf 'Usage: make commit title="Subject" [body="- Detail"]\n' >&2; exit 1)
	@if [ -n "$$COMMIT_BODY" ]; then git commit -m "$$COMMIT_TITLE" -m "$$COMMIT_BODY"; else git commit -m "$$COMMIT_TITLE"; fi

push: ## Push the current branch and set its upstream
	@branch=$$(git branch --show-current); test -n "$$branch" || { printf 'No current branch.\n' >&2; exit 1; }; git push -u origin -- "$$branch"

release-create: export RELEASE_NOTES := $(notes)
release-create: ## Tag and publish a GitHub release (make release-create tag=vX.Y.Z [notes="..."] [prerelease=1])
	@test -n "$(tag)" || (printf 'Usage: make release-create tag=vX.Y.Z [notes="..."] [prerelease=1]\n' >&2; exit 1)
	@set -e; \
	tmp=""; \
	trap 'test -n "$$tmp" && rm -f "$$tmp"' EXIT; \
	set -- "$(tag)" --title "$(tag)"; \
	if [ -n "$$RELEASE_NOTES" ]; then tmp=$$(mktemp); printf '%s' "$$RELEASE_NOTES" > "$$tmp"; set -- "$$@" --notes-file "$$tmp"; else set -- "$$@" --generate-notes; fi; \
	if [ -n "$(prerelease)" ]; then set -- "$$@" --prerelease; fi; \
	gh release create "$$@"

# ─── Pull requests @pr ────────────────────────────────────────────────────────────

.PHONY: pr pr-create pr-edit pr-list pr-status pr-checks pr-diff pr-comments pr-comment pr-review-comments pr-reply pr-resolve pr-address pr-comments-list pr-comment-delete pr-summary pr-merge pr-merge-admin pr-reviewers pr-copilot pr-label pr-close

pr: ## PR commands (make pr)
	@$(MAKE) --no-print-directory help-pr

pr-create: ## Open a pull request for the current branch (make pr-create [base=branch] for a stacked PR)
	gh pr create --fill $(if $(base),--base "$(base)")

pr-edit: export PR_EDIT_TITLE := $(title)
pr-edit: export PR_EDIT_BODY := $(body)
pr-edit: ## Edit the current PR title/body (make pr-edit title="..." [body="..."] [pr_num=N])
	@test -n "$$PR_EDIT_TITLE$$PR_EDIT_BODY" || { printf 'Usage: make pr-edit title="New title" [body="..."]\n' >&2; exit 1; }
	@set -e; \
	tmp=""; \
	trap 'test -n "$$tmp" && rm -f "$$tmp"' EXIT; \
	set -- $(if $(pr_num),$(pr_num)); \
	if [ -n "$$PR_EDIT_TITLE" ]; then set -- "$$@" --title "$$PR_EDIT_TITLE"; fi; \
	if [ -n "$$PR_EDIT_BODY" ]; then tmp=$$(mktemp); printf '%s' "$$PR_EDIT_BODY" > "$$tmp"; set -- "$$@" --body-file "$$tmp"; fi; \
	gh pr edit "$$@"

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

pr-merge: ## Merge the current PR (squash, delete branch) (make pr-merge [pr_num=N])
	gh pr merge $(if $(pr_num),$(pr_num)) --squash --delete-branch

pr-merge-admin: ## Force merge bypassing branch protection (admin) (make pr-merge-admin [pr_num=N])
	gh pr merge $(if $(pr_num),$(pr_num)) --squash --delete-branch --admin

pr-reviewers: ## Add reviewers (make pr-reviewers users="user1,user2")
	@test -n "$(users)" || (printf 'Usage: make pr-reviewers users="octocat"\n' >&2; exit 1)
	gh pr edit --add-reviewer $(users)

pr-copilot: ## Request (or re-request) a Copilot review on the PR (make pr-copilot [pr_num=N])
	@$(GH) copilot-review $(if $(pr_num),--pr $(pr_num))

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
