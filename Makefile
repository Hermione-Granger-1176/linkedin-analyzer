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
PY_PATHS            := src/ tests/ scripts/ci/ scripts/gh/ scripts/lib/ scripts/lint/ scripts/setup/
PY_TYPE_PATHS       := src/ scripts/ci/ scripts/gh/ scripts/lib/ scripts/lint/ scripts/setup/
PLAYWRIGHT_BROWSERS := chromium firefox webkit

# Interpreter for the few helpers that must run before `make setup` has built
# the virtual environment (currently `make status`). Unlike PYTHON above, which
# is a uv version selector, this is an interpreter on PATH. Those helpers are
# stdlib-only so any supported Python works.
SYSTEM_PYTHON       ?= python3

# Default branch used by the @git group. Override on the command line or in the
# environment for a repository that does not branch from `main`.
MAIN_BRANCH         ?= main

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

# Repository slug (owner/name) for the @ci, @pr, and @issue groups. Resolve from
# the origin remote first, then fall back to gh. Recursively expanded, so the
# shell only runs for a target that actually references it.
REPO ?= $(strip $(shell repo="$$(git remote get-url origin 2>/dev/null | sed -nE 's|.*github\.com[:/]([^/]+/[^/.]+)(\.git)?$$|\1|p')"; \
	if [ -z "$$repo" ]; then repo="$$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)"; fi; \
	printf '%s' "$$repo"))

# Fail with a usage line when a required variable is empty.
# Usage: $(call need,varname,make branch name=my-feature [base=other-branch])
define need
@test -n "$($(1))" || { printf 'Usage: %s\n' '$(2)' >&2; exit 1; }
endef

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

.PHONY: lint lint-py lint-js lint-css lint-yaml lint-workflows workflow-lint lint-doc-commands lint-make-targets editorconfig-check check-overrides

lint: editorconfig-check lint-py lint-js lint-css lint-yaml lint-workflows lint-doc-commands lint-make-targets ## Run all linters

editorconfig-check: ## Check EditorConfig rules
	@PYTHONPATH=. $(VENV_PYTHON) -m scripts.lint.check_editorconfig

lint-py: ## Run Python linter only [paths=...]
	$(VENV_PYTHON) -m ruff check $(if $(paths),$(paths),$(PY_PATHS))

lint-js: ## Run ESLint only
	$(NPM) run lint

lint-css: ## Run stylelint only
	$(NPM) run lint:css

lint-yaml: ## Run yamllint only [paths=...]
	$(VENV)/bin/yamllint $(if $(paths),$(paths),.)

lint-workflows: ## Run GitHub workflow linter only
	$(NPM) run lint:workflows

workflow-lint: lint-workflows ## Alias for lint-workflows

lint-doc-commands: ## Check contributor docs use Make targets
	@PYTHONPATH=. $(VENV_PYTHON) -m scripts.lint.check_doc_commands

lint-make-targets: ## Check documented Make targets
	@PYTHONPATH=. $(VENV_PYTHON) -m scripts.lint.check_make_targets

check-overrides: ## Check npm overrides are still needed
	$(NPM) run check:overrides

# ─── Format @format ───────────────────────────────────────────────────────────────────

.PHONY: fmt fmt-py fmt-js format format-check format-py-check format-js-check

fmt: fmt-py fmt-js ## Auto-fix Python, JavaScript, and metadata formatting

fmt-py: ## Auto-fix Python with ruff
	$(VENV_PYTHON) -m ruff check --fix $(if $(paths),$(paths),$(PY_PATHS))
	$(VENV_PYTHON) -m ruff format $(if $(paths),$(paths),$(PY_PATHS))

fmt-js: ## Auto-fix JavaScript and formatted metadata
	$(NPM) run format
	$(NPM) run lint -- --fix

format: fmt ## Alias for fmt

format-check: format-py-check format-js-check ## Check Python and metadata formatting

format-py-check: ## Check Python formatting only [paths=...]
	$(VENV_PYTHON) -m ruff format --check $(if $(paths),$(paths),$(PY_PATHS))

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

