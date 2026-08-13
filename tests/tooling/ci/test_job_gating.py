from __future__ import annotations

import subprocess
from collections.abc import Sequence
from pathlib import Path

import pytest
from scripts.ci.job_gating import (
    BOTH_AREAS,
    NO_AREA,
    PYTHON_ONLY,
    WEB_ONLY,
    GatedJob,
    PathRule,
    _report_areas,
    active_areas,
    changed_paths,
    classify_path,
    classify_paths,
    main,
    resolve_areas,
    result_problems,
    run_git,
)


def fake_runner(stdout: str = "", returncode: int = 0) -> tuple[list[Sequence[str]], object]:
    """Return a recording git runner and the list it records commands into."""
    commands: list[Sequence[str]] = []

    def runner(command: Sequence[str]) -> subprocess.CompletedProcess[str]:
        commands.append(command)
        return subprocess.CompletedProcess(list(command), returncode, stdout, "")

    return commands, runner


def failing_runner(_command: Sequence[str]) -> subprocess.CompletedProcess[str]:
    """Stand in for a git binary that is missing from the runner image."""
    raise OSError("git not found")


ENVIRONMENT_FOR_FULL_RUN = {
    "PYTHON_CHANGED": "true",
    "WEB_CHANGED": "true",
    "CHANGES_RESULT": "success",
    "QUICK_GATES_RESULT": "success",
    "HEAVY_CHECKS_RESULT": "success",
    "PYTHON_COMPATIBILITY_RESULT": "success",
    "NODE_COMPATIBILITY_RESULT": "success",
    "WEB_E2E_RESULT": "success",
}

ENVIRONMENT_FOR_DOCS_RUN = {
    "PYTHON_CHANGED": "false",
    "WEB_CHANGED": "false",
    "CHANGES_RESULT": "success",
    "QUICK_GATES_RESULT": "success",
    "HEAVY_CHECKS_RESULT": "skipped",
    "PYTHON_COMPATIBILITY_RESULT": "skipped",
    "NODE_COMPATIBILITY_RESULT": "skipped",
    "WEB_E2E_RESULT": "skipped",
}


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("src/linkedin_analyzer/cleaner.py", PYTHON_ONLY),
        ("tests/package/test_cleaner.py", PYTHON_ONLY),
        ("tests/integration/test_web_parity.py", PYTHON_ONLY),
        ("tests/support/helpers.py", PYTHON_ONLY),
        ("tests/__init__.py", PYTHON_ONLY),
        ("pyproject.toml", PYTHON_ONLY),
        ("uv.lock", PYTHON_ONLY),
        ("web/src/app/main.js", WEB_ONLY),
        ("api/report.js", WEB_ONLY),
        ("config/eslint.config.mjs", WEB_ONLY),
        ("package.json", WEB_ONLY),
        ("package-lock.json", WEB_ONLY),
        ("vercel.json", WEB_ONLY),
        ("Makefile", BOTH_AREAS),
        (".github/workflows/ci.yml", BOTH_AREAS),
        ("scripts/ci/job_gating.py", BOTH_AREAS),
        ("tests/tooling/ci/test_job_gating.py", BOTH_AREAS),
        ("constraints/container-build/requirements.txt", BOTH_AREAS),
        ("Dockerfile", BOTH_AREAS),
        (".dockerignore", BOTH_AREAS),
        (".editorconfig", BOTH_AREAS),
        (".npmrc", BOTH_AREAS),
        (".pre-commit-config.yaml", BOTH_AREAS),
        (".yamllint.yml", BOTH_AREAS),
        ("README.md", NO_AREA),
        ("CHANGELOG.md", NO_AREA),
        ("docs/development.md", NO_AREA),
        ("docs/adr/001-npm-overrides.md", NO_AREA),
        ("data/input/.gitkeep", NO_AREA),
        ("LICENSE", NO_AREA),
        (".gitignore", NO_AREA),
        (".env.example", NO_AREA),
    ],
)
def test_classify_path_matches_the_documented_table(path: str, expected: frozenset[str]) -> None:
    """Classify every path class the repository actually contains."""
    assert classify_path(path) == expected


def test_classify_path_treats_shared_fixtures_as_both_areas() -> None:
    """Run both matrices for the parity corpus that the JavaScript suite reads directly.

    `web/tests/integration/parity.test.js` resolves `tests/fixtures`, so filing
    these under the Python area alone would skip Node compatibility on a change
    to JavaScript test inputs.
    """
    assert classify_path("tests/fixtures/parity-corpus.json") == BOTH_AREAS


@pytest.mark.parametrize(
    "path",
    [".github/SECURITY.md", ".github/CONTRIBUTING.md", ".github/PULL_REQUEST_TEMPLATE.md"],
)
def test_classify_path_unions_overlapping_rules(path: str) -> None:
    """Let an infrastructure rule win over the Markdown rule regardless of order.

    These paths match both `.github/` and `*.md`. Rules contribute rather than
    fall through, so the result cannot depend on which one is consulted first.
    """
    assert classify_path(path) == BOTH_AREAS


