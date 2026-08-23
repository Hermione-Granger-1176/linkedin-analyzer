#!/usr/bin/env python3
"""Decide which CI jobs a change needs, then check that exactly those jobs ran.

A documentation edit cannot break a Playwright run, but it used to pay for one
anyway. ``changed-areas`` classifies the paths in a diff into the two areas the
workflow matrix is organized around, ``python`` and ``web``, and the workflow
gates its jobs on the result.

The gate has to be skipped in the right way. A workflow filtered out by
``on: paths:`` never reports its checks at all, so a required check sits pending
and the pull request can never merge; a job skipped by an ``if:`` condition
reports a ``skipped`` conclusion that branch protection accepts. That is why the
filtering lives here, in job conditions, rather than in the workflow trigger.

Two properties make this safe to trust.

Unrecognized paths fail open. A path that matches no rule below, a diff that
cannot be computed, and an absent base commit all resolve to both areas and a
full matrix. A new top-level directory is therefore covered the day it lands,
and someone has to deliberately add a rule to make a path cheap.

``check-results`` refuses to accept a skip it did not ask for. Treating every
``skipped`` job as a pass would turn a mistyped ``if:`` condition into a silently
green required check, which is the one failure this whole design could introduce.
Each job is checked against what the areas say it should have done, so a job that
skipped while its area changed fails the run exactly like a job that failed.
"""

from __future__ import annotations

import argparse
import os
import subprocess
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

# A runner takes the git command vector and returns the completed process.
# Injectable so tests never touch a real repository.
GitRunner = Callable[[Sequence[str]], "subprocess.CompletedProcess[str]"]

PYTHON_AREA = "python"
WEB_AREA = "web"

AREAS = (PYTHON_AREA, WEB_AREA)

PYTHON_ONLY = frozenset({PYTHON_AREA})
WEB_ONLY = frozenset({WEB_AREA})
BOTH_AREAS = frozenset(AREAS)
NO_AREA: frozenset[str] = frozenset()

GITHUB_OUTPUT_ENV = "GITHUB_OUTPUT"

TRUE = "true"
FALSE = "false"


def run_git(command: Sequence[str]) -> subprocess.CompletedProcess[str]:
    """Run one git command without a shell and capture its output."""
    return subprocess.run(["git", *command], capture_output=True, text=True, check=False)


@dataclass(frozen=True)
class PathRule:
    """One path pattern and the areas a file matching it belongs to.

    A pattern ending in ``/`` matches a directory and everything under it, a
    pattern starting with ``*`` matches a suffix, and anything else matches one
    exact path.
    """

    pattern: str
    areas: frozenset[str]

    def matches(self, path: str) -> bool:
        """Report whether a repository-relative path matches this rule."""
        if self.pattern.endswith("/"):
            return path.startswith(self.pattern)
        if self.pattern.startswith("*"):
            return path.endswith(self.pattern[1:])
        return path == self.pattern


# Every rule that matches a path contributes, and the union of their areas
# decides. Order carries no meaning: `.github/SECURITY.md` matches both the
# `.github/` rule and the `*.md` rule, and taking the union makes it
# infrastructure without anyone having to reason about which rule wins.
PATH_RULES: tuple[PathRule, ...] = (
    # The published package and the suites that exercise it.
    PathRule("src/", PYTHON_ONLY),
    PathRule("tests/package/", PYTHON_ONLY),
    PathRule("tests/integration/", PYTHON_ONLY),
    PathRule("tests/support/", PYTHON_ONLY),
    PathRule("tests/__init__.py", PYTHON_ONLY),
    PathRule("pyproject.toml", PYTHON_ONLY),
    PathRule("uv.lock", PYTHON_ONLY),
    # The web app, its Vercel functions, and the shared JavaScript tool
    # configuration that decides what gets linted, typed, and bundled.
    PathRule("web/", WEB_ONLY),
    PathRule("api/", WEB_ONLY),
    PathRule("config/", WEB_ONLY),
    PathRule("package.json", WEB_ONLY),
    PathRule("package-lock.json", WEB_ONLY),
    PathRule("vercel.json", WEB_ONLY),
    # Shared infrastructure. Anything here can change how either runtime is
    # built, linted, or tested, so it runs the whole matrix. `tests/fixtures/`
    # belongs with them rather than with the Python suites: it holds the
    # cross-runtime parity corpus that `web/tests/integration/parity.test.js`
    # reads directly, so a fixture-only change alters JavaScript test inputs.
    PathRule("Makefile", BOTH_AREAS),
    PathRule(".github/", BOTH_AREAS),
    PathRule("scripts/", BOTH_AREAS),
    PathRule("tests/tooling/", BOTH_AREAS),
    PathRule("tests/fixtures/", BOTH_AREAS),
    PathRule("constraints/", BOTH_AREAS),
    PathRule("Dockerfile", BOTH_AREAS),
    PathRule(".dockerignore", BOTH_AREAS),
    PathRule(".editorconfig", BOTH_AREAS),
    PathRule(".npmrc", BOTH_AREAS),
    PathRule(".pre-commit-config.yaml", BOTH_AREAS),
    PathRule(".yamllint.yml", BOTH_AREAS),
    # Prose, agent skills, and local scratch space. These rules exist to
    # recognize the path, not to select anything: contributing no area is what
    # makes a non-runtime change cheap, and matching at all is what keeps it out
    # of the fail-open default. Markdown, YAML, and formatting checks still run
    # either way, because the quick-gates job is never gated.
    PathRule(".agents/skills/", NO_AREA),
    PathRule("*.md", NO_AREA),
    PathRule("docs/", NO_AREA),
    PathRule("data/", NO_AREA),
    PathRule("LICENSE", NO_AREA),
    PathRule(".gitignore", NO_AREA),
    PathRule(".env.example", NO_AREA),
)


