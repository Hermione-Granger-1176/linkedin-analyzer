from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).parents[1]
MAKEFILE_TEXT = (REPO_ROOT / "Makefile").read_text(encoding="utf-8")


def _target_recipe(name: str) -> str:
    """Return the recipe lines for one Makefile target."""
    match = re.search(
        rf"^{re.escape(name)}:.*\n(?P<recipe>(?:\t.*\n)+)",
        MAKEFILE_TEXT,
        re.MULTILINE,
    )
    assert match is not None, f"missing Makefile target: {name}"
    return match.group("recipe")


def test_playwright_uses_native_host_detection() -> None:
    """Do not retain the obsolete Ubuntu platform override workaround."""
    assert "PLAYWRIGHT_HOST_PLATFORM_OVERRIDE" not in MAKEFILE_TEXT
    assert "PLAYWRIGHT_SUPPORTED_UBUNTU" not in MAKEFILE_TEXT


def test_playwright_runtime_is_linted_and_type_checked() -> None:
    """Keep the setup utility in both Python quality scopes."""
    assert re.search(r"^PY_PATHS\s*:=.*scripts/setup/", MAKEFILE_TEXT, re.MULTILINE)
    assert re.search(r"^PY_TYPE_PATHS\s*:=.*scripts/setup/", MAKEFILE_TEXT, re.MULTILINE)


def test_local_playwright_setup_avoids_system_dependencies() -> None:
    """Keep local browser installation sudo-free."""
    recipe = _target_recipe("setup-playwright")

    assert "playwright install $(PLAYWRIGHT_BROWSERS)" in recipe
    assert "--with-deps" not in recipe


def test_ci_playwright_setup_installs_system_dependencies() -> None:
    """Keep Playwright's system dependency installation in the CI-only target."""
    recipe = _target_recipe("setup-playwright-ci")

    assert "playwright install --with-deps $(PLAYWRIGHT_BROWSERS)" in recipe


def test_local_playwright_runtime_setup_prepares_libs_and_shares_browsers() -> None:
    """Prepare private libraries around a shared, sudo-free browser install."""
    recipe = _target_recipe("setup-playwright-local")

    prepare = "$(PLAYWRIGHT_LOCAL_RUNTIME) prepare"
    # Browsers install into Playwright's shared cache, so no repository-local
    # browser path or private install environment is layered onto the install.
    assert "PLAYWRIGHT_LOCAL_INSTALL_ENV" not in MAKEFILE_TEXT
    assert "PLAYWRIGHT_LOCAL_BROWSERS" not in MAKEFILE_TEXT
    assert "PLAYWRIGHT_BROWSERS_PATH" not in recipe
    assert recipe.count(prepare) == 2
    assert "$(NPX) playwright install $(PLAYWRIGHT_BROWSERS)" in recipe
    assert recipe.index(prepare) < recipe.index("playwright install") < recipe.rindex(prepare)
    assert "--with-deps" not in recipe


def test_clean_removes_the_repository_local_playwright_cache() -> None:
    """Make clean should drop the repository-local Playwright cache too."""
    recipe = _target_recipe("clean")

    assert " .playwright " in recipe


def test_browser_targets_share_the_local_runtime_wrapper() -> None:
    """Require local_libs=1 to route every existing browser target through one wrapper."""
    assert (
        "PLAYWRIGHT_LOCAL_RUN = $(if $(filter 1,$(local_libs)),$(PLAYWRIGHT_LOCAL_RUNTIME) run --,)"
        in MAKEFILE_TEXT
    )
    for target in ("test-e2e", "test-e2e-headed", "test-e2e-ui", "web-screens"):
        assert "$(PLAYWRIGHT_LOCAL_RUN)" in _target_recipe(target)


def test_local_playwright_runtime_targets_are_exposed() -> None:
    """Keep all lifecycle and real-engine gate entry points discoverable through Make."""
    for target, action in (
        ("playwright-local-status", "status"),
        ("playwright-local-gate", "probe"),
        ("playwright-local-clean", "clean"),
    ):
        assert f"$(PLAYWRIGHT_LOCAL_RUNTIME) {action}" in _target_recipe(target)


def test_playwright_setup_installs_all_browser_engines() -> None:
    """Keep Chromium, Firefox, and WebKit in the shared browser list."""
    match = re.search(r"^PLAYWRIGHT_BROWSERS\s*:=\s*(?P<browsers>.+)$", MAKEFILE_TEXT, re.MULTILINE)
    assert match is not None
    assert match.group("browsers").split() == ["chromium", "firefox", "webkit"]


def test_targeted_node_lock_update_is_package_scoped() -> None:
    """Keep transitive security refreshes explicit and lockfile-only."""
    recipe = _target_recipe("lock-node-update")

    assert "$(call need,packages," in recipe
    assert "$(NPM) update --package-lock-only $(packages)" in recipe


