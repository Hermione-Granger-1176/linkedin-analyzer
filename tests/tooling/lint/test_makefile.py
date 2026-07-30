from __future__ import annotations

import re
from pathlib import Path

import pytest

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


FREE_TEXT_NAMES = ("body", "title", "comment", "detail", "notes", "search")


@pytest.mark.parametrize("name", FREE_TEXT_NAMES)
def test_free_text_never_becomes_a_make_variable(name: str) -> None:
    """No target reads free text from make, in any spelling.

    A body reaches its target on standard input and a title through the
    environment, so make's parser never sees either. That closes three bugs at
    once rather than policing them:

    * ``--body "$(body)"`` makes the text shell source, where a newline ends the
      line mid-quote, a ``"`` closes it, and backticks are evaluated.
    * ``:= $(body)`` expands make syntax inside the text, so a body mentioning
      ``$(x)`` silently loses it. ``$(value ...)`` fixed that but not the next one.
    * make expands a command-line assignment *while parsing it*, so ``$(shell
      ...)`` in a ``body=`` ran before any target could protect it. Nothing
      inside the Makefile could prevent that; not accepting the argument can.
    """
    assert f"$({name})" not in MAKEFILE_TEXT
    assert f"$(value {name})" not in MAKEFILE_TEXT


@pytest.mark.parametrize("name", FREE_TEXT_NAMES)
def test_retired_free_text_arguments_are_refused_rather_than_ignored(name: str) -> None:
    """A stale ``body="Fixed"`` fails the run instead of vanishing.

    Make silently ignores a command-line assignment no target reads, so without
    this the old spelling would drop the text and the target would go on to read
    an empty body from stdin: a comment posted blank, or a PR body cleared.
    """
    retired = re.search(r"^RETIRED_TEXT_ARGS :=((?:.|\\\n)*?)\n\$", MAKEFILE_TEXT, re.MULTILINE)
    assert retired is not None
    assert name in retired.group(1).split()
    assert "$(filter command line,$(origin $(v)))" in MAKEFILE_TEXT


@pytest.mark.parametrize("name", ["TITLE", "COMMENT", "SEARCH"])
def test_environment_text_is_refused_as_a_make_argument(name: str) -> None:
    """``make x TITLE=...`` is rejected, because make would expand it.

    Measured on a scratch Makefile: ``TITLE='$(shell touch X)' make demo`` hands
    the recipe those characters untouched, while ``make demo TITLE='$(shell
    touch X)'`` runs the command and passes on what is left. Both spellings
    reach the recipe and they differ only in where the assignment sits, so the
    unsafe one cannot be left to be noticed in review.
    """
    assert re.search(r"^FREE_TEXT_VARS :=.*\b" + name + r"\b", MAKEFILE_TEXT, re.MULTILINE)


@pytest.mark.parametrize(
    ("target", "command"),
    [
        ("pr-comment", "$(GH) comment"),
        ("pr-reply", "$(GH) reply"),
        ("pr-address", "$(GH) address"),
        ("issue-comment", "gh issue comment"),
        ("issue-create", "gh issue create"),
    ],
)
def test_posting_targets_take_the_body_from_stdin_and_nowhere_else(
    target: str, command: str
) -> None:
    """One input, so no target branches on how the text arrived.

    ``--body-file -`` hands the stream straight to the helper: no length limit,
    no argv escaping, no temporary file to chmod and trap, and nothing for the
    caller to quote. These recipes are the single command they look like.
    """
    recipe = _target_recipe(target)

    assert f"{command}" in recipe
    assert "--body-file -" in recipe
    assert "mktemp" not in recipe
    assert "elif" not in recipe


@pytest.mark.parametrize("target", ["pr-edit", "issue-edit"])
def test_edit_targets_leave_the_body_alone_when_no_body_arrives(target: str) -> None:
    """Editing a title must not clear the body as a side effect.

    Changing a title and replacing a body are separate intents, so an empty
    stream means "no new body" and ``TITLE='...' make pr-edit`` edits the title
    alone. The branch left here is on what to change, never on how the text
    arrived.
    """
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
    """A target whose input is optional must not sit waiting for a terminal.

    Reading a terminal is right where the text is required: the target waits for
    what you are about to type, the way ``cat`` does. Where absence means
    something instead -- keep the body, generate the notes, no detail -- an
    unguarded read makes ``TITLE='...' make pr-edit`` hang until EOF on a body
    nobody meant to supply. Empty-means-no-change still covers the piped case,
    so the terminal test only removes the wait.
    """
    assert "NO_TTY_READ := [ -t 0 ] ||" in MAKEFILE_TEXT
    assert f"$(NO_TTY_READ) {read_command}" in _target_recipe(target)


def test_format_js_diff_fails_on_a_real_error_but_not_on_a_difference() -> None:
    """Showing a diff must not turn a broken run into a passing one.

    ``diff`` exits 1 whenever the files differ, which is this target's whole
    purpose, so that status alone is tolerated. A blanket ``|| true`` would also
    swallow exit 2 and above, and running Prettier through a pipe would discard
    its status entirely, so a Prettier crash would look like "no changes".
    """
    recipe = _target_recipe("format-js-diff")

    assert "|| true" not in recipe
    assert "test $$? -eq 1" in recipe
    assert '> "$$formatted"' in recipe
    assert "trap 'rm -f -- \"$$formatted\"' EXIT" in recipe


@pytest.mark.parametrize("target", ["issue-close", "issue-reopen"])
def test_issue_state_changes_pass_their_comment_through_the_environment(target: str) -> None:
    """Closing and reopening carry their comment in the environment.

    ``gh issue close`` and ``gh issue reopen`` accept ``--comment`` and offer no
    ``--comment-file``, so there is no stream to point at and stdin cannot serve
    them. The environment still keeps the text out of the recipe, which is what
    stops a newline or a quote from ending the command early.
    """
    recipe = _target_recipe(target)

    assert '--comment "$$COMMENT"' in recipe
    assert '--comment "$(comment)"' not in recipe


def test_pr_create_lets_the_title_choose_between_fill_and_an_explicit_body() -> None:
    """One variable selects the mode, so gh is never left half-specified.

    ``gh pr create`` prompts for whatever it was not given, which hangs a
    non-interactive shell instead of failing. Keying the choice to ``TITLE``
    removes that state: without it ``--fill`` takes the title and body from the
    commits, and with it the body comes from stdin.
    """
    recipe = _target_recipe("pr-create")

    assert 'if [ -z "$$TITLE" ]' in recipe
    assert "gh pr create --fill" in recipe
    assert '--title "$$TITLE" --body-file -' in recipe


@pytest.mark.parametrize(
    ("target", "template"),
    [("commit", "commit-message"), ("release-create", "release-notes")],
)
def test_buffered_targets_read_stdin_once_into_a_private_file(target: str, template: str) -> None:
    """The two targets that must inspect their input still take only stdin.

    ``commit`` screens the message before git sees it and ``release-create`` has
    to know whether notes were supplied at all, so both need the text on disk.
    They read it from the same single input as everything else, and the file is
    private and removed on exit.
    """
    recipe = _target_recipe(target)

    assert 'cat > "$$tmp"' in recipe
    assert f"linkedin-analyzer-{template}.XXXXXX" in recipe
    assert 'chmod 600 "$$tmp"' in recipe


def test_alert_issue_takes_its_detail_from_stdin() -> None:
    """A failing workflow's output never has to survive a make command line."""
    recipe = _target_recipe("ci-alert-issue")

    assert "--detail-file -" in recipe
    assert '--title "$$TITLE"' in recipe
    assert "--detail " not in recipe


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