# Optional ARGS tail for the test targets, honored only when passed on the make
# command line so a stray ARGS environment variable cannot silently change what
# the test gate runs.
TEST_ARGS = $(if $(filter command line,$(origin ARGS)),$(ARGS))

test: test-py test-js ## Run non-browser Python and JS tests

test-py: ## Run Python tests only (make test-py ARGS="-k name --no-cov" for a subset)
	$(VENV_PYTHON) -m pytest $(TEST_ARGS)

test-js: ## Run JS unit tests only
	$(NPM) run test

test-js-quick: ## Run a subset of JS tests without coverage (make test-js-quick ARGS="analytics")
	$(NPX) vitest run --config web/vitest.config.js $(TEST_ARGS)

test-e2e: ## Run Playwright browser tests (make test-e2e ARGS="--project=chromium web/e2e/app.e2e.spec.js")
	$(PLAYWRIGHT_LOCAL_RUN) $(NPM) run test:e2e -- $(TEST_ARGS)

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
	$(call need,url,make web-smoke url=https://example.com)
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

ci-web: editorconfig-check format-js-check lint-js lint-css lint-yaml typecheck-web lint-doc-commands lint-make-targets dead-code-js test-js web-build-size ## Web and docs CI gate

ci: ci-python lint-workflows ci-web ## Full local CI gate

ci-fast: ## Run the non-browser CI checks in parallel (excludes web-build-size)
	$(VENV_PYTHON) scripts/ci/run_parallel_checks.py lint-py format-py-check typecheck-py dead-code-py test-py editorconfig-check lint-workflows lint-js lint-css lint-yaml lint-doc-commands lint-make-targets format-js-check typecheck-web dead-code-js test-js

check-local: ci ## Alias for the full local CI gate

check: check-local test-e2e ## Full gate including browser tests

fix: fmt ci ## Auto-fix formatting, then run the full local CI gate

security: audit-python audit-node check-overrides ## Run dependency and override audits

# Both audit wrappers are stdlib-only and run on SYSTEM_PYTHON, so the
# single-surface audit jobs in dependency-audit.yml (Node-only, Python-only)
# keep working without building the project virtual environment first.
audit-node: ## Run policy-driven npm dependency audit with reviewed exceptions
	@PYTHONPATH=. $(SYSTEM_PYTHON) -m scripts.ci.run_npm_audit --npm "$(NPM)"

audit-python: ## Export locked Python deps and run policy-driven pip-audit
	mkdir -p .artifacts
	$(UV) export --all-groups --frozen --no-emit-project --format requirements.txt --output-file .artifacts/requirements-audit.txt
	@PYTHONPATH=. $(SYSTEM_PYTHON) -m scripts.ci.run_security_audit --requirements .artifacts/requirements-audit.txt --pip-audit "$(UV) run --with pip-audit pip-audit"

# ─── Dependency maintenance @deps ──────────────────────────────────────────────────

.PHONY: lock lock-node lock-node-update fix-deps

lock: ## Refresh uv.lock after Python dependency changes
	$(UV) lock

lock-node: ## Refresh package-lock.json after Node dependency changes
	$(NPM) install --package-lock-only

lock-node-update: ## Update selected transitive Node packages in the lockfile (packages="name ...")
	$(call need,packages,make lock-node-update packages="package ...")
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

# Runs on the system interpreter, not $(VENV_PYTHON): the whole point of
# `make status` is to tell you whether the venv is missing. The helper is
# stdlib-only and degrades to a report when a tool cannot launch.
status: ## Show workspace health (git, python, node, web build, PR)
	@PYTHONPATH=. $(SYSTEM_PYTHON) -m scripts.lib.workspace_status --venv-python "$(VENV_PYTHON)" --uv "$(UV)" --npm "$(NPM)"

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

help-%: FORCE ## List the commands in one group (e.g. make help-pr)
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

# .PHONY cannot cover pattern rules, so help-% depends on FORCE to stay
# runnable even if a file named help-<group> ever appears in the workspace.
FORCE:

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

.PHONY: git branch branch-current rebase rebase-continue sync-branch log log-file diff diff-staged stage stage-all commit push push-force release-create

git: ## Git commands (make git)
	@$(MAKE) --no-print-directory help-git

branch: ## Create and switch to a new branch off main, or off base for a stacked branch (make branch name=X [base=branch])
	$(call need,name,make branch name=my-feature [base=other-branch])
	git checkout "$(if $(base),$(base),$(MAIN_BRANCH))" && \
	{ ! git rev-parse --symbolic-full-name --abbrev-ref '@{u}' >/dev/null 2>&1 || git pull; } && \
	git checkout -b "$(name)"

branch-current: ## Create a branch from the current checkout without updating its base (make branch-current name=X)
	$(call need,name,make branch-current name=my-feature)
	git checkout -b "$(name)"

rebase: ## Fetch and rebase the current branch onto origin/main (make rebase [base=branch])
	git fetch origin "$(if $(base),$(base),$(MAIN_BRANCH))" && git rebase "origin/$(if $(base),$(base),$(MAIN_BRANCH))"

rebase-continue: ## Continue an in-progress rebase after resolving conflicts
	GIT_EDITOR=true git rebase --continue

sync-branch: ## Rebase the current branch onto its upstream branch
	git pull --rebase

log: ## Show recent commit log (make log [limit=N])
	git log --oneline -$(if $(limit),$(limit),20)

log-file: ## Show recent commit log for one file (make log-file path=FILE [limit=N])
	$(call need,path,make log-file path=src/linkedin_analyzer/cli.py [limit=N])
	git log --date=short --pretty=format:'%h %ad %s' -$(if $(limit),$(limit),20) -- "$(path)"

diff: ## Show unstaged changes (make diff [path=FILE])
	git diff $(if $(path),-- "$(path)")

diff-staged: ## Show staged changes (make diff-staged [path=FILE])
	git diff --cached $(if $(path),-- "$(path)")

stage: export STAGE_FILES := $(files)
stage: export STAGE_FILE := $(file)
stage: ## Stage selected files (make stage [files="path ..."] [file="one path with spaces"])
	@PYTHONPATH=. $(VENV_PYTHON) -m scripts.lib.stage_files

stage-all: ## Stage all working tree changes
	git add -A

commit: export COMMIT_MESSAGE := $(message)
commit: ## Commit staged changes (make commit message="..." OR message_file=path, - reads stdin [amend=1])
	@test -n "$(message)$(message_file)" || { printf 'Usage: make commit message="Commit message" OR message_file=path (- reads the message from stdin, e.g. a heredoc)\n' >&2; exit 1; }
	@set -e; \
	tmp=$$(mktemp); \
	trap 'rm -f "$$tmp"' EXIT; \
	$(if $(message_file),$(if $(filter -,$(message_file)),cat,cat "$(message_file)"),printf '%s' "$$COMMIT_MESSAGE") > "$$tmp"; \
	$(GH) check-commit-message --message-file "$$tmp"; \
	git commit $(if $(amend),--amend) -F "$$tmp"

push: ## Push the current branch and set its upstream
	@branch=$$(git branch --show-current); test -n "$$branch" || { printf 'No current branch.\n' >&2; exit 1; }; git push -u origin -- "$$branch"

push-force: ## Push the current branch after a rebase (uses --force-with-lease)
	@branch=$$(git branch --show-current); test -n "$$branch" || { printf 'No current branch.\n' >&2; exit 1; }; git push --force-with-lease -u origin -- "$$branch"

release-create: export RELEASE_NOTES := $(notes)
release-create: ## Tag and publish a GitHub release (make release-create tag=vX.Y.Z [notes="..."] [prerelease=1])
	$(call need,tag,make release-create tag=vX.Y.Z [notes="..."] [prerelease=1])
	@set -e; \
	tmp=""; \
	trap 'test -n "$$tmp" && rm -f "$$tmp"' EXIT; \
	set -- "$(tag)" --title "$(tag)"; \
	if [ -n "$$RELEASE_NOTES" ]; then tmp=$$(mktemp); printf '%s' "$$RELEASE_NOTES" > "$$tmp"; set -- "$$@" --notes-file "$$tmp"; else set -- "$$@" --generate-notes; fi; \
	if [ -n "$(prerelease)" ]; then set -- "$$@" --prerelease; fi; \
	gh release create "$$@"

# ─── Pull requests @pr ────────────────────────────────────────────────────────────

# Smart default for the PR number: the caller's pr_num= else the PR for the
# current branch. Stays empty when nothing resolves so gh falls back to its own
# detection (and the guard on targets that require a number can still fire).
PR_NUM = $(if $(pr_num),$(pr_num),$(strip $(shell gh pr view --json number -q .number 2>/dev/null)))

.PHONY: pr pr-create pr-edit pr-list pr-status pr-checks pr-diff pr-checkout pr-comments pr-comment pr-review-comments pr-reply pr-resolve pr-address pr-comments-list pr-comment-delete pr-summary pr-watch pr-merge pr-merge-admin pr-reviewers pr-copilot pr-copilot-review pr-label pr-close

pr: ## PR commands (make pr)
	@$(MAKE) --no-print-directory help-pr

pr-create: ## Open a pull request for the current branch (make pr-create [base=branch] for a stacked PR)
	gh pr create --fill $(if $(base),--base "$(base)")

pr-edit: export PR_EDIT_TITLE := $(title)
pr-edit: export PR_EDIT_BODY := $(body)
pr-edit: ## Edit a PR title or body (make pr-edit title="..." [body="..." OR body_file=path, - reads stdin] [pr_num=N])
	@test -n "$$PR_EDIT_TITLE$$PR_EDIT_BODY$(body_file)" || { printf 'Usage: make pr-edit title="New title" [body="..." OR body_file=- with the body piped on stdin] [pr_num=N]\n' >&2; exit 1; }
	@$(if $(body_file),,$(if $(body),printf '%s' "$$PR_EDIT_BODY" | ))$(GH) edit-pr $(if $(PR_NUM),--pr $(PR_NUM)) \
		$(if $(title),--title "$$PR_EDIT_TITLE") \
		$(if $(body_file),--body-file "$(body_file)",$(if $(body),--body-file -))

pr-list: ## List open pull requests
	gh pr list

pr-status: ## Show a PR's status and CI checks (make pr-status [pr_num=N])
	gh pr checks $(pr_num)

pr-checks: ## Watch CI checks until done (make pr-checks [pr_num=N])
	gh pr checks $(pr_num) --watch --fail-fast || true

pr-diff: ## Show the diff for a PR (make pr-diff [pr_num=N])
	gh pr diff $(pr_num)

pr-checkout: ## Check out a PR's branch locally (make pr-checkout pr_num=N)
	$(call need,pr_num,make pr-checkout pr_num=123)
	gh pr checkout $(pr_num)

pr-comments: ## Show all comments on a PR (make pr-comments [pr_num=N])
	gh pr view $(pr_num) --comments

pr-comment: export PR_COMMENT_BODY := $(body)
pr-comment: ## Add a comment to a PR (body="msg" OR body_file=path, - reads stdin) (make pr-comment [pr_num=N])
	@test -n "$(body)$(body_file)" || { printf 'Usage: make pr-comment body="Looks good"  OR  make pr-comment body_file=- with the comment piped on stdin\n' >&2; exit 1; }
	@gh pr comment $(pr_num) $(if $(body_file),--body-file "$(body_file)",--body "$$PR_COMMENT_BODY")

pr-review-comments: ## List review threads with thread ids (make pr-review-comments [pr_num=N] [show=all])
	@$(GH) list $(if $(pr_num),--pr $(pr_num)) $(if $(filter all,$(show)),--all)

pr-reply: export PR_REPLY_BODY := $(body)
pr-reply: ## Reply to a review thread (make pr-reply thread=PRRT_... body="msg" OR body_file=path, - reads stdin)
	$(call need,thread,make pr-reply thread=PRRT_... body="Fixed" OR body_file=- with the reply piped on stdin)
	@test -n "$$PR_REPLY_BODY$(body_file)" || { printf 'Provide body="..." or body_file=path.\n' >&2; exit 1; }
	@$(GH) reply --thread "$(thread)" $(if $(body_file),--body-file "$(body_file)",--body "$$PR_REPLY_BODY")

pr-resolve: ## Resolve a review thread (make pr-resolve thread=PRRT_...)
	$(call need,thread,make pr-resolve thread=PRRT_...)
	@$(GH) resolve --thread "$(thread)"

pr-address: export PR_ADDRESS_BODY := $(body)
pr-address: ## Reply to and resolve a review thread (make pr-address thread=PRRT_... body="msg" OR body_file=path, - reads stdin)
	$(call need,thread,make pr-address thread=PRRT_... body="Fixed" OR body_file=- with the reply piped on stdin)
	@test -n "$$PR_ADDRESS_BODY$(body_file)" || { printf 'Provide body="..." or body_file=path.\n' >&2; exit 1; }
	@$(GH) address --thread "$(thread)" $(if $(body_file),--body-file "$(body_file)",--body "$$PR_ADDRESS_BODY")

pr-comments-list: ## List individual review comments with node ids (make pr-comments-list [pr_num=N])
	@$(GH) list-comments $(if $(pr_num),--pr $(pr_num))

pr-comment-delete: ## Delete a review comment by node id (make pr-comment-delete comment=PRRC_...)
	$(call need,comment,make pr-comment-delete comment=PRRC_...)
	@$(GH) delete-comment --comment "$(comment)"

pr-summary: ## One-screen PR overview: state, CI rollup, open threads (make pr-summary [pr_num=N])
	@$(GH) summary $(if $(pr_num),--pr $(pr_num))

pr-watch: ## Wait until PR checks settle and a fresh Copilot review lands (make pr-watch [pr_num=N] [since=ISO] [interval=S] [max_polls=K] [checks_only=1])
	@$(GH) watch $(if $(pr_num),--pr $(pr_num)) $(if $(since),--since "$(since)") $(if $(interval),--interval $(interval)) $(if $(max_polls),--max-polls $(max_polls)) $(if $(filter 1,$(checks_only)),--checks-only)

pr-merge: ## Merge a PR (squash, delete branch) (make pr-merge [pr_num=N])
	gh pr merge $(pr_num) --squash --delete-branch

pr-merge-admin: ## Force merge bypassing branch protection (admin) (make pr-merge-admin [pr_num=N])
	gh pr merge $(pr_num) --squash --delete-branch --admin

pr-reviewers: ## Add reviewers (make pr-reviewers users="user1,user2" [pr_num=N])
	$(call need,users,make pr-reviewers users="octocat")
	gh pr edit $(pr_num) --add-reviewer $(users)

pr-copilot: ## Request (or re-request) a Copilot review on a PR (make pr-copilot [pr_num=N])
	@$(GH) copilot-review $(if $(pr_num),--pr $(pr_num))

pr-copilot-review: pr-copilot ## Alias for pr-copilot

pr-label: ## Add labels (make pr-label labels="bug" [pr_num=N])
	$(call need,labels,make pr-label labels="bug")
	gh pr edit $(pr_num) --add-label "$(labels)"

pr-close: ## Close a PR and delete its branch (make pr-close [pr_num=N])
	gh pr close $(pr_num) --delete-branch

# ─── Issues @issue ────────────────────────────────────────────────────────────────

.PHONY: issue issues issue-list issue-view issue-summary issue-create issue-comment issue-edit issue-label issue-unlabel issue-assign issue-unassign issue-close issue-reopen issue-develop

issue: ## Issue commands (make issue)
	@$(MAKE) --no-print-directory help-issue

issue-list: export ISSUE_SEARCH := $(search)
issue-list: ## List issues (make issue-list [state=open|closed|all] [label=bug] [assignee=user OR mine=1] [author=user] [search="..."] [limit=N])
	@test -z "$(and $(assignee),$(filter 1,$(mine)))" || { printf 'Use assignee=user or mine=1, not both.\n' >&2; exit 1; }
	gh issue list $(if $(state),--state "$(state)") $(if $(label),--label "$(label)") $(if $(assignee),--assignee "$(assignee)") $(if $(filter 1,$(mine)),--assignee @me) $(if $(author),--author "$(author)") $(if $(search),--search "$$ISSUE_SEARCH") $(if $(limit),--limit $(limit))

issues: issue-list ## Alias for issue-list

issue-view: ## Show an issue with its comments (make issue-view issue=N)
	$(call need,issue,make issue-view issue=123)
	gh issue view $(issue) --comments

issue-summary: ## One-screen issue overview: state, labels, assignees, recent comments (make issue-summary issue=N)
	$(call need,issue,make issue-summary issue=123)
	@$(GH) issue-summary --issue $(issue)

issue-create: export ISSUE_TITLE := $(title)
issue-create: export ISSUE_BODY := $(body)
issue-create: ## Open an issue (make issue-create title="..." [body="msg" OR body_file=path, - reads stdin] [labels="a,b"] [assignee=@me])
	$(call need,title,make issue-create title="Fix X" [body="..." OR body_file=- reads stdin] [labels=bug])
	@gh issue create --title "$$ISSUE_TITLE" $(if $(body_file),--body-file "$(body_file)",--body "$$ISSUE_BODY") $(if $(labels),--label "$(labels)") $(if $(assignee),--assignee "$(assignee)")

issue-comment: export ISSUE_COMMENT_BODY := $(body)
issue-comment: ## Comment on an issue (make issue-comment issue=N body="msg" OR body_file=path, - reads stdin)
	$(call need,issue,make issue-comment issue=123 body="On it")
	@test -n "$$ISSUE_COMMENT_BODY$(body_file)" || { printf 'Provide body="..." or body_file=path.\n' >&2; exit 1; }
	@gh issue comment $(issue) $(if $(body_file),--body-file "$(body_file)",--body "$$ISSUE_COMMENT_BODY")

issue-edit: export ISSUE_EDIT_TITLE := $(title)
issue-edit: export ISSUE_EDIT_BODY := $(body)
issue-edit: ## Edit an issue title or body (make issue-edit issue=N [title="..."] [body="..." OR body_file=path, - reads stdin])
	$(call need,issue,make issue-edit issue=123 title="New title")
	@test -n "$$ISSUE_EDIT_TITLE$$ISSUE_EDIT_BODY$(body_file)" || { printf 'Provide title="...", body="...", or body_file=path.\n' >&2; exit 1; }
	@$(if $(body_file),,$(if $(body),printf '%s' "$$ISSUE_EDIT_BODY" | ))gh issue edit $(issue) \
		$(if $(title),--title "$$ISSUE_EDIT_TITLE") \
		$(if $(body_file),--body-file "$(body_file)",$(if $(body),--body-file -))

issue-label: ## Add labels to an issue (make issue-label issue=N labels="bug,ci")
	$(call need,issue,make issue-label issue=123 labels="bug")
	$(call need,labels,make issue-label issue=123 labels="bug")
	gh issue edit $(issue) --add-label "$(labels)"

issue-unlabel: ## Remove labels from an issue (make issue-unlabel issue=N labels="bug,ci")
	$(call need,issue,make issue-unlabel issue=123 labels="bug")
	$(call need,labels,make issue-unlabel issue=123 labels="bug")
	gh issue edit $(issue) --remove-label "$(labels)"

issue-assign: ## Assign users to an issue (make issue-assign issue=N users="a,b" OR mine=1)
	$(call need,issue,make issue-assign issue=123 users="octocat" OR mine=1)
	@test -n "$(users)$(if $(filter 1,$(mine)),me)" || { printf 'Provide users="a,b" or mine=1.\n' >&2; exit 1; }
	gh issue edit $(issue) $(if $(filter 1,$(mine)),--add-assignee @me) $(if $(users),--add-assignee "$(users)")

issue-unassign: ## Remove assignees from an issue (make issue-unassign issue=N users="a,b" OR mine=1)
	$(call need,issue,make issue-unassign issue=123 users="octocat" OR mine=1)
	@test -n "$(users)$(if $(filter 1,$(mine)),me)" || { printf 'Provide users="a,b" or mine=1.\n' >&2; exit 1; }
	gh issue edit $(issue) $(if $(filter 1,$(mine)),--remove-assignee @me) $(if $(users),--remove-assignee "$(users)")

issue-close: export ISSUE_CLOSE_COMMENT := $(comment)
issue-close: ## Close an issue (make issue-close issue=N [reason=completed|"not planned"] [comment="msg"])
	$(call need,issue,make issue-close issue=123)
	@gh issue close $(issue) $(if $(reason),--reason "$(reason)") $(if $(comment),--comment "$$ISSUE_CLOSE_COMMENT")

issue-reopen: export ISSUE_REOPEN_COMMENT := $(comment)
issue-reopen: ## Reopen a closed issue (make issue-reopen issue=N [comment="msg"])
	$(call need,issue,make issue-reopen issue=123)
	@gh issue reopen $(issue) $(if $(comment),--comment "$$ISSUE_REOPEN_COMMENT")

issue-develop: ## Create and check out a branch linked to an issue (make issue-develop issue=N [base=branch] [name=branch])
	$(call need,issue,make issue-develop issue=123)
	gh issue develop $(issue) --checkout $(if $(base),--base "$(base)") $(if $(name),--name "$(name)")

# ─── CI @ci ───────────────────────────────────────────────────────────────────────

# Smart default for the CI-run targets: the caller's run= else the latest run on
# the current branch, resolved through the tested gh helper (the same source as
# ci-failures). Stays empty when nothing resolves so the guard can fire.
RUN_ID = $(if $(run),$(run),$(strip $(shell $(GH) latest-run-id 2>/dev/null)))

.PHONY: ci-runs ci-run ci-run-log ci-job-log ci-watch ci-failures refresh-action-shas

ci-runs: ## List recent CI workflow runs (make ci-runs [limit=N])
	gh run list -L "$(if $(limit),$(limit),10)"

ci-run: ## Show one CI workflow run (make ci-run [run=ID], defaults to this branch's latest)
	@run_id="$(RUN_ID)"; \
	test -n "$$run_id" || { printf 'Usage: make ci-run run=123456 (or run on a branch with a resolvable latest run)\n' >&2; exit 1; }; \
	gh run view $(if $(REPO),--repo "$(REPO)") "$$run_id"

ci-run-log: ## Show failed logs for one CI workflow run (make ci-run-log [run=ID], defaults to this branch's latest)
	@run_id="$(RUN_ID)"; \
	test -n "$$run_id" || { printf 'Usage: make ci-run-log run=123456 (or run on a branch with a resolvable latest run)\n' >&2; exit 1; }; \
	gh run view $(if $(REPO),--repo "$(REPO)") "$$run_id" --log-failed

ci-job-log: ## Show logs for one CI job (make ci-job-log run=ID job=ID)
	$(call need,run,make ci-job-log run=123456 job=789)
	$(call need,job,make ci-job-log run=123456 job=789)
	gh run view $(if $(REPO),--repo "$(REPO)") "$(run)" --job "$(job)" --log

ci-watch: ## Watch the latest CI run until done
	gh run watch

ci-failures: ## Show failed-step logs for this branch's latest run (make ci-failures [run=ID])
	@$(GH) ci-failures $(if $(run),--run $(run))

refresh-action-shas: ## Repin tag-based GitHub Actions refs to commit SHAs (needs GH_TOKEN)
	$(VENV_PYTHON) scripts/ci/refresh_action_shas.py