def test_python_audit_export_stays_inside_the_repository() -> None:
    """Keep the lock export repository-local so worktrees cannot collide."""
    recipe = _target_recipe("audit-python")

    assert "/tmp/" not in recipe
    assert "mkdir -p .artifacts" in recipe
    assert recipe.count(".artifacts/requirements-audit.txt") == 2


def test_clean_removes_the_generated_artifacts_directory() -> None:
    """Make clean should drop the exports written by audit-python."""
    recipe = _target_recipe("clean")

    assert " .artifacts " in recipe


def test_generated_artifacts_directory_is_ignored() -> None:
    """Never track the generated audit export."""
    gitignore = (REPO_ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()

    assert ".artifacts/" in gitignore


def test_test_targets_ignore_inherited_args() -> None:
    """Honor ARGS only from the make command line, never from the environment."""
    assert "TEST_ARGS = $(if $(filter command line,$(origin ARGS)),$(ARGS))" in MAKEFILE_TEXT
    for target in ("test-py", "test-js-quick", "test-e2e"):
        recipe = _target_recipe(target)
        assert "$(TEST_ARGS)" in recipe
        assert "$(ARGS)" not in recipe


def test_action_sha_refresh_runs_through_make() -> None:
    """Keep the scheduled workflow on the Makefile interface."""
    recipe = _target_recipe("refresh-action-shas")
    assert "$(VENV_PYTHON) scripts/ci/refresh_action_shas.py" in recipe

    workflow_path = REPO_ROOT / ".github/workflows/refresh-action-shas.yml"
    workflow = workflow_path.read_text(encoding="utf-8")
    assert "run: make refresh-action-shas" in workflow
    assert "python3 scripts/ci/refresh_action_shas.py" not in workflow


def _section(slug: str) -> str:
    """Return the Makefile text belonging to one ``@slug`` help section."""
    match = re.search(
        rf"^# ─── [^\n]+? @{re.escape(slug)} [^\n]*$(?P<body>.*?)(?=^# ─── |\Z)",
        MAKEFILE_TEXT,
        re.MULTILINE | re.DOTALL,
    )
    assert match is not None, f"missing Makefile section: @{slug}"
    return match.group("body")


def test_need_macro_is_defined_and_used_for_single_variable_guards() -> None:
    """One shared macro emits every single-variable usage guard."""
    assert "define need" in MAKEFILE_TEXT
    assert "@test -n \"$($(1))\" || { printf 'Usage: %s\\n' '$(2)' >&2; exit 1; }" in MAKEFILE_TEXT
    for target in (
        "web-smoke",
        "lock-node-update",
        "branch",
        "branch-current",
        "log-file",
        "release-create",
        "pr-checkout",
        "pr-reply",
        "pr-resolve",
        "pr-address",
        "pr-comment-delete",
        "pr-reviewers",
        "pr-label",
        "issue-view",
        "issue-develop",
    ):
        assert "$(call need," in _target_recipe(target), target


def test_no_guard_uses_the_subshell_form() -> None:
    """Remaining multi-variable guards all use the brace form, never a subshell."""
    assert "|| (printf" not in MAKEFILE_TEXT


def test_commit_validates_the_message_and_supports_files_stdin_and_amend() -> None:
    """Commit routes every message through the linter before git sees it."""
    recipe = _target_recipe("commit")

    assert "commit: export COMMIT_MESSAGE := $(message)" in MAKEFILE_TEXT
    assert "$(GH) check-commit-message --message-file" in recipe
    assert '$(if $(filter -,$(message_file)),cat,cat "$(message_file)")' in recipe
    assert "$(if $(amend),--amend)" in recipe
    # The message is passed through the environment, never interpolated as shell.
    assert "printf '%s' \"$$COMMIT_MESSAGE\"" in recipe
    assert "git commit -m" not in recipe


def test_stage_delegates_to_the_tested_helper() -> None:
    """Staging never interpolates a path into a shell command line."""
    recipe = _target_recipe("stage")

    assert "$(VENV_PYTHON) -m scripts.lib.stage_files" in recipe
    assert "git add -- $(files)" not in MAKEFILE_TEXT


def test_push_force_uses_force_with_lease() -> None:
    """A force push must never be able to drop someone else's commits."""
    recipe = _target_recipe("push-force")

    assert "--force-with-lease" in recipe
    assert "--force " not in recipe


def test_rebase_fetches_before_rebasing_and_defaults_to_main_branch() -> None:
    """Rebasing onto stale local history is not possible."""
    recipe = _target_recipe("rebase")

    assert 'git fetch origin "$(if $(base),$(base),$(MAIN_BRANCH))"' in recipe
    assert 'git rebase "origin/$(if $(base),$(base),$(MAIN_BRANCH))"' in recipe
    assert re.search(r"^MAIN_BRANCH\s+\?=\s*main$", MAKEFILE_TEXT, re.MULTILINE)


def test_branch_uses_the_main_branch_variable() -> None:
    """No hardcoded "main" literal remains in the branch target."""
    recipe = _target_recipe("branch")

    assert "$(MAIN_BRANCH)" in recipe
    assert '"main"' not in recipe


def test_repo_resolves_from_the_remote_then_gh() -> None:
    """The shared repository slug has a remote-first fallback chain."""
    assert re.search(r"^REPO \?= \$\(strip \$\(shell", MAKEFILE_TEXT, re.MULTILINE)
    assert "git remote get-url origin" in MAKEFILE_TEXT
    assert "gh repo view --json nameWithOwner" in MAKEFILE_TEXT


def test_help_pattern_rule_cannot_be_shadowed_by_a_file() -> None:
    """Pattern rules are not covered by .PHONY, so help-% needs a FORCE prerequisite."""
    assert "help-%: FORCE ##" in MAKEFILE_TEXT
    assert re.search(r"^FORCE:$", MAKEFILE_TEXT, re.MULTILINE)


def test_status_runs_on_the_system_interpreter() -> None:
    """`make status` has to work before `make setup` builds the venv."""
    recipe = _target_recipe("status")

    assert "$(SYSTEM_PYTHON) -m scripts.lib.workspace_status" in recipe
    assert "$(VENV_PYTHON) -m scripts.lib.workspace_status" not in recipe
    assert re.search(r"^SYSTEM_PYTHON\s+\?=\s*python3$", MAKEFILE_TEXT, re.MULTILINE)


def test_scripts_lib_is_linted_and_type_checked() -> None:
    """Keep the new shared library inside both Python quality scopes."""
    assert re.search(r"^PY_PATHS\s*:=.*scripts/lib/", MAKEFILE_TEXT, re.MULTILINE)
    assert re.search(r"^PY_TYPE_PATHS\s*:=.*scripts/lib/", MAKEFILE_TEXT, re.MULTILINE)


def test_every_pr_target_accepts_a_pr_number() -> None:
    """No PR target is limited to the current branch's PR."""
    for target in (
        "pr-status",
        "pr-checks",
        "pr-diff",
        "pr-checkout",
        "pr-comments",
        "pr-comment",
        "pr-merge",
        "pr-merge-admin",
        "pr-reviewers",
        "pr-label",
        "pr-close",
    ):
        assert "$(pr_num)" in _target_recipe(target), target
    for target in (
        "pr-review-comments",
        "pr-comments-list",
        "pr-summary",
        "pr-watch",
        "pr-copilot",
    ):
        assert "$(if $(pr_num),--pr $(pr_num))" in _target_recipe(target), target


def test_pr_num_has_a_smart_default() -> None:
    """The PR number falls back to the current branch's PR."""
    assert (
        "PR_NUM = $(if $(pr_num),$(pr_num),"
        "$(strip $(shell gh pr view --json number -q .number 2>/dev/null)))" in MAKEFILE_TEXT
    )
    assert "$(PR_NUM)" in _target_recipe("pr-edit")


def test_comment_targets_accept_a_body_file_and_export_the_inline_body() -> None:
    """Multiline bodies never round-trip through shell quoting."""
    for target, env_var in (
        ("pr-comment", "PR_COMMENT_BODY"),
        ("pr-reply", "PR_REPLY_BODY"),
        ("pr-address", "PR_ADDRESS_BODY"),
        ("issue-comment", "ISSUE_COMMENT_BODY"),
    ):
        recipe = _target_recipe(target)
        assert "$(body_file)" in recipe, target
        assert f"$${env_var}" in recipe, target
        assert f"{target}: export {env_var} := $(body)" in MAKEFILE_TEXT, target


def test_issue_group_is_its_own_section_with_the_full_surface() -> None:
    """Issue work is discoverable through `make help-issue`, not buried in @ci."""
    issue_section = _section("issue")
    for target in (
        "issue-list",
        "issue-view",
        "issue-summary",
        "issue-create",
        "issue-comment",
        "issue-edit",
        "issue-label",
        "issue-unlabel",
        "issue-assign",
        "issue-unassign",
        "issue-close",
        "issue-reopen",
        "issue-develop",
    ):
        assert f"\n{target}:" in issue_section, target
    # The old single-target entry point still works, and is no longer in @ci.
    assert "\nissues: issue-list" in issue_section
    assert "issue" not in _section("ci")


def test_ci_run_targets_share_a_run_id_smart_default() -> None:
    """Run-scoped CI targets default to this branch's latest run."""
    assert "RUN_ID = $(if $(run),$(run),$(strip $(shell $(GH) latest-run-id 2>/dev/null)))" in (
        MAKEFILE_TEXT
    )
    for target in ("ci-run", "ci-run-log"):
        recipe = _target_recipe(target)
        assert 'run_id="$(RUN_ID)"' in recipe, target
        assert "exit 1" in recipe, target
    assert '--job "$(job)"' in _target_recipe("ci-job-log")
