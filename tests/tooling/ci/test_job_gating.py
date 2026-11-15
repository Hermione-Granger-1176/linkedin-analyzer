from __future__ import annotations

import itertools
import re
import subprocess
from collections.abc import Sequence
from pathlib import Path

import pytest
from scripts.ci.job_gating import (
    BOTH_AREAS,
    NO_AREA,
    PATH_RULES,
    PYTHON_ONLY,
    WEB_ONLY,
    GatedJob,
    GitRunner,
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


def fake_runner(stdout: str = "", returncode: int = 0) -> tuple[list[Sequence[str]], GitRunner]:
    """Return a recording git runner and the list it records commands into."""
    commands: list[Sequence[str]] = []

    def runner(command: Sequence[str]) -> subprocess.CompletedProcess[str]:
        commands.append(command)
        return subprocess.CompletedProcess(list(command), returncode, stdout, "")

    return commands, runner


def failing_runner(_command: Sequence[str]) -> subprocess.CompletedProcess[str]:
    """Stands in for a git binary that is not installed."""
    raise OSError("git not found")


CI_DOC = Path(__file__).resolve().parents[3] / "docs" / "ci.md"
DOC_TABLE_HEADING = "### Which jobs run for a change"
DOC_TABLE_AREAS = {
    "Python": PYTHON_ONLY,
    "Web": WEB_ONLY,
    "Both": BOTH_AREAS,
    "Neither": NO_AREA,
}
BACKTICKED = re.compile(r"`([^`]+)`")


def _documented_path_rules() -> dict[str, frozenset[str]]:
    """Return the classification table as `docs/ci.md` states it.

    Rows whose final cell is not an area name skip themselves, which covers the
    header, the alignment row, and the fail-open `anything else` row that names
    no pattern at all.
    """
    body = CI_DOC.read_text(encoding="utf-8").partition(DOC_TABLE_HEADING)[2]
    lines = body.splitlines()
    start = next(index for index, line in enumerate(lines) if line.startswith("|"))
    documented: dict[str, frozenset[str]] = {}
    for line in itertools.takewhile(lambda row: row.startswith("|"), lines[start:]):
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        areas = DOC_TABLE_AREAS.get(cells[-1])
        if areas is None:
            continue
        documented.update(dict.fromkeys(BACKTICKED.findall(cells[0]), areas))
    return documented


ENVIRONMENT_FOR_FULL_RUN = {
    "PYTHON_CHANGED": "true",
    "WEB_CHANGED": "true",
    "CHANGES_RESULT": "success",
    "QUICK_GATES_RESULT": "success",
    "HEAVY_CHECKS_RESULT": "success",
    "PYTHON_COMPATIBILITY_RESULT": "success",
    "NODE_COMPATIBILITY_RESULT": "success",
    "WEB_E2E_RESULT": "success",
    "WEB_BENCHMARK_RESULT": "success",
    "WEB_PAGE_SPEED_RESULT": "success",
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
    "WEB_BENCHMARK_RESULT": "skipped",
    "WEB_PAGE_SPEED_RESULT": "skipped",
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
        (".agents/skills/copilot-review-loop/SKILL.md", NO_AREA),
        (".agents/skills/copilot-review-loop/agents/openai.yaml", NO_AREA),
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


def test_the_documented_table_lists_exactly_the_rules_that_exist() -> None:
    """The table in `docs/ci.md` lists exactly the PATH_RULES entries and areas.

    Catches a rule with no row, a row with no rule, and a path moved between areas.
    """
    assert _documented_path_rules() == {rule.pattern: rule.areas for rule in PATH_RULES}


def test_classify_path_treats_shared_fixtures_as_both_areas() -> None:
    """Shared fixtures under tests/fixtures classify as both areas.

    `web/tests/integration/parity.test.js` reads them.
    """
    assert classify_path("tests/fixtures/parity-corpus.json") == BOTH_AREAS


@pytest.mark.parametrize(
    "path",
    [".github/SECURITY.md", ".github/CONTRIBUTING.md", ".github/PULL_REQUEST_TEMPLATE.md"],
)
def test_classify_path_unions_overlapping_rules(path: str) -> None:
    """A path that matches several rules gets the union of their areas.

    These paths match both `.github/` and `*.md`.
    """
    assert classify_path(path) == BOTH_AREAS


def test_classify_path_fails_open_for_an_unrecognized_path() -> None:
    """A path that no rule matches runs both areas."""
    assert classify_path("terraform/main.tf") == BOTH_AREAS


def test_classify_paths_unions_every_changed_path() -> None:
    """Combine the areas of a mixed change rather than taking only the first."""
    assert classify_paths(["README.md", "src/linkedin_analyzer/cleaner.py"]) == PYTHON_ONLY
    assert classify_paths(["src/cli.py", "web/src/app/main.js"]) == BOTH_AREAS


def test_classify_paths_of_nothing_selects_nothing() -> None:
    """An empty diff selects no area."""
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
    """Uses the two-dot range for a direct comparison of the two commits."""
    commands, runner = fake_runner("README.md\n\nsrc/cli.py\n")

    assert changed_paths("base-sha", "head-sha", runner=runner) == ["README.md", "src/cli.py"]
    assert commands == [["diff", "--name-only", "--no-renames", "base-sha..head-sha"]]


def test_changed_paths_compares_against_the_merge_base_on_request() -> None:
    """Uses the three-dot range, which compares against the merge base."""
    commands, runner = fake_runner("src/cli.py\n")

    changed_paths("base-sha", "head-sha", merge_base=True, runner=runner)

    assert commands == [["diff", "--name-only", "--no-renames", "base-sha...head-sha"]]


def test_changed_paths_reports_both_ends_of_a_rename(tmp_path: Path) -> None:
    """Lists both ends of a rename, using real git.

    With rename detection on, `--name-only` reports only the destination, which
    would classify a move from `web/` to `docs/` as Markdown only.
    """
    repository = tmp_path / "repository"
    (repository / "web" / "src").mkdir(parents=True)
    (repository / "docs").mkdir()
    module = repository / "web" / "src" / "feature.js"
    module.write_text("export const value = 1;\n" * 4, encoding="utf-8")

    def runner(command: Sequence[str]) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", "-C", str(repository), *command], capture_output=True, text=True, check=False
        )

    def git(*arguments: str) -> str:
        """Run one setup command through the same runner the assertion uses."""
        result = runner(arguments)
        assert result.returncode == 0, result.stderr
        return result.stdout.strip()

    git("init", "-q")
    git("config", "user.email", "tests@example.com")
    git("config", "user.name", "tests")
    git("add", "-A")
    git("commit", "-qm", "base")
    base = git("rev-parse", "HEAD")
    git("mv", "web/src/feature.js", "docs/feature.md")
    git("commit", "-qm", "move the module into the documentation tree")

    paths = changed_paths(base, "HEAD", runner=runner)

    assert paths is not None
    assert sorted(paths) == ["docs/feature.md", "web/src/feature.js"]
    assert classify_paths(paths) == WEB_ONLY


@pytest.mark.parametrize(
    ("base", "head"),
    [("", "head-sha"), ("base-sha", ""), ("0" * 40, "head-sha")],
)
def test_changed_paths_fails_open_without_usable_commits(base: str, head: str) -> None:
    """Returns None (fail open) when the base or head is empty, or the base is all zeros."""
    commands, runner = fake_runner("README.md\n")

    assert changed_paths(base, head, runner=runner) is None
    assert commands == []


def test_changed_paths_fails_open_when_git_cannot_run() -> None:
    """Fail open rather than crash when the git binary is unavailable."""
    assert changed_paths("base-sha", "head-sha", runner=failing_runner) is None


def test_changed_paths_fails_open_when_the_commit_is_missing() -> None:
    """Returns None (fail open) when git rejects the commit range."""
    _commands, runner = fake_runner("", returncode=128)

    assert changed_paths("base-sha", "head-sha", runner=runner) is None


def test_resolve_areas_reports_both_the_verdict_and_its_evidence() -> None:
    """Returns the verdict together with the changed paths behind it."""
    _commands, runner = fake_runner("docs/development.md\n")

    assert resolve_areas("base-sha", "head-sha", runner=runner) == (
        NO_AREA,
        ["docs/development.md"],
    )


def test_resolve_areas_runs_everything_when_the_diff_is_unknown() -> None:
    """Report both areas and no evidence when the diff could not be computed."""
    assert resolve_areas("", "", runner=failing_runner) == (BOTH_AREAS, None)


def test_run_git_invokes_the_real_binary() -> None:
    """Runs the real git binary through the default runner."""
    result = run_git(["--version"])

    assert result.returncode == 0
    assert result.stdout.startswith("git version")


def test_active_areas_reads_only_the_exact_true_flag() -> None:
    """Only the exact string 'true' sets an area."""
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


@pytest.mark.parametrize(
    ("variable", "label"),
    [
        ("CHANGES_RESULT", "Detect changes"),
        ("QUICK_GATES_RESULT", "Quick gates"),
        ("HEAVY_CHECKS_RESULT", "Heavy checks"),
        ("PYTHON_COMPATIBILITY_RESULT", "Python compatibility"),
        ("NODE_COMPATIBILITY_RESULT", "Node.js compatibility"),
        ("WEB_E2E_RESULT", "Web E2E"),
        ("WEB_BENCHMARK_RESULT", "Web benchmark"),
        ("WEB_PAGE_SPEED_RESULT", "Web page speed"),
    ],
)
def test_result_problems_rejects_a_failure_in_any_job(variable: str, label: str) -> None:
    """Fails on any job that failed while both areas changed.

    Each row is enumerated, so every job in the table is checked.
    """
    environment = {**ENVIRONMENT_FOR_FULL_RUN, variable: "failure"}

    assert result_problems(environment) == [f"{label} was 'failure', expected 'success'."]


@pytest.mark.parametrize(
    ("variable", "label"),
    [
        ("HEAVY_CHECKS_RESULT", "Heavy checks"),
        ("PYTHON_COMPATIBILITY_RESULT", "Python compatibility"),
        ("NODE_COMPATIBILITY_RESULT", "Node.js compatibility"),
        ("WEB_E2E_RESULT", "Web E2E"),
        ("WEB_BENCHMARK_RESULT", "Web benchmark"),
        ("WEB_PAGE_SPEED_RESULT", "Web page speed"),
    ],
)
def test_result_problems_rejects_any_job_that_ran_outside_its_areas(
    variable: str, label: str
) -> None:
    """Fail any gated job that ran on a change touching neither area."""
    environment = {**ENVIRONMENT_FOR_DOCS_RUN, variable: "success"}

    assert result_problems(environment) == [f"{label} was 'success', expected 'skipped'."]


def test_result_problems_rejects_a_skip_the_areas_did_not_ask_for() -> None:
    """A job that skips while its area changed fails the gate.

    This catches a mistyped `if:` condition that skips real work.
    """
    environment = {**ENVIRONMENT_FOR_FULL_RUN, "WEB_E2E_RESULT": "skipped"}

    assert result_problems(environment) == ["Web E2E was 'skipped', expected 'success'."]


def test_result_problems_rejects_a_job_that_ran_when_it_should_not_have() -> None:
    """Fail a job that ran outside its areas, so the gate cannot drift unnoticed."""
    environment = {**ENVIRONMENT_FOR_DOCS_RUN, "HEAVY_CHECKS_RESULT": "success"}

    assert result_problems(environment) == ["Heavy checks was 'success', expected 'skipped'."]


@pytest.mark.parametrize("result", ["failure", "cancelled"])
def test_result_problems_rejects_failed_and_cancelled_jobs(result: str) -> None:
    """Anything other than success fails the gate."""
    environment = {**ENVIRONMENT_FOR_FULL_RUN, "PYTHON_COMPATIBILITY_RESULT": result}

    assert result_problems(environment) == [
        f"Python compatibility was '{result}', expected 'success'."
    ]


def test_result_problems_rejects_a_failed_detection_job() -> None:
    """A failed detection job fails the gate.

    Its empty area outputs do not count as a documentation-only run.
    """
    environment = {
        "CHANGES_RESULT": "failure",
        "QUICK_GATES_RESULT": "success",
        "HEAVY_CHECKS_RESULT": "skipped",
        "PYTHON_COMPATIBILITY_RESULT": "skipped",
        "NODE_COMPATIBILITY_RESULT": "skipped",
        "WEB_E2E_RESULT": "skipped",
        "WEB_BENCHMARK_RESULT": "skipped",
        "WEB_PAGE_SPEED_RESULT": "skipped",
    }

    assert result_problems(environment) == ["Detect changes was 'failure', expected 'success'."]


def test_result_problems_reports_every_offending_job_at_once() -> None:
    """Reports every mismatch in one pass."""
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
    """Writes both flags to GITHUB_OUTPUT."""
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
    """Runs without GITHUB_OUTPUT set."""
    monkeypatch.chdir(Path(__file__).resolve().parents[3])

    exit_code = main(["changed-areas", "--base", "HEAD", "--head", "HEAD"], {})

    assert exit_code == 0
    captured = capsys.readouterr().out
    assert "Changed paths (0):" in captured
    assert "python=false" in captured


def test_report_areas_lists_the_paths_behind_the_verdict(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Prints every changed path with the verdict."""
    _report_areas(PYTHON_ONLY, ["src/cli.py", "README.md"])

    assert capsys.readouterr().out == (
        "Changed paths (2):\n  src/cli.py\n  README.md\npython=true\nweb=false\n"
    )


def test_main_check_results_passes_a_consistent_run(capsys: pytest.CaptureFixture[str]) -> None:
    """Exit zero when every job did what the detected areas asked of it."""
    assert main(["check-results"], ENVIRONMENT_FOR_DOCS_RUN) == 0
    assert "matched the areas" in capsys.readouterr().out


def test_main_check_results_annotates_each_problem(capsys: pytest.CaptureFixture[str]) -> None:
    """Exits 1 and prints an ::error:: annotation for each problem."""
    environment = {**ENVIRONMENT_FOR_FULL_RUN, "HEAVY_CHECKS_RESULT": "failure"}

    assert main(["check-results"], environment) == 1
    assert "::error::Heavy checks was 'failure', expected 'success'." in capsys.readouterr().out


def test_main_falls_back_to_the_process_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Reads os.environ when no mapping is passed."""
    for name, value in ENVIRONMENT_FOR_DOCS_RUN.items():
        monkeypatch.setenv(name, value)

    assert main(["check-results"]) == 0