def test_classify_path_fails_open_for_an_unrecognized_path() -> None:
    """Run everything for a path no rule names, so new top-level files are covered."""
    assert classify_path("terraform/main.tf") == BOTH_AREAS


def test_classify_paths_unions_every_changed_path() -> None:
    """Combine the areas of a mixed change rather than taking only the first."""
    assert classify_paths(["README.md", "src/linkedin_analyzer/cleaner.py"]) == PYTHON_ONLY
    assert classify_paths(["src/cli.py", "web/src/app/main.js"]) == BOTH_AREAS


def test_classify_paths_of_nothing_selects_nothing() -> None:
    """Select no area for an empty diff, so a no-op push runs no heavy jobs."""
    assert classify_paths([]) == NO_AREA


def test_path_rule_matches_only_its_own_pattern_form() -> None:
    """Keep the three pattern forms from matching each other's paths."""
    directory = PathRule("web/", WEB_ONLY)
    suffix = PathRule("*.md", NO_AREA)
    exact = PathRule("Makefile", BOTH_AREAS)

    assert directory.matches("web/src/main.js")
    assert not directory.matches("webhooks/main.js")
    assert suffix.matches("docs/guide.md")
    assert not suffix.matches("guide.mdx")
    assert exact.matches("Makefile")
    assert not exact.matches("web/Makefile")


def test_changed_paths_returns_the_diff_and_drops_blank_lines() -> None:
    """Read the three-dot diff, which compares a branch against its merge base."""
    commands, runner = fake_runner("README.md\n\nsrc/cli.py\n")

    assert changed_paths("base-sha", "head-sha", runner=runner) == ["README.md", "src/cli.py"]
    assert commands == [["diff", "--name-only", "base-sha...head-sha"]]


@pytest.mark.parametrize(
    ("base", "head"),
    [("", "head-sha"), ("base-sha", ""), ("0" * 40, "head-sha")],
)
def test_changed_paths_fails_open_without_usable_commits(base: str, head: str) -> None:
    """Fail open when GitHub supplies no base, as it does on a branch's first push."""
    commands, runner = fake_runner("README.md\n")

    assert changed_paths(base, head, runner=runner) is None
    assert commands == []


def test_changed_paths_fails_open_when_git_cannot_run() -> None:
    """Fail open rather than crash when the git binary is unavailable."""
    assert changed_paths("base-sha", "head-sha", runner=failing_runner) is None


def test_changed_paths_fails_open_when_the_commit_is_missing() -> None:
    """Fail open when git rejects the range, as after a force push rewrites the base."""
    _commands, runner = fake_runner("", returncode=128)

    assert changed_paths("base-sha", "head-sha", runner=runner) is None


def test_resolve_areas_reports_both_the_verdict_and_its_evidence() -> None:
    """Return the paths behind a verdict so the job log can explain a skip."""
    _commands, runner = fake_runner("docs/development.md\n")

    assert resolve_areas("base-sha", "head-sha", runner=runner) == (
        NO_AREA,
        ["docs/development.md"],
    )


def test_resolve_areas_runs_everything_when_the_diff_is_unknown() -> None:
    """Report both areas and no evidence when the diff could not be computed."""
    assert resolve_areas("", "", runner=failing_runner) == (BOTH_AREAS, None)


def test_run_git_invokes_the_real_binary() -> None:
    """Prove the default runner reaches git, since every other test injects a fake."""
    result = run_git(["--version"])

    assert result.returncode == 0
    assert result.stdout.startswith("git version")


def test_active_areas_reads_only_the_exact_true_flag() -> None:
    """Treat anything but 'true' as unchanged, so an empty output cannot enable a job."""
    assert active_areas({"PYTHON_CHANGED": "true", "WEB_CHANGED": "false"}) == PYTHON_ONLY
    assert active_areas({"PYTHON_CHANGED": "", "WEB_CHANGED": ""}) == NO_AREA


def test_gated_job_requires_success_when_it_is_never_gated() -> None:
    """Require an ungated job to succeed no matter which areas changed."""
    job = GatedJob("Quick gates", "QUICK_GATES_RESULT", NO_AREA)

    assert job.expected_result(NO_AREA) == "success"
    assert job.expected_result(BOTH_AREAS) == "success"


def test_gated_job_expects_a_skip_only_outside_its_areas() -> None:
    """Expect success inside the job's areas and a skip outside them."""
    job = GatedJob("Web E2E", "WEB_E2E_RESULT", WEB_ONLY)

    assert job.expected_result(WEB_ONLY) == "success"
    assert job.expected_result(PYTHON_ONLY) == "skipped"


def test_result_problems_accepts_a_full_run() -> None:
    """Pass when every job ran and succeeded for a change touching both areas."""
    assert result_problems(ENVIRONMENT_FOR_FULL_RUN) == []


