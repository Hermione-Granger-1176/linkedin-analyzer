from __future__ import annotations

import re
from pathlib import Path

import pytest
from scripts.gh import cli

MAKEFILE_TEXT = (Path(__file__).parents[3] / "Makefile").read_text(encoding="utf-8")


def _target_recipe(name: str) -> str:
    """Return the recipe lines for one Makefile target."""
    match = re.search(
        rf"^{re.escape(name)}:.*\n(?P<recipe>(?:\t.*\n)+)",
        MAKEFILE_TEXT,
        re.MULTILINE,
    )
    assert match is not None, f"missing Makefile target: {name}"
    return match.group("recipe")


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


def test_ci_cache_helper_prunes_uv() -> None:
    """Keep uv cache cleanup behind an explicit Make target."""
    prune_recipe = _target_recipe("ci-prune-uv-cache")

    assert "$(UV) cache prune --ci" in prune_recipe


def test_selected_playwright_setup_validates_engines_and_dependencies() -> None:
    """Keep selective installs constrained to supported engine names and CI dependency mode."""
    recipe = _target_recipe("setup-playwright-engines")

    assert "unsupported Playwright engine(s): $(PLAYWRIGHT_INVALID_ENGINES)" in recipe
    assert "engines must not contain duplicates" in recipe
    assert "with_deps must be one value" in recipe
    assert "with_deps must be 1 when provided" in recipe
    assert "$(if $(filter 1,$(with_deps)),--with-deps)" in recipe
    assert "$(filter $(PLAYWRIGHT_BROWSERS),$(PLAYWRIGHT_ENGINE_ARGS))" in recipe


def test_containerized_playwright_runs_through_the_pinned_image() -> None:
    """E2E and page-speed targets run through the pinned container image."""
    run = re.search(r"^PLAYWRIGHT_CONTAINER_RUN = (?P<command>.*)$", MAKEFILE_TEXT, re.MULTILINE)
    assert run is not None
    command = run.group("command")

    assert command.startswith("$(DOCKER) run --rm --init --ipc=host")
    assert '--user "$$(id -u):$$(id -g)"' in command
    assert "--env CI=true" in command
    assert '--volume "$(CURDIR):/work"' in command
    assert command.endswith("$(PLAYWRIGHT_CI_IMAGE)")
    assert _target_recipe("test-e2e-container").strip() == (
        "$(PLAYWRIGHT_CONTAINER_RUN) $(NPM) run test:e2e -- $(ARGS)"
    )
    assert (
        _target_recipe("bench-browser-container")
        .strip()
        .startswith("$(PLAYWRIGHT_CONTAINER_RUN) $(NODE) scripts/checks/browser-bench.mjs")
    )


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
    """Recipes extend PYTHONPATH through the shared PY_PATH_PREFIX.

    A bare ``PYTHONPATH=.`` would discard the developer's value.
    """
    assert "PY_PATH_PREFIX = PYTHONPATH=.$${PYTHONPATH:+:$${PYTHONPATH}}" in MAKEFILE_TEXT
    # A bare assignment with a trailing space is a recipe that dropped the value.
    assert "PYTHONPATH=. " not in MAKEFILE_TEXT


FREE_TEXT_NAMES = ("body", "title", "comment", "detail", "notes", "search")


@pytest.mark.parametrize("name", FREE_TEXT_NAMES)
def test_free_text_never_becomes_a_make_variable(name: str) -> None:
    """No target reads free text from a make variable, in any spelling.

    Text arrives on stdin, and a title through the environment. Make expands
    `$(...)` in a command-line assignment while parsing it, so such text is never
    accepted as an argument.
    """
    assert f"$({name})" not in MAKEFILE_TEXT
    assert f"$(value {name})" not in MAKEFILE_TEXT


@pytest.mark.parametrize("name", FREE_TEXT_NAMES)
def test_retired_free_text_arguments_are_refused_rather_than_ignored(name: str) -> None:
    """A stale ``body="Fixed"`` fails the run instead of being ignored.

    Make silently ignores command-line assignments that no target reads.
    """
    retired = re.search(r"^RETIRED_TEXT_ARGS :=((?:.|\\\n)*?)\n\$", MAKEFILE_TEXT, re.MULTILINE)
    assert retired is not None
    assert name in retired.group(1).split()
    assert "$(filter command line,$(origin $(v)))" in MAKEFILE_TEXT


