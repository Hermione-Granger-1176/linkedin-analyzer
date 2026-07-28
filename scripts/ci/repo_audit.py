#!/usr/bin/env python3
"""Audit the GitHub repository settings the release and review flow depends on.

Branch protection, secret scanning, and the Actions inventory are configured in
the GitHub web UI, so they are the part of this repository that no test, lint,
or review can see. They drift silently: a required check renamed out of the
protection list, or push protection switched off, changes nothing locally and
shows up only the next time it was supposed to stop something.

This audit reads those settings back and reports the drift as a list. It is run
on demand rather than from a workflow because reading branch protection needs
``administration: read`` and listing secrets needs ``secrets: read``, and
``GITHUB_TOKEN`` can grant neither. The repository's App credentials exist for
writeback and carry neither permission either, so a workflow copy of this check
would report "could not check" on every run.

The audit is deliberately fail-closed. A setting it cannot read is never
reported as correct: an unreadable response ends the run with EXIT_CHECK_FAILED
instead of an empty finding list.
"""

from __future__ import annotations

import argparse
import sys

from scripts.gh import gh_runner
from scripts.gh.gh_runner import GhError

# Exit codes, matching ``scripts.ci.schedule_watchdog`` so a caller can tell
# "the audit ran and found drift" apart from "the audit could not look". Note
# that ``make`` collapses every non-zero recipe exit to 2, so the distinction
# survives only for a caller running this module directly.
EXIT_HEALTHY = 0
EXIT_DRIFT_FOUND = 1
EXIT_CHECK_FAILED = 2

# Every check that must pass before a pull request can merge into main. The two
# CodeQL analysis jobs are listed alongside the aggregate `CI result` because
# the aggregate belongs to the CI workflow and says nothing about CodeQL.
EXPECTED_REQUIRED_CHECKS = frozenset(
    {
        "analyze-javascript",
        "analyze-python",
        "CodeQL",
        "CI result",
    }
)

# The GitHub App behind the maintenance writeback workflows. Both halves are
# audited because either one missing degrades those workflows into a skip, and
# a skip is quiet.
EXPECTED_VARIABLES = frozenset({"APP_ID"})
EXPECTED_SECRETS = frozenset({"APP_PRIVATE_KEY"})

# Secret scanning is the layer no job in this repository can provide: push
# protection refuses the push carrying a secret, rather than reporting it once
# it is already in history and the credential has to be rotated regardless.
# Dependabot security updates sit here for the same reason, being the only
# automation that opens a fix for a newly disclosed advisory without a human.
EXPECTED_SECURITY_FEATURES = frozenset(
    {
        "dependabot_security_updates",
        "secret_scanning",
        "secret_scanning_push_protection",
    }
)

# Branch protection blocks that must report ``enabled``, and how each reads as a
# finding when it does not.
REQUIRED_PROTECTION_BLOCKS = {
    "required_signatures": "does not require signed commits",
    "required_linear_history": "does not require linear history",
    "required_conversation_resolution": "does not require conversation resolution",
}

# Branch protection blocks that must report ``enabled: false``. These two are
# the ones that let history be rewritten or removed outright, which no other
# setting here can compensate for.
FORBIDDEN_PROTECTION_BLOCKS = {
    "allow_force_pushes": "allows force pushes",
    "allow_deletions": "allows branch deletion",
}

# Squash is the only merge method, which is what makes one pull request equal
# one commit on main. Leaving either of the others enabled offers a merge that
# required linear history would refuse anyway.
EXPECTED_MERGE_METHODS = {
    "allow_squash_merge": True,
    "allow_merge_commit": False,
    "allow_rebase_merge": False,
}

# What `gh api` says when a branch has no protection at all. That is drift worth
# reporting rather than a failure to look, so it is matched rather than raised.
BRANCH_UNPROTECTED_MARKERS = ("branch not protected", "404")


def _fetch_object(
    path: str,
    description: str,
    *,
    run_fn: gh_runner.RunFunction | None = None,
) -> dict[str, object]:
    """Fetch one GitHub API path and require a JSON object back."""
    payload = gh_runner.gh_json(["api", path], run_fn=run_fn)
    if not isinstance(payload, dict):
        raise GhError(f"{description} must be a JSON object.")
    return payload


def _fetch_protection(
    repo: str,
    default_branch: str,
    *,
    run_fn: gh_runner.RunFunction | None = None,
) -> dict[str, object] | None:
    """Fetch branch protection, returning None when the branch has none.

    An unprotected branch answers with a 404, which is indistinguishable from a
    missing repository at the transport level but means something very
    different: it is the single worst drift this audit can find, so it is turned
    into a finding rather than allowed to read as a failure to check.
    """
    try:
        return _fetch_object(
            f"repos/{repo}/branches/{default_branch}/protection",
            f"branch protection for {default_branch}",
            run_fn=run_fn,
        )
    except GhError as exc:
        message = str(exc).lower()
        if any(marker in message for marker in BRANCH_UNPROTECTED_MARKERS):
            return None
        raise


def collect_named_items(payload: dict[str, object], key: str) -> set[str]:
    """Collect the string ``name`` fields from a GitHub API list payload."""
    items = payload.get(key)
    if not isinstance(items, list):
        raise GhError(f"Actions {key} response must include a {key} list.")
    return {
        item["name"]
        for item in items
        if isinstance(item, dict) and isinstance(item.get("name"), str)
    }


def enabled_security_features(repository: dict[str, object]) -> set[str]:
    """Return the ``security_and_analysis`` features reported as enabled.

    The block is absent entirely for a caller without administration access,
    which reads the same as every feature being off. That is the safe direction:
    the audit reports drift rather than certifying a setting it could not see.
    """
    raw = repository.get("security_and_analysis")
    if not isinstance(raw, dict):
        return set()
    return {
        name
        for name, setting in raw.items()
        if isinstance(setting, dict) and setting.get("status") == "enabled"
    }