def test_result_problems_accepts_a_documentation_run() -> None:
    """Pass when every gated job skipped for a change that touched no code."""
    assert result_problems(ENVIRONMENT_FOR_DOCS_RUN) == []


def test_result_problems_rejects_a_skip_the_areas_did_not_ask_for() -> None:
    """Fail a job that skipped while its area changed.

    This is the failure this whole design could introduce: a mistyped `if:`
    condition skipping real work. Accepting every skip would make it invisible.
    """
    environment = {**ENVIRONMENT_FOR_FULL_RUN, "WEB_E2E_RESULT": "skipped"}

    assert result_problems(environment) == ["Web E2E was 'skipped', expected 'success'."]


def test_result_problems_rejects_a_job_that_ran_when_it_should_not_have() -> None:
    """Fail a job that ran outside its areas, so the gate cannot drift unnoticed."""
    environment = {**ENVIRONMENT_FOR_DOCS_RUN, "HEAVY_CHECKS_RESULT": "success"}

    assert result_problems(environment) == ["Heavy checks was 'success', expected 'skipped'."]


@pytest.mark.parametrize("result", ["failure", "cancelled"])
def test_result_problems_rejects_failed_and_cancelled_jobs(result: str) -> None:
    """Keep the original behavior: anything that is not a clean pass fails the gate."""
    environment = {**ENVIRONMENT_FOR_FULL_RUN, "PYTHON_COMPATIBILITY_RESULT": result}

    assert result_problems(environment) == [
        f"Python compatibility was '{result}', expected 'success'."
    ]


def test_result_problems_rejects_a_failed_detection_job() -> None:
    """Fail closed when detection failed, since its empty outputs read as 'nothing changed'.

    Without this the area flags arrive empty, every gated job skips, and the
    aggregate would otherwise call that a clean documentation-only run.
    """
    environment = {
        "CHANGES_RESULT": "failure",
        "QUICK_GATES_RESULT": "success",
        "HEAVY_CHECKS_RESULT": "skipped",
        "PYTHON_COMPATIBILITY_RESULT": "skipped",
        "NODE_COMPATIBILITY_RESULT": "skipped",
        "WEB_E2E_RESULT": "skipped",
    }

    assert result_problems(environment) == ["Detect changes was 'failure', expected 'success'."]


def test_result_problems_reports_every_offending_job_at_once() -> None:
    """List all mismatches, so one rerun shows the whole picture."""
    environment = {
        **ENVIRONMENT_FOR_FULL_RUN,
        "QUICK_GATES_RESULT": "failure",
        "WEB_E2E_RESULT": "failure",
    }

    assert result_problems(environment) == [
        "Quick gates was 'failure', expected 'success'.",
        "Web E2E was 'failure', expected 'success'.",
    ]


def test_main_changed_areas_writes_the_flags_as_job_outputs(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Publish both flags where a workflow condition can read them."""
    output = tmp_path / "github-output"

    exit_code = main(
        ["changed-areas", "--base", "", "--head", ""],
        {"GITHUB_OUTPUT": str(output)},
    )

    assert exit_code == 0
    assert output.read_text(encoding="utf-8") == "python=true\nweb=true\n"
    assert "Could not determine the changed paths" in capsys.readouterr().out


def test_main_changed_areas_runs_without_github_output(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Stay usable from a terminal, where there is no job output file to append to."""
    monkeypatch.chdir(Path(__file__).resolve().parents[3])

    exit_code = main(["changed-areas", "--base", "HEAD", "--head", "HEAD"], {})

    assert exit_code == 0
    captured = capsys.readouterr().out
    assert "Changed paths (0):" in captured
    assert "python=false" in captured


def test_report_areas_lists_the_paths_behind_the_verdict(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Print every changed path, so a surprising skip can be traced from the job log."""
    _report_areas(PYTHON_ONLY, ["src/cli.py", "README.md"])

    assert capsys.readouterr().out == (
        "Changed paths (2):\n  src/cli.py\n  README.md\npython=true\nweb=false\n"
    )


def test_main_check_results_passes_a_consistent_run(capsys: pytest.CaptureFixture[str]) -> None:
    """Exit zero when every job did what the detected areas asked of it."""
    assert main(["check-results"], ENVIRONMENT_FOR_DOCS_RUN) == 0
    assert "matched the areas" in capsys.readouterr().out


def test_main_check_results_annotates_each_problem(capsys: pytest.CaptureFixture[str]) -> None:
    """Exit non-zero and annotate the run, so the failure is visible on the job page."""
    environment = {**ENVIRONMENT_FOR_FULL_RUN, "HEAVY_CHECKS_RESULT": "failure"}

    assert main(["check-results"], environment) == 1
    assert "::error::Heavy checks was 'failure', expected 'success'." in capsys.readouterr().out


def test_main_falls_back_to_the_process_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Read the real environment when no mapping is injected, which is how CI calls it."""
    for name, value in ENVIRONMENT_FOR_DOCS_RUN.items():
        monkeypatch.setenv(name, value)

    assert main(["check-results"]) == 0
