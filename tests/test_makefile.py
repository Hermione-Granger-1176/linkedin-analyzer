from __future__ import annotations

import re
from pathlib import Path

import pytest

MAKEFILE_TEXT = (Path(__file__).parents[1] / "Makefile").read_text(encoding="utf-8")


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


def test_selected_playwright_setup_validates_engines_and_dependencies() -> None:
    """Keep selective installs constrained to supported engine names and CI dependency mode."""
    recipe = _target_recipe("setup-playwright-engines")

    assert "unsupported Playwright engine(s): $(PLAYWRIGHT_INVALID_ENGINES)" in recipe
    assert "engines must not contain duplicates" in recipe
    assert "with_deps must be one value" in recipe
    assert "with_deps must be 1 when provided" in recipe
    assert "$(if $(filter 1,$(with_deps)),--with-deps)" in recipe
    assert "$(filter $(PLAYWRIGHT_BROWSERS),$(PLAYWRIGHT_ENGINE_ARGS))" in recipe


def test_node_audit_uses_policy_runner_and_optional_severity_filter() -> None:
    """Keep CI on the reviewed policy while allowing a narrower local audit."""
    recipe = _target_recipe("audit-node")

    assert "-m scripts.ci.run_npm_audit" in recipe
    assert '--npm "$(NPM)"' in recipe
    assert '$(if $(audit_level),--audit-level "$(audit_level)")' in recipe


def test_python_audit_uses_policy_runner_and_private_temporary_export() -> None:
    """Keep the frozen Python audit export private and policy-driven."""
    recipe = _target_recipe("audit-python")

    assert "set -eu" in recipe
    assert (
        'requirements_file=$$(mktemp "$${TMPDIR:-/tmp}/'
        'linkedin-analyzer-requirements.XXXXXX")' in recipe
    )
    assert 'chmod 600 "$$requirements_file"' in recipe
    assert "trap 'rm -f -- \"$$requirements_file\"' EXIT" in recipe
    assert "$(UV) export --quiet" in recipe
    assert '--output-file "$$requirements_file"' in recipe
    assert "-m scripts.ci.run_security_audit" in recipe
    assert '--requirements "$$requirements_file"' in recipe
    assert '--pip-audit "$(UV) run --with pip-audit pip-audit"' in recipe
    assert "/tmp/linkedin-analyzer-requirements.txt" not in recipe


@pytest.mark.parametrize(
    ("target", "template"),
    [
        ("release-create", "linkedin-analyzer-release-notes.XXXXXX"),
        ("commit", "linkedin-analyzer-commit-message.XXXXXX"),
    ],
)
def test_sensitive_message_files_use_portable_private_temp_paths(
    target: str, template: str
) -> None:
    """Use TMPDIR-aware templates for temporary GitHub message files."""
    recipe = _target_recipe(target)

    assert f'mktemp "$${{TMPDIR:-/tmp}}/{template}"' in recipe
    assert 'chmod 600 "$$tmp"' in recipe
    assert 'rm -f -- "$$tmp"' in recipe
    assert "$$(mktemp)" not in recipe


def test_no_recipe_clobbers_the_developers_python_path() -> None:
    """Recipes extend PYTHONPATH through the shared prefix instead of replacing it.

    A bare ``PYTHONPATH=.`` discards a value the developer set for their own
    tooling. One shared variable is used so a new ``python -m scripts.*`` target
    cannot reintroduce the clobber by copying an older line.
    """
    assert "PY_PATH_PREFIX = PYTHONPATH=.$${PYTHONPATH:+:$${PYTHONPATH}}" in MAKEFILE_TEXT
    # The definition itself continues with $${...}, so a trailing space only
    # appears where a recipe assigned the bare value and dropped what was there.
    assert "PYTHONPATH=. " not in MAKEFILE_TEXT


def test_no_recipe_interpolates_free_text_into_a_shell_command() -> None:
    """Free text reaches a target through the environment, never through the recipe.

    An interpolated value becomes shell source text: a newline ends the line
    mid-quote, a double quote closes it, and backticks are evaluated. Each broken
    spelling is pinned by hand so a new target cannot reintroduce the bug by
    copying an older line.
    """
    for interpolation in (
        '--body "$(body)"',
        '--title "$(title)"',
        '--detail "$(detail)"',
        '--comment "$(comment)"',
        '--search "$(search)"',
        '--notes "$(notes)"',
    ):
        assert interpolation not in MAKEFILE_TEXT