@pytest.mark.parametrize("name", ["TITLE", "COMMENT", "SEARCH"])
def test_environment_text_is_refused_as_a_make_argument(name: str) -> None:
    """``make x TITLE=...`` is refused.

    Make expands a command-line assignment, while an environment value reaches
    the recipe unexpanded.
    """
    assert re.search(r"^FREE_TEXT_VARS :=.*\b" + name + r"\b", MAKEFILE_TEXT, re.MULTILINE)


@pytest.mark.parametrize(
    ("target", "command"),
    [
        ("pr-comment", "$(GH) comment"),
        ("pr-reply", "$(GH) reply"),
        ("pr-address", "$(GH) address"),
        ("issue-comment", "$(GH) issue-comment"),
        ("issue-create", "$(GH) issue-create"),
    ],
)
def test_posting_targets_take_the_body_from_stdin_and_nowhere_else(
    target: str, command: str
) -> None:
    """Posting targets read the body from stdin with ``--body-file -``.

    They have no branch for other input.
    """
    recipe = _target_recipe(target)

    assert f"{command}" in recipe
    assert "--body-file -" in recipe
    assert "mktemp" not in recipe
    assert "elif" not in recipe


@pytest.mark.parametrize("target", ["pr-edit", "issue-edit"])
def test_edit_targets_leave_the_body_alone_when_no_body_arrives(target: str) -> None:
    """An empty stdin means no new body, so the title can change alone."""
    recipe = _target_recipe(target)

    assert "body=$$(cat)" in recipe
    assert 'if [ -n "$$body" ]' in recipe
    assert "--body-file -" in recipe


@pytest.mark.parametrize(
    ("target", "read_command"),
    [
        ("pr-edit", "body=$$(cat)"),
        ("issue-edit", "body=$$(cat)"),
        ("release-create", 'cat > "$$tmp"'),
        ("ci-alert-issue", 'set -- "$$@" --detail-file -'),
    ],
)
def test_targets_with_optional_input_never_read_a_terminal(target: str, read_command: str) -> None:
    """Targets with optional input do not read a terminal.

    Empty stdin still means no change when input is piped.
    """
    assert "NO_TTY_READ := [ -t 0 ] ||" in MAKEFILE_TEXT
    assert f"$(NO_TTY_READ) {read_command}" in _target_recipe(target)


PATH_TARGETS = {
    "editorconfig-check": "-- $(VENV_PYTHON) -m scripts.lint.check_editorconfig",
    "lint-doc-commands": "-- $(VENV_PYTHON) -m scripts.lint.check_doc_commands",
    "lint-make-targets": "-- $(VENV_PYTHON) -m scripts.lint.check_make_targets",
    "lint-yaml": ". -- $(VENV_PYTHON) -m yamllint",
    "format-py-diff": "$(PY_PATHS) -- $(VENV_PYTHON) -m ruff format --check --diff",
    "format-js-diff": (
        '--require --name "make format-js-diff" -- '
        '$(VENV_PYTHON) -m scripts.lint.format_js_diff --npx "$(NPX)"'
    ),
    "align-tables": "-- $(VENV_PYTHON) -m scripts.lint.align_tables",
    "align-tables-check": "-- $(VENV_PYTHON) -m scripts.lint.align_tables --check",
    "stage": '--require --name "make stage" -- git add --',
}


@pytest.mark.parametrize(("target", "invocation"), PATH_TARGETS.items())
def test_path_targets_read_their_paths_from_stdin(target: str, invocation: str) -> None:
    """Every target that takes files reads them from stdin, one per line.

    A list on stdin needs no quoting rules, so a path with spaces or quotes is
    just a line. The defaults before ``--`` apply when stdin brings no paths,
    and ``--require`` makes an empty list a usage error instead.
    """
    assert _target_recipe(target).strip() == f"@$(STDIN_PATHS) {invocation}"