def extract_required_checks(protection: dict[str, object]) -> set[str]:
    """Return the required status check names from a branch protection payload.

    GitHub reports the same list twice, as plain ``contexts`` and as ``checks``
    entries pinned to an app id. Both are read so a repository configured
    through either the old or the new API surface audits the same.
    """
    required = protection.get("required_status_checks")
    if not isinstance(required, dict):
        return set()

    contexts = required.get("contexts")
    checks = required.get("checks")
    names = {value for value in contexts or [] if isinstance(value, str) and value}
    names.update(
        entry["context"]
        for entry in checks or []
        if isinstance(entry, dict) and isinstance(entry.get("context"), str) and entry["context"]
    )
    return names


def _block_enabled(protection: dict[str, object], key: str) -> bool:
    """Return whether one branch protection block reports ``enabled: true``."""
    block = protection.get(key)
    return isinstance(block, dict) and block.get("enabled") is True


def _missing(actual: set[str], expected: frozenset[str], label: str) -> list[str]:
    """Return one finding naming everything expected that is not present."""
    missing = expected - actual
    if not missing:
        return []
    return [f"missing {label}: " + ", ".join(sorted(missing))]


def audit_repository(repository: dict[str, object], *, default_branch: str) -> list[str]:
    """Audit the repository-level settings, ignoring branch protection."""
    findings = []

    actual_branch = repository.get("default_branch")
    if actual_branch != default_branch:
        findings.append(f"default branch is {actual_branch!r} instead of {default_branch!r}")

    for key, expected in sorted(EXPECTED_MERGE_METHODS.items()):
        if repository.get(key) is not expected:
            state = "enabled" if expected else "disabled"
            findings.append(f"{key} should be {state}")

    if repository.get("delete_branch_on_merge") is not True:
        findings.append("merged branches are not deleted automatically")

    findings.extend(
        _missing(
            enabled_security_features(repository),
            EXPECTED_SECURITY_FEATURES,
            "security and analysis features",
        )
    )
    return findings


def audit_protection(protection: dict[str, object] | None, *, default_branch: str) -> list[str]:
    """Audit branch protection for the default branch."""
    label = f"{default_branch} branch protection"
    if protection is None:
        return [f"{default_branch} has no branch protection at all"]

    findings = []
    missing_checks = EXPECTED_REQUIRED_CHECKS - extract_required_checks(protection)
    if missing_checks:
        findings.append(f"{label} is missing required checks: " + ", ".join(sorted(missing_checks)))

    reviews = protection.get("required_pull_request_reviews")
    approvals = None
    if isinstance(reviews, dict):
        approvals = reviews.get("required_approving_review_count")
    # bool is a subclass of int, so True would otherwise pass as a count of 1.
    if not isinstance(approvals, int) or isinstance(approvals, bool) or approvals < 1:
        findings.append(f"{label} does not require at least 1 approving review")

    for key, description in sorted(REQUIRED_PROTECTION_BLOCKS.items()):
        if not _block_enabled(protection, key):
            findings.append(f"{label} {description}")

    for key, description in sorted(FORBIDDEN_PROTECTION_BLOCKS.items()):
        if _block_enabled(protection, key):
            findings.append(f"{label} {description}")

    return findings


def audit_repo_settings(
    *,
    repo: str,
    default_branch: str = "main",
    run_fn: gh_runner.RunFunction | None = None,
) -> list[str]:
    """Return one finding per repository setting that drifted from expectations."""
    repository = _fetch_object(f"repos/{repo}", "repository metadata", run_fn=run_fn)
    protection = _fetch_protection(repo, default_branch, run_fn=run_fn)
    variables = _fetch_object(f"repos/{repo}/actions/variables", "Actions variables", run_fn=run_fn)
    secrets = _fetch_object(f"repos/{repo}/actions/secrets", "Actions secrets", run_fn=run_fn)

    findings = audit_repository(repository, default_branch=default_branch)
    findings.extend(audit_protection(protection, default_branch=default_branch))
    findings.extend(
        _missing(
            collect_named_items(variables, "variables"),
            EXPECTED_VARIABLES,
            "repository variables",
        )
    )
    findings.extend(
        _missing(collect_named_items(secrets, "secrets"), EXPECTED_SECRETS, "repository secrets")
    )
    return findings


def _build_parser() -> argparse.ArgumentParser:
    """Build the repository audit command-line parser."""
    parser = argparse.ArgumentParser(description="Audit critical GitHub repository settings")
    parser.add_argument("--repo", help="owner/name (default: current repository)")
    parser.add_argument(
        "--default-branch", default="main", help="Protected branch to audit (default: main)"
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """Audit repository settings and return one of the EXIT_* codes."""
    args = _build_parser().parse_args(argv)
    try:
        repo = args.repo or gh_runner.resolve_repo()
        findings = audit_repo_settings(repo=repo, default_branch=args.default_branch)
    except GhError as exc:
        print(f"Repository settings audit could not complete: {exc}", file=sys.stderr)
        print(
            "Reading branch protection needs 'administration: read' and listing secrets "
            "needs 'secrets: read'.",
            file=sys.stderr,
        )
        return EXIT_CHECK_FAILED

    if not findings:
        print(f"Repository settings for {repo} match expectations")
        return EXIT_HEALTHY

    print(f"Repository settings audit found drift in {repo}:")
    for finding in findings:
        print(f"- {finding}")
    return EXIT_DRIFT_FOUND


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