@pytest.mark.parametrize(
    "assignment",
    [
        "PR_COMMENT_BODY := $(value body)",
        "PR_REPLY_BODY := $(value body)",
        "PR_ADDRESS_BODY := $(value body)",
        "PR_EDIT_TITLE := $(value title)",
        "PR_EDIT_BODY := $(value body)",
        "ALERT_ISSUE_TITLE := $(value title)",
        "ALERT_ISSUE_DETAIL := $(value detail)",
        "COMMIT_TITLE := $(value title)",
        "COMMIT_BODY := $(value body)",
        "RELEASE_NOTES := $(value notes)",
        "RELEASE_NOTES_FILE := $(value notes_file)",
        "STAGE_FILES := $(value files)",
        "STAGE_FILE := $(value file)",
        "PR_CREATE_TITLE := $(value title)",
        "PR_CREATE_BODY := $(value body)",
        "ISSUE_SEARCH := $(value search)",
        "ISSUE_TITLE := $(value title)",
        "ISSUE_BODY := $(value body)",
        "ISSUE_COMMENT_BODY := $(value body)",
        "ISSUE_EDIT_TITLE := $(value title)",
        "ISSUE_EDIT_BODY := $(value body)",
        "ISSUE_CLOSE_COMMENT := $(value comment)",
        "ISSUE_REOPEN_COMMENT := $(value comment)",
    ],
)
def test_free_text_exports_keep_the_value_unexpanded(assignment: str) -> None:
    """User-supplied text is exported with ``$(value ...)`` so make cannot rewrite it.

    A plain ``:= $(body)`` expands make syntax inside the text, so a body
    mentioning ``$(x)`` silently loses it. ``$(value ...)`` hands over the
    characters the author typed.

    This does not make a body inert. Make expands a command-line assignment
    while parsing it, so ``$(shell ...)`` in a body still runs no matter how it
    is exported later. ``body_file=`` is the input that avoids make entirely,
    and it is what pasted text should use.
    """
    assert assignment in MAKEFILE_TEXT


@pytest.mark.parametrize(
    ("target", "subcommand", "variable"),
    [
        ("pr-comment", "comment", "PR_COMMENT"),
        ("pr-reply", "reply", "PR_REPLY"),
        ("pr-address", "address", "PR_ADDRESS"),
        ("pr-edit", "edit-pr", "PR_EDIT"),
    ],
)
def test_posting_targets_pipe_the_body_instead_of_writing_it_out(
    target: str, subcommand: str, variable: str
) -> None:
    """Bodies reach the helper over stdin, so they can be long, multi-line, or both.

    ``--body-file -`` already reads stdin, so an inline body needs no temporary
    file. That is one fewer place the text can be left behind on disk, and it
    removes the mktemp, chmod, and trap dance these targets would otherwise
    repeat verbatim.
    """
    recipe = _target_recipe(target)

    assert f"{target}: export {variable}_BODY := $(value body)" in MAKEFILE_TEXT
    assert f"{target}: export {variable}_BODY_FILE := $(value body_file)" in MAKEFILE_TEXT
    assert f"printf '%s' \"$${variable}_BODY\" | $(GH) {subcommand}" in recipe
    assert f'--body-file "$${variable}_BODY_FILE"' in recipe
    assert "--body-file -" in recipe
    assert "mktemp" not in recipe


@pytest.mark.parametrize(
    ("target", "command", "variable"),
    [
        ("issue-create", "gh issue create", "ISSUE"),
        ("issue-comment", "gh issue comment", "ISSUE_COMMENT"),
        ("issue-edit", "gh issue edit", "ISSUE_EDIT"),
    ],
)
def test_issue_posting_targets_pipe_the_body_instead_of_writing_it_out(
    target: str, command: str, variable: str
) -> None:
    """Issue bodies reach gh over stdin, on the same terms as the PR targets.

    ``gh`` reads ``--body-file -`` from standard input, so an inline body needs
    no temporary file and a pasted one can use ``body_file=`` to skip make's
    parser entirely.
    """
    recipe = _target_recipe(target)

    assert f"{target}: export {variable}_BODY := $(value body)" in MAKEFILE_TEXT
    assert f"{target}: export {variable}_BODY_FILE := $(value body_file)" in MAKEFILE_TEXT
    assert f"printf '%s' \"$${variable}_BODY\" | {command}" in recipe
    assert f'--body-file "$${variable}_BODY_FILE"' in recipe
    assert "--body-file -" in recipe
    assert "mktemp" not in recipe