def test_no_recipe_reads_paths_from_a_make_variable() -> None:
    """Paths have one way in: no recipe interpolates a path variable."""
    for name in ("files", "file", "paths", "path"):
        assert f"$({name})" not in MAKEFILE_TEXT, name
        assert f"$(value {name})" not in MAKEFILE_TEXT, name


@pytest.mark.parametrize("name", ["files", "file", "paths", "path"])
def test_retired_path_arguments_are_refused_rather_than_ignored(name: str) -> None:
    """A stale ``files="a.py"`` fails the run instead of being dropped in silence."""
    retired = re.search(r"^RETIRED_PATH_ARGS :=(.*)$", MAKEFILE_TEXT, re.MULTILINE)
    assert retired is not None
    assert name in retired.group(1).split()


def test_pr_create_lets_the_title_choose_between_fill_and_an_explicit_body() -> None:
    """TITLE selects the mode. Without it, the title and body come from the commits.

    With TITLE, the body comes from stdin.
    """
    recipe = _target_recipe("pr-create")

    assert 'if [ -z "$$TITLE" ]' in recipe
    assert "$(GH) pr-create" in recipe
    assert '--title="$$TITLE" --body-file -' in recipe


@pytest.mark.parametrize(
    ("target", "template"),
    [("commit", "commit-message"), ("release-create", "release-notes")],
)
def test_buffered_targets_read_stdin_once_into_a_private_file(target: str, template: str) -> None:
    """``commit`` and ``release-create`` buffer stdin into a private file.

    The file is removed on exit.
    """
    recipe = _target_recipe(target)

    assert 'cat > "$$tmp"' in recipe
    assert f"linkedin-analyzer-{template}.XXXXXX" in recipe
    assert 'chmod 600 "$$tmp"' in recipe


def test_commit_fails_fast_when_stdin_is_a_terminal() -> None:
    """Commit without piped input fails instead of waiting for a terminal."""
    recipe = _target_recipe("commit")

    assert "if [ -t 0 ]; then" in recipe
    assert "Commit message must be provided on stdin." in recipe


def test_alert_issue_takes_its_detail_from_stdin() -> None:
    """The alert detail is read from stdin."""
    recipe = _target_recipe("ci-alert-issue")

    assert "--detail-file -" in recipe
    assert '--title "$$TITLE"' in recipe
    assert "--detail " not in recipe


@pytest.mark.parametrize(
    ("target", "interpolation"),
    [
        ("bench", '$(if $(runs),"$(runs)")'),
        ("bench-decode", '$(if $(runs),"$(runs)")'),
        ("pr-reviewers", '--users "$(users)"'),
    ],
)
def test_scalar_arguments_reach_their_command_as_one_word(target: str, interpolation: str) -> None:
    """Counts and comma-separated lists are quoted so each stays one argument.

    The ``$(if ...)`` wrapper omits an unset count.
    """
    assert interpolation in _target_recipe(target)


def test_pr_edit_routes_through_the_tested_helper() -> None:
    """Editing a PR goes through the helper subcommand rather than raw gh."""
    recipe = _target_recipe("pr-edit")

    assert "$(GH) edit-pr" in recipe
    assert '$(if $(pr_num),--pr "$(pr_num)")' in recipe


def test_pr_checks_reports_the_helper_exit_status() -> None:
    """A failing or pending check fails the target."""
    recipe = _target_recipe("pr-checks")

    assert recipe.strip() == '@$(GH) pr-checks $(if $(pr_num),--pr "$(pr_num)")'


def test_pr_watch_uses_conservative_helper_and_forwards_controls() -> None:
    """PR polling runs in the helper, not a shell loop."""
    recipe = _target_recipe("pr-watch")

    assert "$(GH) watch" in recipe
    assert '$(if $(pr_num),--pr "$(pr_num)")' in recipe
    assert '$(if $(interval),--interval "$(interval)")' in recipe
    assert '$(if $(max_polls),--max-polls "$(max_polls)")' in recipe
    assert '$(if $(expected_checks),--expected-checks "$(expected_checks)")' in recipe
    assert "$(if $(filter 1,$(request)),--request-copilot)" in recipe
    assert "$(if $(filter 1,$(checks_only)),--checks-only)" in recipe