@dataclass(frozen=True)
class GatedJob:
    """One CI job, the variable carrying its result, and the areas that require it.

    An empty ``required_areas`` marks a job that is never gated and must always
    succeed.
    """

    name: str
    variable: str
    required_areas: frozenset[str]

    def expected_result(self, active: frozenset[str]) -> str:
        """Return the only job result acceptable for these changed areas."""
        if not self.required_areas or self.required_areas & active:
            return "success"
        return "skipped"


# Mirrors the job graph in .github/workflows/ci.yml. `changes` and `quick-gates`
# are ungated and must succeed outright: a detection job that failed leaves every
# area flag empty, which would otherwise read as "nothing changed, so every skip
# is fine" and turn a broken run green.
GATED_JOBS: tuple[GatedJob, ...] = (
    GatedJob("Detect changes", "CHANGES_RESULT", NO_AREA),
    GatedJob("Quick gates", "QUICK_GATES_RESULT", NO_AREA),
    GatedJob("Heavy checks", "HEAVY_CHECKS_RESULT", BOTH_AREAS),
    GatedJob("Python compatibility", "PYTHON_COMPATIBILITY_RESULT", PYTHON_ONLY),
    GatedJob("Node.js compatibility", "NODE_COMPATIBILITY_RESULT", WEB_ONLY),
    GatedJob("Web E2E", "WEB_E2E_RESULT", WEB_ONLY),
)

AREA_VARIABLES = {PYTHON_AREA: "PYTHON_CHANGED", WEB_AREA: "WEB_CHANGED"}


def classify_path(path: str) -> frozenset[str]:
    """Return the areas one changed path belongs to, defaulting to all of them."""
    matched = [rule.areas for rule in PATH_RULES if rule.matches(path)]
    if not matched:
        return BOTH_AREAS
    return frozenset().union(*matched)


def classify_paths(paths: Iterable[str]) -> frozenset[str]:
    """Return the union of the areas every changed path belongs to."""
    areas: frozenset[str] = NO_AREA
    for path in paths:
        areas |= classify_path(path)
    return areas


def changed_paths(
    base: str, head: str, *, merge_base: bool = False, runner: GitRunner = run_git
) -> list[str] | None:
    """Return the paths differing between two commits, or ``None`` when unknown.

    ``--no-renames`` is load-bearing rather than cosmetic. With rename detection
    on, ``--name-only`` reports a rename as its destination alone, so moving
    ``web/src/feature.js`` to ``docs/feature.md`` would list only the Markdown
    path, report ``web=false``, and skip the very jobs the now-deleted module
    breaks. Disabling detection reports a rename as a delete and an add, which
    puts both areas back in the answer.

    ``merge_base`` picks the comparison to match the event. A pull request wants
    the three-dot range, everything on the branch since it diverged, because its
    base moves on without it. A push wants the two-dot range, what those commits
    actually did, which also stays correct if a non-fast-forward push ever makes
    the previous tip something other than an ancestor.

    ``None`` is the fail-open signal. It covers a base GitHub could not supply
    (creating a branch sends an all-zero SHA), a commit missing from a shallow or
    rewritten history, and a ``git`` that could not run at all.
    """
    if not base or not head or set(base) == {"0"}:
        return None
    separator = "..." if merge_base else ".."
    try:
        result = runner(["diff", "--name-only", "--no-renames", f"{base}{separator}{head}"])
    except OSError:
        return None
    if result.returncode != 0:
        return None
    return [line for line in result.stdout.splitlines() if line]