@pytest.mark.parametrize(
    ("target", "variable"),
    [("issue-close", "ISSUE_CLOSE_COMMENT"), ("issue-reopen", "ISSUE_REOPEN_COMMENT")],
)
def test_issue_state_changes_pass_their_comment_through_the_environment(
    target: str, variable: str
) -> None:
    """Closing and reopening carry their comment in the environment.

    ``gh issue close`` and ``gh issue reopen`` accept ``--comment`` but offer no
    ``--comment-file``, so the stdin trick the other targets use is unavailable.
    The environment still keeps the text out of the recipe, which is what stops
    a newline or a quote from ending the command early.
    """
    recipe = _target_recipe(target)

    assert f'--comment "$${variable}"' in recipe
    assert '--comment "$(comment)"' not in recipe


def test_pr_create_refuses_a_half_specified_pull_request() -> None:
    """A title without a body is rejected rather than passed to gh.

    ``gh pr create`` prompts for whatever it was not given, which hangs a
    non-interactive shell instead of failing. Supplying neither still means
    ``--fill``, which takes both from the commits.
    """
    recipe = _target_recipe("pr-create")

    assert "gh pr create --fill" in recipe
    assert '[ -z "$$PR_CREATE_TITLE" ] || [ -z "$$PR_CREATE_BODY$$PR_CREATE_BODY_FILE" ]' in recipe


@pytest.mark.parametrize(
    ("target", "interpolation"),
    [
        ("bench", '$(if $(runs),"$(runs)")'),
        ("bench-decode", '$(if $(runs),"$(runs)")'),
        ("pr-reviewers", '--add-reviewer "$(users)"'),
    ],
)
def test_scalar_arguments_reach_their_command_as_one_word(target: str, interpolation: str) -> None:
    """Counts and comma-separated lists are quoted so they stay a single argument.

    An unquoted ``$(runs)`` or ``$(users)`` is split on whitespace by the shell,
    which turns one argument into several. The ``$(if ...)`` wrapper keeps an
    unset count from becoming an empty argument.
    """
    assert interpolation in _target_recipe(target)


def test_pr_edit_routes_through_the_tested_helper() -> None:
    """Editing a PR goes through the helper subcommand rather than raw gh."""
    recipe = _target_recipe("pr-edit")

    assert "$(GH) edit-pr" in recipe
    assert "gh pr edit" not in recipe
    assert '$(if $(pr_num),--pr "$(pr_num)")' in recipe


def test_alert_issue_passes_free_text_through_the_environment() -> None:
    """The alert title and detail are workflow-authored prose, so they stay in the environment."""
    recipe = _target_recipe("ci-alert-issue")

    assert "ci-alert-issue: export ALERT_ISSUE_TITLE := $(value title)" in MAKEFILE_TEXT
    assert "ci-alert-issue: export ALERT_ISSUE_DETAIL := $(value detail)" in MAKEFILE_TEXT
    assert '--title "$$ALERT_ISSUE_TITLE"' in recipe
    assert '$(if $(detail),--detail "$$ALERT_ISSUE_DETAIL")' in recipe
    assert '$(if $(detail_file),--detail-file "$(detail_file)")' in recipe


def test_pr_watch_uses_conservative_helper_and_forwards_controls() -> None:
    """Keep PR polling in the tested helper rather than a noisy shell loop."""
    recipe = _target_recipe("pr-watch")

    assert "$(GH) watch" in recipe
    assert '$(if $(pr_num),--pr "$(pr_num)")' in recipe
    assert '$(if $(interval),--interval "$(interval)")' in recipe
    assert '$(if $(max_polls),--max-polls "$(max_polls)")' in recipe
    assert '$(if $(expected_checks),--expected-checks "$(expected_checks)")' in recipe
    assert "$(if $(filter 1,$(checks_only)),--checks-only)" in recipe
    assert "gh pr checks --watch" not in recipe


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


def test_clean_delegates_virtual_environment_removal_to_the_safety_guard() -> None:
    """Never interpolate the configurable virtual-environment path into rm."""
    recipe = _target_recipe("clean")
    venv_recipe = _target_recipe("clean-venv")

    assert "clean: clean-venv" in MAKEFILE_TEXT
    assert "-m scripts.setup.clean_venv" in venv_recipe
    assert "clean-venv: export CLEAN_REPO_ROOT := $(CURDIR)" in MAKEFILE_TEXT
    assert "clean-venv: export CLEAN_VENV := $(VENV)" in MAKEFILE_TEXT
    assert re.search(r"^clean-venv:\n\t", MAKEFILE_TEXT, re.MULTILINE)
    assert "$(VENV)" not in venv_recipe
    assert "rm -rf $(VENV)" not in recipe


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

    assert 'test -n "$(packages)"' in recipe
    assert "$(NPM) update --package-lock-only $(packages)" in recipe