def test_local_playwright_runtime_setup_prepares_libs_and_shares_browsers() -> None:
    """Prepare private libraries around a shared, sudo-free browser install."""
    recipe = _target_recipe("setup-playwright-local")

    prepare = "$(PLAYWRIGHT_LOCAL_RUNTIME) prepare"
    # Browsers install into Playwright's shared cache, not a repository-local path.
    assert "PLAYWRIGHT_BROWSERS_PATH" not in recipe
    assert recipe.count(prepare) == 2
    assert "$(NPX) playwright install $(PLAYWRIGHT_BROWSERS)" in recipe
    assert recipe.index(prepare) < recipe.index("playwright install") < recipe.rindex(prepare)
    assert "--with-deps" not in recipe


def test_clean_removes_the_repository_local_playwright_cache() -> None:
    """Remove the repository-local Playwright cache during make clean."""
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


GH_TARGET_COMMANDS = {
    "pr-create": "pr-create",
    "pr-list": "pr-list",
    "pr-status": "pr-status",
    "pr-checks": "pr-checks",
    "pr-diff": "pr-diff",
    "pr-checkout": "pr-checkout",
    "pr-comments": "pr-comments",
    "pr-merge": "pr-merge",
    "pr-merge-admin": "pr-merge",
    "pr-reviewers": "pr-reviewers",
    "pr-label": "pr-label",
    "pr-close": "pr-close",
    "issue-list": "issue-list",
    "issue-view": "issue-view",
    "issue-create": "issue-create",
    "issue-comment": "issue-comment",
    "issue-edit": "issue-edit",
    "issue-label": "issue-label",
    "issue-unlabel": "issue-unlabel",
    "issue-assign": "issue-assign",
    "issue-unassign": "issue-unassign",
    "issue-close": "issue-close",
    "issue-reopen": "issue-reopen",
    "issue-develop": "issue-develop",
}


def test_pr_and_issue_targets_use_the_tested_gh_helpers() -> None:
    """GitHub targets go through scripts.gh so GraphQL-blocked sandboxes can fall back to REST."""
    for target, command in GH_TARGET_COMMANDS.items():
        assert f"$(GH) {command}" in _target_recipe(target), target

    assert not re.search(r"^\t[^#\n]*\bgh (?:pr|issue)\b", MAKEFILE_TEXT, re.MULTILINE)


def test_gh_helper_commands_in_the_makefile_exist() -> None:
    """Every ``$(GH) <command>`` named in the Makefile is a registered helper subcommand."""
    used = set(re.findall(r"\$\(GH\) ([a-z][a-z-]*)", MAKEFILE_TEXT))

    assert used
    assert used <= set(cli.COMMAND_HANDLERS)


def test_thread_targets_accept_a_pr_number_for_numeric_ids() -> None:
    """Numeric thread ids need the PR, so reply, resolve, and address forward pr_num."""
    for target in ("pr-reply", "pr-resolve", "pr-address"):
        assert '$(if $(pr_num),--pr "$(pr_num)")' in _target_recipe(target), target


@pytest.mark.parametrize(
    ("target", "variable", "option"),
    [
        ("pr-create", "TITLE", "--title"),
        ("pr-edit", "TITLE", "--title"),
        ("issue-list", "SEARCH", "--search"),
        ("issue-create", "TITLE", "--title"),
        ("issue-edit", "TITLE", "--title"),
        ("issue-close", "COMMENT", "--comment"),
        ("issue-reopen", "COMMENT", "--comment"),
    ],
)
def test_free_text_reaches_the_helper_as_one_option_equals_value_word(
    target: str, variable: str, option: str
) -> None:
    """A value that starts with a dash, such as SEARCH='-label:bug', must not read as an option.

    argparse takes ``--search -label:bug`` for two options and fails, while
    ``--search=-label:bug`` is one word whose value it never inspects.
    """
    recipe = _target_recipe(target)

    assert f'{option}="$${variable}"' in recipe
    assert f'{option} "$${variable}"' not in recipe