def resolve_areas(
    base: str, head: str, *, merge_base: bool = False, runner: GitRunner = run_git
) -> tuple[frozenset[str], list[str] | None]:
    """Return the areas a diff touches, with the paths behind the verdict for the log."""
    paths = changed_paths(base, head, merge_base=merge_base, runner=runner)
    if paths is None:
        return BOTH_AREAS, None
    return classify_paths(paths), paths


def _area_flags(areas: frozenset[str]) -> list[str]:
    """Render the verdict as the ``area=value`` lines a workflow condition compares against.

    The job log and the job outputs are produced from this one list rather than
    formatted separately, so what the log says the detector decided is by
    construction what the ``if:`` conditions downstream actually read.
    """
    return [f"{area}={TRUE if area in areas else FALSE}" for area in AREAS]


def _report_areas(areas: frozenset[str], paths: list[str] | None) -> None:
    """Explain the verdict in the job log, so a surprising skip is traceable."""
    if paths is None:
        print("Could not determine the changed paths; running every area.")
    else:
        print(f"Changed paths ({len(paths)}):")
        for path in paths:
            print(f"  {path}")
    for line in _area_flags(areas):
        print(line)


def _write_github_output(areas: frozenset[str], env: Mapping[str, str]) -> None:
    """Publish the area flags as job outputs when running inside GitHub Actions."""
    output_path = env.get(GITHUB_OUTPUT_ENV)
    if not output_path:
        return
    with Path(output_path).open("a", encoding="utf-8") as handle:
        handle.writelines(f"{line}\n" for line in _area_flags(areas))


def active_areas(env: Mapping[str, str]) -> frozenset[str]:
    """Return the areas the detection job reported as changed."""
    return frozenset(area for area, variable in AREA_VARIABLES.items() if env.get(variable) == TRUE)


def result_problems(env: Mapping[str, str]) -> list[str]:
    """Return one message per job whose result does not match what the areas required."""
    active = active_areas(env)
    problems = []
    for job in GATED_JOBS:
        actual = env.get(job.variable, "")
        expected = job.expected_result(active)
        if actual != expected:
            problems.append(f"{job.name} was '{actual}', expected '{expected}'.")
    return problems


def _handle_changed_areas(args: argparse.Namespace, env: Mapping[str, str]) -> int:
    """Classify a diff into CI areas and publish the result."""
    areas, paths = resolve_areas(args.base, args.head, merge_base=args.merge_base)
    _report_areas(areas, paths)
    _write_github_output(areas, env)
    return 0


def _handle_check_results(_args: argparse.Namespace, env: Mapping[str, str]) -> int:
    """Check every CI job result against the areas the change touched."""
    problems = result_problems(env)
    if not problems:
        print("Every CI job matched the areas this change touched.")
        return 0
    for problem in problems:
        print(f"::error::{problem}")
    return 1


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="CI job gating commands")
    subparsers = parser.add_subparsers(dest="command", required=True)

    areas_parser = subparsers.add_parser(
        "changed-areas", help="Report which CI areas a diff touches"
    )
    areas_parser.add_argument("--base", default="")
    areas_parser.add_argument("--head", default="")
    areas_parser.add_argument(
        "--merge-base",
        action="store_true",
        help="Compare against the merge base, as a pull request needs",
    )

    subparsers.add_parser("check-results", help="Check CI job results against changed areas")

    return parser


COMMAND_HANDLERS: dict[str, Callable[[argparse.Namespace, Mapping[str, str]], int]] = {
    "changed-areas": _handle_changed_areas,
    "check-results": _handle_check_results,
}


def main(argv: Sequence[str] | None = None, env: Mapping[str, str] | None = None) -> int:
    """Run a CI job gating command."""
    args = _build_parser().parse_args(argv)
    handler = COMMAND_HANDLERS[args.command]
    return handler(args, os.environ if env is None else env)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
