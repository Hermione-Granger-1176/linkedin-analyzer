.DEFAULT_GOAL := help

# ─── Variables ────────────────────────────────────────────────────────────────

# Default interpreter for `make install`. uv resolves and downloads this version
# if it is not already available. Override for older supported versions, e.g.
# `make install PYTHON=3.12` (see docs/development.md).
PYTHON              ?= 3.14
SYSTEM_PYTHON       ?= python3
UV                  ?= uv
UVX                 ?= uvx
VENV                ?= .venv
VENV_PYTHON         := $(VENV)/bin/python
NPM                 ?= npm
NPX                 ?= npx
NODE                ?= node
DOCKER              ?= docker
# Keep top-level modules and every owned Python subpackage in the quality gates.
PY_PATHS            := src/ tests/ scripts/*.py scripts/checks/ scripts/ci/ scripts/gh/ scripts/lib/ scripts/lint/ scripts/setup/
PY_TYPE_PATHS       := src/ scripts/*.py scripts/checks/ scripts/ci/ scripts/gh/ scripts/lib/ scripts/lint/ scripts/setup/
PLAYWRIGHT_BROWSERS := chromium firefox webkit
PLAYWRIGHT_CI_IMAGE := mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27
PLAYWRIGHT_ENGINE_ARGS = $(subst -, ,$(strip $(engines)))
PLAYWRIGHT_INVALID_ENGINES = $(filter-out $(PLAYWRIGHT_BROWSERS),$(PLAYWRIGHT_ENGINE_ARGS))

# Browser targets opt into the private Linux runtime only with local_libs=1.
# Browsers install into Playwright's shared cache so every project reuses one
# copy; only the extracted shared libraries and per-run scratch live below the
# ignored .playwright cache. The wrapper refuses to download packages mid-run.
PLAYWRIGHT_LOCAL_RUNTIME := $(VENV_PYTHON) scripts/setup/playwright_local_runtime.py
PLAYWRIGHT_LOCAL_RUN = $(if $(filter 1,$(local_libs)),$(PLAYWRIGHT_LOCAL_RUNTIME) run --,)

# Put the repository root on the import path for `python -m scripts.*` without
# discarding a PYTHONPATH the developer set for their own tooling.
PY_PATH_PREFIX = PYTHONPATH=.$${PYTHONPATH:+:$${PYTHONPATH}}

# Entry point for the GitHub PR/CI helper (scripts/gh). The Makefile targets
# below are thin wrappers; the testable logic (repo and PR auto-detection,
# GraphQL, CI triage) lives in Python.
GH = $(PY_PATH_PREFIX) $(VENV_PYTHON) -m scripts.gh.cli
# The run the Actions targets act on: run=ID, or else this branch's newest run.
# The lookup only happens when a recipe that uses it runs without run=.
RUN_ID = $(if $(run),$(run),$(strip $(shell $(GH) latest-run-id 2>/dev/null)))
# ─── Free text ────────────────────────────────────────────────────────────────
#
# Bodies arrive on standard input:
#
#     make pr-address thread=PRRT_... <<'EOF'
#     git log -1 --format=%B | make pr-comment
#     make issue-comment issue=7 < notes.md
#
# Make expands command-line assignments during parsing. Text containing Make
# expressions can execute before a recipe receives it. Standard input avoids
# Make expansion, shell interpolation, and argument-length limits.
#
# Titles arrive through the environment so standard input remains available
# for the body:
#
#     TITLE='Fix the retry loop' make issue-create < issue.md
#
# Environment values remain literal. A command-line TITLE assignment would
# expand Make expressions, so the check below rejects that form.
#
# Paths use Make arguments such as files= and path=. Targets such as stage
# export literal values with $(value ...) to keep them out of shell source.
#
# Required bodies may be read from a terminal. Targets with optional bodies
# use NO_TTY_READ so a title-only edit or generated release does not wait for
# terminal input.
NO_TTY_READ := [ -t 0 ] ||
FREE_TEXT_VARS := TITLE COMMENT SEARCH
$(foreach v,$(FREE_TEXT_VARS),$(if $(filter command line,$(origin $(v))),$(error \
$(v) was passed as a make argument, which make expands; use $(v)='...' make <target>)))

# The arguments these replaced. Make ignores an unused command-line assignment,
# so without this a stale `body="Fixed"` would be dropped in silence and the
# target would go on to read an empty body from stdin.
RETIRED_TEXT_ARGS := body title comment notes search detail \
body_file message_file notes_file detail_file
$(foreach v,$(RETIRED_TEXT_ARGS),$(if $(filter command line,$(origin $(v))),$(error \
$(v)= is no longer an argument: a body comes from stdin (make <target> < file) \
and a title from the environment (TITLE='...' make <target>))))

# ═══ Daily ════════════════════════════════════════════════════════════════════════

# ─── Start here @start ────────────────────────────────────────────────────────────

.PHONY: help help-json status install node-install install-hooks setup-base setup setup-all clean-venv clean

help: ## Show command groups (expand one with make help-<group>)
	@printf '\n  \033[1mmake <target>\033[0m   ·   expand a group: \033[1mmake help-<group>\033[0m   ·   machine-readable: \033[1mmake help-json\033[0m\n'
	@awk ' \
		/^# ═══ / { \
			tier = $$0; sub(/^# ═══ /, "", tier); end = index(tier, " ═"); \
			if (end) tier = substr(tier, 1, end - 1); \
			printf "\n  \033[1m%s\033[0m\n", tier; \
		} \
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

# Runs on the system interpreter, not the venv one, because the first thing it
# has to be able to report is that the venv is missing.
status: ## Show workspace health (git, Python, Node, web build, PR)
	@$(PY_PATH_PREFIX) $(SYSTEM_PYTHON) -m scripts.lib.workspace_status \
		--venv-python "$(VENV_PYTHON)" --uv "$(UV)" --npm "$(NPM)"

install: ## Install locked Python deps into the uv-managed virtual environment
	UV_PROJECT_ENVIRONMENT=$(VENV) $(UV) sync --all-groups --frozen --python $(PYTHON)

node-install: ## Install locked Node deps
	$(NPM) ci

install-hooks: ## Install local pre-commit Git hooks
	$(UVX) pre-commit install

setup-base: install node-install ## Install Python and Node deps

setup: setup-base ## Install Python and Node deps (fast, no browsers)

setup-all: setup-base setup-playwright ## Full local setup with Playwright browsers, no system deps or sudo

clean-venv: ## Safely remove the repository-local Python virtual environment
clean-venv: export CLEAN_REPO_ROOT := $(CURDIR)
clean-venv: export CLEAN_VENV := $(VENV)
clean-venv:
	@$(PY_PATH_PREFIX) $(SYSTEM_PYTHON) -m scripts.setup.clean_venv

clean: clean-venv ## Remove local environments, build outputs, and caches (keeps shared Playwright browsers)
	rm -rf node_modules web/dist .artifacts .playwright .pytest_cache .ruff_cache .mypy_cache .coverage htmlcov coverage playwright-report test-results build dist *.egg-info

# ─── Develop @dev ─────────────────────────────────────────────────────────────────

.PHONY: web web-preview run-cli

web: ## Start the Vite dev server
	$(NPM) run dev

web-preview: ## Preview the production web build
	$(NPM) run preview

run-cli: ## Run the linkedin-analyzer CLI (args="shares|comments|messages|connections|all ...")
	$(VENV)/bin/linkedin-analyzer $(args)

# ─── Lint @lint ───────────────────────────────────────────────────────────────────

.PHONY: lint editorconfig-check lint-doc-commands lint-make-targets lint-py lint-js lint-css lint-yaml lint-workflows

lint: editorconfig-check lint-doc-commands lint-make-targets lint-py lint-js lint-css lint-yaml lint-workflows ## Run all linters

editorconfig-check: ## Check EditorConfig rules [paths=...]
	$(VENV_PYTHON) -m scripts.lint.check_editorconfig $(if $(paths),$(paths))

lint-doc-commands: ## Check contributor docs use Make targets [paths=...]
	$(VENV_PYTHON) -m scripts.lint.check_doc_commands $(if $(paths),$(paths))

lint-make-targets: ## Check Make targets named in docs, CI, and source exist, and that no recipe holds raw shell control flow [paths=...]
	$(VENV_PYTHON) -m scripts.lint.check_make_targets $(if $(paths),$(paths))

lint-py: ## Run Python linter only
	$(VENV_PYTHON) -m ruff check $(PY_PATHS)

lint-js: ## Run ESLint only
	$(NPM) run lint

lint-css: ## Run stylelint only
	$(NPM) run lint:css

lint-yaml: ## Run yamllint only [paths=...]
	$(VENV_PYTHON) -m yamllint $(if $(paths),$(paths),.)

lint-workflows: ## Run GitHub workflow linter only
	$(NPM) run lint:workflows

# ─── Format @format ───────────────────────────────────────────────────────────────

.PHONY: fmt fmt-py fmt-js fmt-css format-check format-py-check format-py-diff format-js-check format-js-diff align-tables align-tables-check

fmt: fmt-py fmt-js fmt-css align-tables ## Auto-fix owned code, metadata, and Markdown tables

fmt-py: ## Auto-fix Python with ruff
	$(VENV_PYTHON) -m ruff check --fix $(PY_PATHS)
	$(VENV_PYTHON) -m ruff format $(PY_PATHS)

fmt-js: ## Auto-fix JavaScript and formatted metadata
	$(NPM) run format
	$(NPM) run lint -- --fix

fmt-css: ## Auto-fix CSS with stylelint
	$(NPM) run lint:css -- --fix

format-check: format-py-check format-js-check align-tables-check ## Check code, metadata, and Markdown table formatting

format-py-check: ## Check Python formatting only
	$(VENV_PYTHON) -m ruff format --check $(PY_PATHS)

format-py-diff: ## Show Python formatting changes without modifying files [paths=...]
	$(VENV_PYTHON) -m ruff format --check --diff $(if $(paths),$(paths),$(PY_PATHS))

format-js-check: ## Check Prettier formatting only
	$(NPM) run format:check

# Prettier has no --diff. Compare its output with the original file to preview
# formatting changes without modifying the file, as format-py-diff does.
#
# The result goes to a file rather than through a pipe so that a Prettier
# failure is still an error; in a pipeline its status would be discarded. Only
# diff's exit 1, "the files differ", is tolerated, since that is this target's
# entire purpose. Exit 2 and above stay failures.
format-js-diff: ## Show Prettier formatting changes without modifying files (make format-js-diff path=docs/x.md)
	@test -n "$(path)" || (printf 'Usage: make format-js-diff path=docs/development.md\n' >&2; exit 1)
	@set -e; \
	formatted=$$(mktemp "$${TMPDIR:-/tmp}/linkedin-analyzer-prettier.XXXXXX"); \
	trap 'rm -f -- "$$formatted"' EXIT; \
	$(NPX) prettier --config config/prettierrc.json --ignore-path config/prettierignore \
		-- "$(path)" > "$$formatted"; \
	diff -u -- "$(path)" "$$formatted" || test $$? -eq 1

align-tables: ## Align Markdown table pipes [paths="README.md docs/example.md"]
	$(VENV_PYTHON) -m scripts.lint.align_tables $(if $(paths),$(paths))

align-tables-check: ## Check Markdown table pipe alignment [paths="README.md docs/example.md"]
	$(VENV_PYTHON) -m scripts.lint.align_tables --check $(if $(paths),$(paths))

# ─── Types and dead code @types ───────────────────────────────────────────────────

.PHONY: typecheck typecheck-py typecheck-web dead-code dead-code-py dead-code-js

typecheck: typecheck-py typecheck-web ## Run all type checks

typecheck-py: ## Run mypy only
	$(VENV_PYTHON) -m mypy $(PY_TYPE_PATHS)

typecheck-web: ## Run web type checks only
	$(NPM) run typecheck:web

dead-code: dead-code-py dead-code-js ## Detect unused code (vulture + knip)

dead-code-py: ## Detect unused Python code (vulture)
	$(VENV_PYTHON) -m vulture

dead-code-js: ## Detect unused JS code, exports, and deps (knip)
	$(NPM) run dead-code

# ─── Test @test ───────────────────────────────────────────────────────────────────

.PHONY: test test-py test-js test-js-quick test-e2e test-e2e-dev test-e2e-container test-e2e-headed test-e2e-ui test-browser-xlsx gen-parity-corpus

test: test-py test-js ## Run non-browser Python and JS tests

test-py: ## Run Python tests only (make test-py ARGS="-k name --no-cov" for a subset)
	$(VENV_PYTHON) -m pytest $(ARGS)

test-js: ## Run JS unit tests only
	$(NPM) run test

test-js-quick: ## Run a subset of JS tests without coverage (make test-js-quick ARGS="analytics")
	$(NPX) vitest run --config web/vitest.config.mjs $(ARGS)

test-e2e: ## Run Playwright browser tests (make test-e2e ARGS="--project=chromium web/e2e/app.e2e.spec.js")
	$(PLAYWRIGHT_LOCAL_RUN) $(NPM) run test:e2e -- $(ARGS)

test-e2e-dev: ## Run Playwright against development modules, including content-blocker checks [ARGS=...]
	PLAYWRIGHT_DEV_SERVER=1 $(PLAYWRIGHT_LOCAL_RUN) $(NPM) run test:e2e -- $(ARGS)

test-e2e-container: ## Run Playwright tests in the immutable hosted-CI container
	$(DOCKER) run --rm --init --ipc=host \
		--user "$$(id -u):$$(id -g)" \
		--env CI=true \
		--volume "$(CURDIR):/work" \
		--workdir /work \
		$(PLAYWRIGHT_CI_IMAGE) \
		$(NPM) run test:e2e -- $(ARGS)

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

gen-parity-corpus: ## Regenerate the synthetic cross-runtime parity corpus fixtures
	$(NODE) scripts/fixtures/gen-parity-corpus.mjs

# ─── Gates, run before you push @gates ────────────────────────────────────────────

.PHONY: ci ci-fast check fix ci-python ci-web ci-platform-checks ci-quick-gates ci-heavy-checks

ci: ci-python lint-workflows ci-web ## Full local CI gate

ci-fast: ## Run the non-browser CI checks in parallel (excludes web-build-size)
	$(VENV_PYTHON) scripts/ci/run_parallel_checks.py editorconfig-check lint-doc-commands lint-make-targets lint-py lint-yaml format-py-check align-tables-check typecheck-py dead-code-py test-py lint-workflows lint-js lint-css format-js-check typecheck-web dead-code-js test-js

check: check-local test-e2e ## Full gate including browser tests

fix: fmt ci ## Auto-fix formatting, then run the full local CI gate

ci-python: editorconfig-check lint-doc-commands lint-make-targets lint-py lint-yaml format-py-check align-tables-check typecheck-py dead-code-py test-py ## Python CI gate

ci-web: format-js-check lint-js lint-css typecheck-web dead-code-js test-js web-build-size ## Web CI gate

ci-platform-checks: ## Run quick and heavy non-browser CI gates in order
	@$(MAKE) --no-print-directory ci-quick-gates
	@$(MAKE) --no-print-directory ci-heavy-checks

# A documentation-only change skips every other CI job, so this gate is the only
# one that sees it. Markdown table alignment belongs here for that reason.
ci-quick-gates: ## Run fast formatting, lint, and type checks in parallel
	$(VENV_PYTHON) scripts/ci/run_parallel_checks.py --timeout 1200 \
		editorconfig-check lint-doc-commands lint-make-targets \
		lint-py lint-yaml format-py-check align-tables-check typecheck-py \
		lint-workflows lint-js lint-css format-js-check typecheck-web

ci-heavy-checks: ## Run tests, dead-code checks, and the production build
	$(VENV_PYTHON) scripts/ci/run_parallel_checks.py --timeout 1200 \
		dead-code-py test-py dead-code-js test-js
	@$(MAKE) --no-print-directory web-build-size

# ═══ GitHub ═══════════════════════════════════════════════════════════════════════

# ─── Git @git ─────────────────────────────────────────────────────────────────────

.PHONY: git branch branch-current branch-switch branch-delete branch-delete-remote branch-prune rebase cherry-pick cherry-pick-continue cherry-pick-abort merge log diff diff-staged stage stage-all commit push

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

branch-switch: export BRANCH_NAME := $(value name)
branch-switch: ## Switch to an existing branch (make branch-switch name=X)
	@test -n "$$BRANCH_NAME" || (printf 'Usage: make branch-switch name=branch-name\n' >&2; exit 1)
	git switch -- "$$BRANCH_NAME"

branch-delete: export BRANCH_NAME := $(value name)
branch-delete: ## Delete a local branch (make branch-delete name=X [force=1])
	@test -n "$$BRANCH_NAME" || (printf 'Usage: make branch-delete name=branch-name [force=1]\n' >&2; exit 1)
	git branch $(if $(filter 1,$(value force)),-D,-d) -- "$$BRANCH_NAME"

branch-delete-remote: export BRANCH_NAME := $(value name)
branch-delete-remote: ## Delete a branch on origin (make branch-delete-remote name=X)
	@test -n "$$BRANCH_NAME" || (printf 'Usage: make branch-delete-remote name=branch-name\n' >&2; exit 1)
	$(if $(filter main heads/main refs/heads/main,$(value name)),$(error Refusing to delete main on origin))
	git push --delete -- origin "$$BRANCH_NAME"

# Branch names reach the helper through the environment, never interpolated
# into the recipe, so the target holds no shell logic of its own.
branch-prune: export PRUNE_MAIN_BRANCH := main
branch-prune: export PRUNE_CONFIRM := $(confirm)
branch-prune: ## Prune local branches whose content is already in main (make branch-prune [confirm=1])
	@$(PY_PATH_PREFIX) $(VENV_PYTHON) -m scripts.lib.prune_branches

rebase: ## Rebase the current branch onto its remote base (make rebase base=origin/main)
	@test -n "$(base)" || (printf 'Usage: make rebase base=origin/main\n' >&2; exit 1)
	git rebase "$(base)"

# Refs split on whitespace with globbing off. Git's revision walker reads
# options even after `--`, so Make refuses a word starting with `-` before any
# shell runs.
cherry-pick: export CHERRY_PICK_REFS := $(value ref)
cherry-pick: ## Apply commits onto the current branch (make cherry-pick ref="sha ..." [nocommit=1])
	@test -n "$$CHERRY_PICK_REFS" || (printf 'Usage: make cherry-pick ref="sha ..." [nocommit=1]\n' >&2; exit 1)
	$(if $(filter -%,$(value ref)),$(error Refusing option-like ref: $(firstword $(filter -%,$(value ref)))))
	set -f; git cherry-pick $(if $(filter 1,$(value nocommit)),--no-commit) -- $$CHERRY_PICK_REFS

cherry-pick-continue: ## Continue a cherry-pick after resolving conflicts
	git cherry-pick --continue

cherry-pick-abort: ## Abort an in-progress cherry-pick and restore the branch
	git cherry-pick --abort

merge: export MERGE_REF := $(value ref)
merge: ## Merge a ref into the current branch with a merge commit (make merge ref=origin/main)
	@test -n "$$MERGE_REF" || (printf 'Usage: make merge ref=origin/main\n' >&2; exit 1)
	git merge --no-ff --no-edit -- "$$MERGE_REF"

log: ## Show recent commit log
	git log --oneline -20

diff: ## Show unstaged changes
	git diff

diff-staged: ## Show staged changes
	git diff --cached

# Paths reach the helper through the environment, never interpolated into the
# recipe, so a name containing a space or a shell metacharacter stays inert.
stage: export STAGE_FILES := $(value files)
stage: export STAGE_FILE := $(value file)
stage: ## Stage selected files (make stage [files="path ..."] [file="one path with spaces"])
	@$(PY_PATH_PREFIX) $(VENV_PYTHON) -m scripts.lib.stage_files

stage-all: ## Stage all working tree changes
	git add -A

# Every message is assembled into a temporary file and screened before it
# reaches git, because a mistyped heredoc terminator silently records shell text
# (`EOF && make push 2>&1 | tail -3`) as part of the commit.
commit: ## Commit staged changes, message on stdin (make commit < msg.txt, or a heredoc)
	@set -e; \
	if [ -t 0 ]; then \
		printf 'Commit message must be provided on stdin. Usage: make commit < msg.txt, or a heredoc\n' >&2; \
		exit 1; \
	fi; \
	tmp=$$(mktemp "$${TMPDIR:-/tmp}/linkedin-analyzer-commit-message.XXXXXX"); \
	chmod 600 "$$tmp"; \
	trap 'rm -f -- "$$tmp"' EXIT; \
	cat > "$$tmp"; \
	test -s "$$tmp" || \
		{ printf 'Empty commit message. Usage: make commit < msg.txt, or a heredoc\n' >&2; exit 1; }; \
	$(GH) check-commit-message --message-file "$$tmp"; \
	git commit -F "$$tmp"

push: ## Push the current branch and set its upstream
	@branch=$$(git branch --show-current); test -n "$$branch" || { printf 'No current branch.\n' >&2; exit 1; }; git push -u origin -- "$$branch"

# ─── Pull requests and releases @pr ───────────────────────────────────────────────

.PHONY: pr pr-create pr-edit pr-list pr-status pr-checks pr-diff pr-checkout pr-comments pr-comment pr-review-comments pr-reply pr-resolve pr-address pr-comments-list pr-comment-delete pr-summary pr-watch pr-merge pr-merge-admin pr-reviewers pr-copilot-review pr-label pr-close release-create

pr: ## PR commands (make pr)
	@$(MAKE) --no-print-directory help-pr

pr-create: ## Open a pull request for the current branch (make pr-create [base=branch]; TITLE='...' make pr-create < body.md for an explicit one)
	@# TITLE alone selects the mode, so there is no half-specified state left for
	@# gh to prompt about, which would hang a non-interactive shell. Without it,
	@# the title and body come from the commits and stdin is not read.
	@if [ -z "$$TITLE" ]; then \
		$(GH) pr-create $(if $(base),--base "$(base)"); \
	else \
		$(GH) pr-create $(if $(base),--base "$(base)") --title "$$TITLE" --body-file -; \
	fi

# An empty stream leaves the body unchanged. NO_TTY_READ prevents title-only
# edits from waiting for terminal input.
pr-edit: ## Edit the current PR (TITLE='...' make pr-edit; new body on stdin: make pr-edit < body.md) [pr_num=N]
	@set -e; \
	body=""; $(NO_TTY_READ) body=$$(cat); \
	test -n "$$TITLE$$body" || \
		{ printf "Usage: TITLE='New title' make pr-edit, or make pr-edit < body.md\n" >&2; exit 1; }; \
	set -- $(if $(pr_num),--pr "$(pr_num)"); \
	if [ -n "$$TITLE" ]; then set -- "$$@" --title "$$TITLE"; fi; \
	if [ -n "$$body" ]; then \
		printf '%s' "$$body" | $(GH) edit-pr "$$@" --body-file -; \
	else \
		$(GH) edit-pr "$$@"; \
	fi

pr-list: ## List open pull requests
	@$(GH) pr-list

pr-status: ## Show a PR's status and CI checks (make pr-status [pr_num=N])
	@$(GH) pr-status $(if $(pr_num),--pr "$(pr_num)")

pr-checks: ## Watch CI checks until done (make pr-checks [pr_num=N])
	@$(GH) pr-checks $(if $(pr_num),--pr "$(pr_num)") || true

pr-diff: ## Show the diff for a PR (make pr-diff [pr_num=N])
	@$(GH) pr-diff $(if $(pr_num),--pr "$(pr_num)")

pr-checkout: ## Check out a PR's branch locally (make pr-checkout pr_num=N)
	@test -n "$(pr_num)" || (printf 'Usage: make pr-checkout pr_num=123\n' >&2; exit 1)
	@$(GH) pr-checkout --pr "$(pr_num)"

pr-comments: ## Show all comments on a PR (make pr-comments [pr_num=N])
	@$(GH) pr-comments $(if $(pr_num),--pr "$(pr_num)")

# Pass prose directly from stdin to the helper. Quotes, backticks, and newlines
# never become shell source text, and the body is not written to disk.
pr-comment: ## Add a comment to the current PR, body on stdin (make pr-comment < notes.md) [pr_num=N]
	@$(GH) comment $(if $(pr_num),--pr "$(pr_num)") --body-file -

pr-review-comments: ## List review threads with ids (make pr-review-comments [pr_num=N] [show=all])
	@$(GH) list $(if $(pr_num),--pr "$(pr_num)") $(if $(filter all,$(show)),--all)

pr-reply: ## Reply to a review thread, body on stdin (make pr-reply thread=PRRT_... < notes.md) [pr_num=N]
	@test -n "$(thread)" || (printf 'Usage: make pr-reply thread=PRRT_... < notes.md\n' >&2; exit 1)
	@$(GH) reply --thread "$(thread)" $(if $(pr_num),--pr "$(pr_num)") --body-file -

pr-resolve: ## Resolve a review thread (make pr-resolve thread=PRRT_...) [pr_num=N]
	@test -n "$(thread)" || (printf 'Usage: make pr-resolve thread=PRRT_...\n' >&2; exit 1)
	@$(GH) resolve --thread "$(thread)" $(if $(pr_num),--pr "$(pr_num)")

pr-address: ## Reply to and resolve a review thread, body on stdin (make pr-address thread=PRRT_... < notes.md) [pr_num=N]
	@test -n "$(thread)" || (printf 'Usage: make pr-address thread=PRRT_... < notes.md\n' >&2; exit 1)
	@$(GH) address --thread "$(thread)" $(if $(pr_num),--pr "$(pr_num)") --body-file -

pr-comments-list: ## List individual review comments with node ids (make pr-comments-list [pr_num=N])
	@$(GH) list-comments $(if $(pr_num),--pr "$(pr_num)")

# Use comment_id for an opaque identifier. The issue targets reserve comment
# for prose, which must not be interpolated into shell source text.
pr-comment-delete: ## Delete a review comment by node id or numeric id (make pr-comment-delete comment_id=PRRC_...)
	@test -n "$(comment_id)" || (printf 'Usage: make pr-comment-delete comment_id=PRRC_...\n' >&2; exit 1)
	@$(GH) delete-comment --comment "$(comment_id)"

pr-summary: ## One-screen PR overview: state, CI rollup, open threads (make pr-summary [pr_num=N])
	@$(GH) summary $(if $(pr_num),--pr "$(pr_num)")

pr-watch: ## Observe the Copilot review and checks (make pr-watch [pr_num=N] [request=1] [interval=S] [max_polls=K] [expected_checks=N] [checks_only=1])
	@$(GH) watch $(if $(pr_num),--pr "$(pr_num)") $(if $(filter 1,$(request)),--request-copilot) $(if $(interval),--interval "$(interval)") $(if $(max_polls),--max-polls "$(max_polls)") $(if $(expected_checks),--expected-checks "$(expected_checks)") $(if $(filter 1,$(checks_only)),--checks-only)

pr-merge: ## Merge the current PR (squash, delete branch) (make pr-merge [pr_num=N])
	@$(GH) pr-merge $(if $(pr_num),--pr "$(pr_num)")

pr-merge-admin: ## Force merge bypassing branch protection (admin) (make pr-merge-admin [pr_num=N])
	@$(GH) pr-merge $(if $(pr_num),--pr "$(pr_num)") --admin

pr-reviewers: ## Add reviewers (make pr-reviewers users="user1,user2" [pr_num=N])
	@test -n "$(users)" || (printf 'Usage: make pr-reviewers users="octocat"\n' >&2; exit 1)
	@$(GH) pr-reviewers --users "$(users)" $(if $(pr_num),--pr "$(pr_num)")

pr-copilot-review: ## Request (or re-request) a Copilot review on the PR (make pr-copilot-review [pr_num=N])
	@$(GH) copilot-review $(if $(pr_num),--pr "$(pr_num)")

pr-label: ## Add labels (make pr-label labels="bug" [pr_num=N])
	@test -n "$(labels)" || (printf 'Usage: make pr-label labels="bug"\n' >&2; exit 1)
	@$(GH) pr-label --labels "$(labels)" $(if $(pr_num),--pr "$(pr_num)")

pr-close: ## Close a PR and delete its branch (make pr-close [pr_num=N])
	@$(GH) pr-close $(if $(pr_num),--pr "$(pr_num)")

release-create: ## Tag and publish a GitHub release, notes on stdin or generated when empty (make release-create tag=vX.Y.Z [prerelease=1] < notes.md)
	@test -n "$(tag)" || (printf 'Usage: make release-create tag=vX.Y.Z [prerelease=1] [< notes.md]\n' >&2; exit 1)
	@set -e; \
	tmp=$$(mktemp "$${TMPDIR:-/tmp}/linkedin-analyzer-release-notes.XXXXXX"); \
	chmod 600 "$$tmp"; \
	trap 'rm -f -- "$$tmp"' EXIT; \
	$(NO_TTY_READ) cat > "$$tmp"; \
	set -- "$(tag)" --title "$(tag)"; \
	if [ -s "$$tmp" ]; then set -- "$$@" --notes-file "$$tmp"; else set -- "$$@" --generate-notes; fi; \
	if [ -n "$(prerelease)" ]; then set -- "$$@" --prerelease; fi; \
	gh release create "$$@"

# ─── Issues @issue ────────────────────────────────────────────────────────────────

.PHONY: issue issue-list issue-view issue-summary issue-create issue-comment issue-edit issue-close issue-reopen issue-label issue-unlabel issue-assign issue-unassign issue-develop

issue: ## Issue commands (make issue)
	@$(MAKE) --no-print-directory help-issue

issue-list: ## List issues (make issue-list [state=open|closed|all] [label=bug] [assignee=user | mine=1] [author=user] [limit=N]; SEARCH='...' to filter)
	@test -z "$(and $(assignee),$(filter 1,$(mine)))" || \
		(printf 'Use assignee=user or mine=1, not both.\n' >&2; exit 1)
	@set -e; \
	set -- $(if $(state),--state "$(state)") $(if $(label),--label "$(label)") \
		$(if $(assignee),--assignee "$(assignee)") $(if $(filter 1,$(mine)),--assignee @me) \
		$(if $(author),--author "$(author)") $(if $(limit),--limit "$(limit)"); \
	if [ -n "$$SEARCH" ]; then set -- "$$@" --search "$$SEARCH"; fi; \
	$(GH) issue-list "$$@"

issue-view: ## Show an issue with its comments (make issue-view issue=N)
	@test -n "$(issue)" || (printf 'Usage: make issue-view issue=123\n' >&2; exit 1)
	@$(GH) issue-view --issue "$(issue)"

issue-summary: ## One-screen issue overview: state, labels, assignees, recent comments (make issue-summary issue=N)
	@test -n "$(issue)" || (printf 'Usage: make issue-summary issue=123\n' >&2; exit 1)
	@$(GH) issue-summary --issue "$(issue)"

issue-create: ## Open an issue, body on stdin (TITLE='Fix X' make issue-create < issue.md [labels="a,b"] [assignee=@me])
	@test -n "$$TITLE" || \
		(printf "Usage: TITLE='Fix X' make issue-create < issue.md [labels=\"bug,ci\"] [assignee=@me]\n" >&2; exit 1)
	@$(GH) issue-create --title "$$TITLE" $(if $(labels),--labels "$(labels)") \
		$(if $(assignee),--assignee "$(assignee)") --body-file -

issue-comment: ## Comment on an issue, body on stdin (make issue-comment issue=N < notes.md)
	@test -n "$(issue)" || (printf 'Usage: make issue-comment issue=123 < notes.md\n' >&2; exit 1)
	@$(GH) issue-comment --issue "$(issue)" --body-file -

# Like pr-edit: an empty stream leaves the body alone, and a terminal is not read.
issue-edit: ## Edit an issue (TITLE='...' make issue-edit issue=N; new body on stdin: make issue-edit issue=N < body.md)
	@test -n "$(issue)" || (printf "Usage: TITLE='New title' make issue-edit issue=123, or make issue-edit issue=123 < body.md\n" >&2; exit 1)
	@set -e; \
	body=""; $(NO_TTY_READ) body=$$(cat); \
	test -n "$$TITLE$$body" || \
		{ printf "Nothing to change. Set TITLE='...' or pipe a new body in.\n" >&2; exit 1; }; \
	set -- --issue "$(issue)"; \
	if [ -n "$$TITLE" ]; then set -- "$$@" --title "$$TITLE"; fi; \
	if [ -n "$$body" ]; then \
		printf '%s' "$$body" | $(GH) issue-edit "$$@" --body-file -; \
	else \
		$(GH) issue-edit "$$@"; \
	fi

# The one place stdin cannot serve: gh issue close and reopen take --comment and
# offer no --comment-file, so there is nothing to point at a stream. A short
# note travels in the environment; anything longer belongs in its own comment,
# posted with issue-comment first.
issue-close: ## Close an issue (make issue-close issue=N [reason=completed|"not planned"]; COMMENT='...' to say why)
	@test -n "$(issue)" || (printf "Usage: make issue-close issue=123 [reason=completed], COMMENT='...' optional\n" >&2; exit 1)
	@set -e; \
	set -- --issue "$(issue)" $(if $(reason),--reason "$(reason)"); \
	if [ -n "$$COMMENT" ]; then set -- "$$@" --comment "$$COMMENT"; fi; \
	$(GH) issue-close "$$@"

issue-reopen: ## Reopen a closed issue (make issue-reopen issue=N; COMMENT='...' to say why)
	@test -n "$(issue)" || (printf "Usage: make issue-reopen issue=123, COMMENT='...' optional\n" >&2; exit 1)
	@set -e; \
	set -- --issue "$(issue)"; \
	if [ -n "$$COMMENT" ]; then set -- "$$@" --comment "$$COMMENT"; fi; \
	$(GH) issue-reopen "$$@"

issue-label: ## Add labels to an issue (make issue-label issue=N labels="bug,ci")
	@test -n "$(issue)" -a -n "$(labels)" || \
		(printf 'Usage: make issue-label issue=123 labels="bug,ci"\n' >&2; exit 1)
	@$(GH) issue-label --issue "$(issue)" --labels "$(labels)"

issue-unlabel: ## Remove labels from an issue (make issue-unlabel issue=N labels="bug,ci")
	@test -n "$(issue)" -a -n "$(labels)" || \
		(printf 'Usage: make issue-unlabel issue=123 labels="bug,ci"\n' >&2; exit 1)
	@$(GH) issue-unlabel --issue "$(issue)" --labels "$(labels)"

issue-assign: ## Assign users to an issue (make issue-assign issue=N users="a,b" | mine=1)
	@test -n "$(issue)" -a -n "$(users)$(if $(filter 1,$(mine)),me)" || \
		(printf 'Usage: make issue-assign issue=123 users="octocat" OR mine=1\n' >&2; exit 1)
	@$(GH) issue-assign --issue "$(issue)" $(if $(filter 1,$(mine)),--mine) \
		$(if $(users),--users "$(users)")

issue-unassign: ## Remove assignees from an issue (make issue-unassign issue=N users="a,b" | mine=1)
	@test -n "$(issue)" -a -n "$(users)$(if $(filter 1,$(mine)),me)" || \
		(printf 'Usage: make issue-unassign issue=123 users="octocat" OR mine=1\n' >&2; exit 1)
	@$(GH) issue-unassign --issue "$(issue)" $(if $(filter 1,$(mine)),--mine) \
		$(if $(users),--users "$(users)")

issue-develop: ## Create and check out a branch linked to an issue (make issue-develop issue=N [base=branch] [name=branch])
	@test -n "$(issue)" || (printf 'Usage: make issue-develop issue=123 [base=main] [name=branch]\n' >&2; exit 1)
	@$(GH) issue-develop --issue "$(issue)" $(if $(base),--base "$(base)") $(if $(name),--name "$(name)")

# ─── GitHub Actions @actions ──────────────────────────────────────────────────────

.PHONY: ci-runs ci-jobs ci-watch ci-failures ci-cancel ci-rerun ci-dispatch ci-workflows ci-workflow-disable ci-workflow-enable ci-caches ci-cache-delete ci-audit-repo-settings

ci-runs: ## List recent CI workflow runs
	gh run list -L 10

# ci-failures reads step logs, which GitHub withholds until a run completes, so
# it cannot say anything about a run that is hanging. This reports per-job
# status and elapsed time while the run is still going, which is what tells a
# stuck job apart from a slow one.
ci-jobs: ## Show per-job status for a run, including one still in progress (make ci-jobs [run=ID], defaults to this branch's latest)
	@run_id="$(RUN_ID)"; \
	test -n "$$run_id" || { printf 'Usage: make ci-jobs run=123456 (or run on a branch with a resolvable latest run)\n' >&2; exit 1; }; \
	gh run view "$$run_id" --json jobs \
		--template '{{range .jobs}}{{printf "%-12s %-10s %-8s %s\n" .status .conclusion .startedAt .name}}{{end}}'

ci-watch: ## Watch a CI run until done and fail if it fails (make ci-watch [run=ID], defaults to this branch's latest)
	@run_id="$(RUN_ID)"; \
	test -n "$$run_id" || { printf 'Usage: make ci-watch run=123456 (or run on a branch with a resolvable latest run)\n' >&2; exit 1; }; \
	gh run watch "$$run_id" --exit-status

ci-failures: ## Show failed-step logs for this branch's latest run (make ci-failures [run=ID])
	@$(GH) ci-failures $(if $(run),--run "$(run)")

# A hung job leaves the whole run in progress, and gh refuses to re-run a run
# that has not finished, so cancelling first is the only way to retry one.
ci-cancel: ## Cancel a workflow run that is still in progress (make ci-cancel run=ID)
	@test -n "$(run)" || (printf 'Usage: make ci-cancel run=123456\n' >&2; exit 1)
	gh run cancel "$(run)"

ci-rerun: ## Re-run a workflow run (make ci-rerun [run=ID] [failed=1], defaults to this branch's latest)
	@run_id="$(RUN_ID)"; \
	test -n "$$run_id" || { printf 'Usage: make ci-rerun run=123456 [failed=1] (or run on a branch with a resolvable latest run)\n' >&2; exit 1; }; \
	gh run rerun "$$run_id" $(if $(filter 1,$(failed)),--failed)

ci-dispatch: ## Start a workflow run (make ci-dispatch workflow=dependency-audit.yml [ref=branch] [inputs="key=value ..."])
	@test -n "$(workflow)" || (printf 'Usage: make ci-dispatch workflow=dependency-audit.yml [ref=branch] [inputs="key=value ..."]\n' >&2; exit 1)
	gh workflow run "$(workflow)" $(if $(ref),--ref "$(ref)") $(foreach kv,$(inputs),-f "$(kv)")

ci-workflows: ## List every workflow with its enabled state (make ci-workflows [repo=owner/name])
	gh api "repos/$(if $(repo),$(repo),{owner}/{repo})/actions/workflows" \
		--jq '.workflows[] | "\(.state)\t\(.name)\t\(.path)"'

ci-workflow-disable: ## Stop a workflow from triggering (make ci-workflow-disable workflow=refresh-python-locks.yml)
	@test -n "$(workflow)" || (printf 'Usage: make ci-workflow-disable workflow=refresh-python-locks.yml\n' >&2; exit 1)
	gh workflow disable "$(workflow)"

ci-workflow-enable: ## Let a disabled workflow trigger again (make ci-workflow-enable workflow=refresh-python-locks.yml)
	@test -n "$(workflow)" || (printf 'Usage: make ci-workflow-enable workflow=refresh-python-locks.yml\n' >&2; exit 1)
	gh workflow enable "$(workflow)"

ci-caches: ## List Actions caches, largest first (make ci-caches [limit=N] [key=prefix])
	gh cache list --limit "$(if $(limit),$(limit),30)" --sort size_in_bytes --order desc $(if $(key),--key "$(key)")

ci-cache-delete: ## Delete one Actions cache (make ci-cache-delete cache=ID_or_key [ref=refs/heads/BRANCH])
	@test -n "$(cache)" || (printf 'Usage: make ci-cache-delete cache=1234 [ref=refs/heads/main]\n' >&2; exit 1)
	gh cache delete "$(cache)" $(if $(ref),--ref "$(ref)")

# Run by hand, not from a workflow. Reading branch protection needs
# 'administration: read' and listing secrets needs 'secrets: read', and
# GITHUB_TOKEN can grant neither, so a workflow copy would only ever report
# that it could not look.
ci-audit-repo-settings: ## Report drift in GitHub repository settings (make ci-audit-repo-settings [repo=owner/name] [branch=main])
	@$(PY_PATH_PREFIX) $(VENV_PYTHON) -m scripts.ci.repo_audit \
		$(if $(repo),--repo "$(repo)") $(if $(branch),--default-branch "$(branch)")

# ═══ Occasional ═══════════════════════════════════════════════════════════════════

# ─── Build and deploy checks @build ───────────────────────────────────────────────

.PHONY: web-build web-size-check web-build-size web-smoke web-screens

web-build: ## Build the production web bundle
	$(NPM) run build

web-size-check: ## Enforce web bundle size budgets
	$(NPM) run size:check

web-build-size: web-build web-size-check ## Build web and enforce size budgets

web-smoke: ## Smoke-check a deployed web app (make web-smoke url=https://example.com)
	@test -n "$(url)" || (printf 'Usage: make web-smoke url=https://example.com\n' >&2; exit 1)
	$(NODE) scripts/checks/web-smoke.mjs "$(url)"

web-screens: ## Capture all screens at mobile/tablet/desktop viewports (dir=.artifacts/screens)
	SCREENS_DIR="$(or $(dir),.artifacts/screens)" $(PLAYWRIGHT_LOCAL_RUN) $(NPM) run test:e2e -- --project=chromium web/e2e/screenshots.e2e.spec.js

# ─── Benchmarks and local audits @bench ───────────────────────────────────────────
# Local-only tools. Most run against your private export in data/input (never
# committed); gen-large-export writes a synthetic one outside the repo instead.
# They skip cleanly when the export is absent unless strict=1 is set, except
# bench-browser, which generates a synthetic export with size_mb=N and otherwise
# fails when its inputs are missing. Any cross-runtime row dumps use a private
# temporary directory and are always removed.
# See docs/testing.md (Run local checks and benchmarks).

.PHONY: cleaner-diff xrt-diff bench bench-decode bench-browser audit-memory-python audit-memory-browser audit-state explore gen-large-export

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
	$(NODE) scripts/checks/pipeline-bench.mjs $(if $(runs),"$(runs)")

bench-decode: ## Benchmark and verify the upload decode layer (make bench-decode [runs=N])
	$(NODE) scripts/checks/perf-bench.mjs $(if $(runs),"$(runs)")

bench-browser: ## Time upload to Analytics and Messages in Chromium with a heap budget (make bench-browser [size_mb=N | input_dir=path] [runs=3] [cpu=1] [gpu=1] [mobile=0] [export=excel|pdf|pdf-summary] [budget_mb=N] [local_libs=1])
	NPM="$(NPM)" $(PLAYWRIGHT_LOCAL_RUN) $(NODE) scripts/checks/browser-bench.mjs $(if $(size_mb),--size-mb "$(size_mb)") $(if $(input_dir),--input-dir "$(input_dir)") $(if $(runs),--runs "$(runs)") $(if $(cpu),--cpu "$(cpu)") $(if $(gpu),--gpu "$(gpu)") $(if $(mobile),--mobile "$(mobile)") $(if $(budget_mb),--budget-mb "$(budget_mb)") $(if $(export),--export "$(export)")

audit-memory-python: ## Measure per-cleaner peak RSS on your export (make audit-memory-python [strict=1] [input_dir=path])
	$(VENV_PYTHON) scripts/checks/audit_memory_python.py $(if $(strict),--strict) $(if $(input_dir),--input-dir "$(input_dir)")

audit-memory-browser: ## Measure browser JS heap on your export in Chromium (make audit-memory-browser local_libs=1 [strict=1] [input_dir=path])
	NPM="$(NPM)" $(PLAYWRIGHT_LOCAL_RUN) $(NODE) scripts/checks/heap-audit.mjs $(if $(strict),--strict) $(if $(input_dir),--input-dir "$(input_dir)")

audit-state: ## Measure retained bytes of each analysis structure on your export (make audit-state [strict=1] [input_dir=path])
	$(NODE) --expose-gc scripts/checks/state-audit.mjs $(if $(strict),--strict) $(if $(input_dir),--input-dir "$(input_dir)")

explore: ## Print ad-hoc statistics over your export
	$(VENV_PYTHON) scripts/checks/li_explore.py

gen-large-export: ## Write a synthetic export outside the repo (make gen-large-export size_mb=100 [dir=path])
	$(NODE) scripts/fixtures/gen-large-export.mjs --size-mb "$(or $(size_mb),100)" $(if $(dir),--dir "$(dir)")

# ─── Security @security ───────────────────────────────────────────────────────────

.PHONY: security audit-python audit-node audit-fix-node check-overrides security-alerts security-code-alerts

security: audit-python audit-node check-overrides ## Run dependency and override audits

audit-python: ## Run policy-driven pip-audit against the frozen uv lock export
	@set -eu; \
	requirements_file=$$(mktemp "$${TMPDIR:-/tmp}/linkedin-analyzer-requirements.XXXXXX"); \
	chmod 600 "$$requirements_file"; \
	trap 'rm -f -- "$$requirements_file"' EXIT; \
	$(UV) export --quiet --all-groups --frozen --no-emit-project --format requirements.txt --output-file "$$requirements_file"; \
	$(PY_PATH_PREFIX) $(SYSTEM_PYTHON) -m scripts.ci.run_security_audit \
		--requirements "$$requirements_file" \
		--pip-audit "$(UV) run --with pip-audit pip-audit"

audit-node: ## Run policy-driven npm dependency audit (make audit-node [audit_level=high])
	@$(PY_PATH_PREFIX) $(SYSTEM_PYTHON) -m scripts.ci.run_npm_audit --npm "$(NPM)" $(if $(audit_level),--audit-level "$(audit_level)")

audit-fix-node: ## Apply available npm audit fixes to package-lock.json
	$(NPM) audit fix --package-lock-only

check-overrides: ## Check npm overrides are still needed
	$(NPM) run check:overrides

security-alerts: ## List open GitHub Dependabot alerts
	gh api --paginate 'repos/{owner}/{repo}/dependabot/alerts?state=open'

security-code-alerts: ## List open GitHub code scanning alerts
	gh api --paginate 'repos/{owner}/{repo}/code-scanning/alerts?state=open'

# ─── Dependencies @deps ───────────────────────────────────────────────────────────

.PHONY: lock lock-node lock-node-update fix-deps refresh-ci-pins

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

refresh-ci-pins: ## Refresh Playwright, uv, pre-commit, and GitHub Action pins
	$(NPM) install --package-lock-only --save-dev @playwright/test@latest
	$(SYSTEM_PYTHON) -m scripts.ci.refresh_ci_pins

# ─── Browsers @browsers ───────────────────────────────────────────────────────────

.PHONY: setup-playwright setup-playwright-engines setup-playwright-local playwright-local-status playwright-local-gate playwright-local-clean

setup-playwright: ## Install Playwright browsers locally, no system deps or sudo
	$(NPX) playwright install $(PLAYWRIGHT_BROWSERS)

setup-playwright-engines: ## Install selected engines (make setup-playwright-engines engines=chromium-webkit [with_deps=1])
	$(if $(strip $(engines)),,$(error Usage: make setup-playwright-engines engines=chromium-webkit [with_deps=1]))
	$(if $(filter-out 1,$(words $(strip $(engines)))),$(error engines must be one hyphen-separated value),)
	$(if $(filter -% %-,$(strip $(engines))),$(error engines must not start or end with a hyphen),)
	$(if $(findstring --,$(strip $(engines))),$(error engines must not contain empty names),)
	$(if $(PLAYWRIGHT_INVALID_ENGINES),$(error unsupported Playwright engine(s): $(PLAYWRIGHT_INVALID_ENGINES)),)
	$(if $(filter-out $(words $(sort $(PLAYWRIGHT_ENGINE_ARGS))),$(words $(PLAYWRIGHT_ENGINE_ARGS))),$(error engines must not contain duplicates),)
	$(if $(filter-out 0 1,$(words $(strip $(with_deps)))),$(error with_deps must be one value),)
	$(if $(filter-out 1,$(strip $(with_deps))),$(error with_deps must be 1 when provided),)
	$(NPX) playwright install $(if $(filter 1,$(with_deps)),--with-deps) $(filter $(PLAYWRIGHT_BROWSERS),$(PLAYWRIGHT_ENGINE_ARGS))

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

# ─── Aliases, old names that still work @aliases ──────────────────────────────────

.PHONY: format workflow-lint web-lint web-format-check web-typecheck web-test web-e2e web-e2e-container check-local check-fast pr-copilot

format: fmt ## Alias for fmt

workflow-lint: lint-workflows ## Alias for lint-workflows

web-lint: lint-js ## Alias for lint-js

web-format-check: format-js-check ## Alias for format-js-check

web-typecheck: typecheck-web ## Alias for typecheck-web

web-test: test-js ## Alias for test-js

web-e2e: test-e2e ## Alias for test-e2e

web-e2e-container: test-e2e-container ## Alias for test-e2e-container

check-local: ci ## Alias for the full local CI gate

check-fast: ci-fast ## Alias for ci-fast

pr-copilot: pr-copilot-review ## Backward-compatible alias for pr-copilot-review

# ═══ Internal ═════════════════════════════════════════════════════════════════════

# ─── CI helpers, mostly run by workflows @workflow ────────────────────────────────

.PHONY: setup-ci setup-playwright-ci ci-prune-uv-cache ci-changed-areas ci-check-results ci-coverage-summary ci-alert-issue ci-schedule-watchdog

setup-ci: setup-base setup-playwright-ci ## CI-only setup with Playwright browsers and system deps

setup-playwright-ci: ## Install Playwright browsers with system deps for CI
	$(NPX) playwright install --with-deps $(PLAYWRIGHT_BROWSERS)

ci-prune-uv-cache: ## Remove uv cache entries that are inefficient to persist in CI
	$(UV) cache prune --ci

# Both run before any toolchain is installed, in jobs that set up nothing, so
# they use the system interpreter and the standard library alone.
ci-changed-areas: ## Report which CI areas a change touches (make ci-changed-areas base=SHA head=SHA [merge_base=1])
	@$(PY_PATH_PREFIX) $(SYSTEM_PYTHON) -m scripts.ci.job_gating changed-areas \
		--base "$(base)" --head "$(head)" $(if $(merge_base),--merge-base)

# Reads each job result from the environment; see the CI result job in ci.yml.
ci-check-results: ## Check CI job results against the areas a change touched (make ci-check-results)
	@$(PY_PATH_PREFIX) $(SYSTEM_PYTHON) -m scripts.ci.job_gating check-results

# Reads the reports that test-py and test-js leave behind, so run it after them.
ci-coverage-summary: ## Print the coverage totals as markdown for a job summary (make ci-coverage-summary)
	@$(PY_PATH_PREFIX) $(VENV_PYTHON) -m scripts.ci.coverage_summary

# The title and detail are free text written by a failing workflow. The detail
# is a body like any other and arrives on stdin; an empty stream just means the
# alert has no detail. The title comes from the step environment, so the
# workflow never builds a make command line out of its own inputs.
ci-alert-issue: ## Sync a monitored alert issue, detail on stdin (TITLE='...' make ci-alert-issue label=L run_url=URL state=open|close|setup-failure [repo=owner/name])
	@test -n "$$TITLE" -a -n "$(label)" -a -n "$(run_url)" -a -n "$(state)" || \
		(printf "Usage: TITLE='Dependency audit failed' make ci-alert-issue label=dependency-audit run_url=URL state=open|close|setup-failure [repo=owner/name] < detail.md\n" >&2; exit 1)
	@set -e; \
	set -- --title "$$TITLE" --label "$(label)" --run-url "$(run_url)" --state "$(state)" \
		$(if $(repo),--repo "$(repo)"); \
	$(NO_TTY_READ) set -- "$$@" --detail-file -; \
	$(PY_PATH_PREFIX) $(VENV_PYTHON) -m scripts.ci.issue_alerts "$$@"

ci-schedule-watchdog: ## Detect disabled scheduled workflows (make ci-schedule-watchdog [repo=owner/name])
	@$(PY_PATH_PREFIX) $(VENV_PYTHON) -m scripts.ci.schedule_watchdog $(if $(repo),--repo "$(repo)")
