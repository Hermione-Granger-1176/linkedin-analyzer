#!/usr/bin/env python3
"""Audit the GitHub repository settings the release and review flow depends on.

Branch protection, Actions policy, environment protection, release tag rules,
and secret scanning are configured in the GitHub web UI, so they are the part
of this repository that no test, lint, or review can see. They drift silently:
a required check renamed out of the protection list, or push protection
switched off, changes nothing locally and shows up only the next time it was
supposed to stop something.

This audit reads those settings back and reports the drift as a list. Reading
branch protection, Actions policy, environment protection, and rulesets needs
``administration: read`` and listing secrets needs ``secrets: read``, and
``GITHUB_TOKEN`` can grant neither. Neither writeback App carries them either,
deliberately, so ``audit-repo-settings.yml`` runs this on a third read-only App
instead. It stays runnable by hand against a maintainer's own credentials,
which is the faster way to check a setting you just changed.

The audit is deliberately fail-closed. A setting it cannot read is never
reported as correct: an unreadable response ends the run with EXIT_CHECK_FAILED
instead of an empty finding list.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import TYPE_CHECKING

from scripts.gh import gh_runner
from scripts.gh.gh_runner import GhError

if TYPE_CHECKING:
    from collections.abc import Mapping

# Exit codes, matching ``scripts.ci.schedule_watchdog`` so a caller can tell
# "the audit ran and found drift" apart from "the audit could not look". Note
# that ``make`` collapses every non-zero recipe exit to 2, so the distinction
# survives only for a caller running this module directly.
EXIT_HEALTHY = 0
EXIT_DRIFT_FOUND = 1
EXIT_CHECK_FAILED = 2

GITHUB_OUTPUT_ENV = "GITHUB_OUTPUT"
CHECKED_OUTPUT = "checked"

# Every check that must pass before a pull request can merge into main. The
# `CI result` aggregate already covers every job inside the CI workflow, so
# naming those individually would only break protection the day one is renamed.
# What it cannot speak for is named here instead: the two CodeQL analysis jobs,
# the code-scanning service's own `CodeQL` alert gate, and the dependency
# review, each of which lives in a workflow of its own.
EXPECTED_REQUIRED_CHECKS = frozenset(
    {
        "analyze-javascript",
        "analyze-python",
        "CodeQL",
        "CI result",
        "dependency-review",
    }
)

# The three GitHub Apps: the primary app that commits, the escalation app that
# opens the CI pin refresh pull request, and the audit app that runs this check
# on a schedule. All six values are audited because any one missing degrades a
# workflow into a skip, and a skip is quiet. The audit app's own pair is here
# too, so this check cannot go silently unrun.
EXPECTED_VARIABLES = frozenset({"APP_ID", "ESCALATION_APP_ID", "AUDIT_APP_ID"})
EXPECTED_SECRETS = frozenset(
    {"APP_PRIVATE_KEY", "ESCALATION_APP_PRIVATE_KEY", "AUDIT_APP_PRIVATE_KEY"}
)

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

EXPECTED_ACTIONS_ALLOWED = "selected"
EXPECTED_ACTIONS_SHA_PINNING = True
EXPECTED_GITHUB_OWNED_ACTIONS = True
EXPECTED_VERIFIED_ACTIONS = False
EXPECTED_ACTION_PATTERNS = frozenset(
    {
        "aquasecurity/trivy-action@*",
        "astral-sh/setup-uv@*",
        "docker/build-push-action@*",
        "docker/login-action@*",
        "docker/setup-buildx-action@*",
        "docker/setup-qemu-action@*",
        "pypa/gh-action-pypi-publish@*",
    }
)

PYPI_ENVIRONMENT_NAME = "pypi"
EXPECTED_PYPI_REVIEWERS = frozenset({"Hermione-Granger-1176"})
EXPECTED_PYPI_CAN_ADMINS_BYPASS = True
EXPECTED_PYPI_PREVENT_SELF_REVIEW = False

RELEASE_TAG_RULESET_NAME = "Protect version tags"
EXPECTED_RELEASE_TAG_RULESET_TARGET = "tag"
EXPECTED_RELEASE_TAG_RULESET_ENFORCEMENT = "active"
EXPECTED_RELEASE_TAG_PATTERNS = frozenset({"refs/tags/v*"})
EXPECTED_RELEASE_TAG_RULES = frozenset({"creation", "deletion", "non_fast_forward"})

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

# Every repository field this audit judges by value. Presence is checked before
# any of them is compared, because an omitted field and a `false` one are the
# same thing to `dict.get` and only one of them is drift.
#
# The merge methods and `delete_branch_on_merge` are deliberately absent. GitHub
# returns those only to a token carrying push access, which is an access level
# rather than a grantable permission, so the read-only audit App sees `null` for
# every one of them and no permission change can alter that. Auditing them would
# mean giving the App write access to read four booleans. Required linear
# history on the default branch already refuses merge and rebase commits, and
# the audit does check that.
JUDGED_REPOSITORY_FIELDS = frozenset({"default_branch"})

# What `gh api` says when a branch exists but carries no protection, as opposed
# to "Branch not found" for one that does not exist. Both are HTTP 404, so the
# status alone cannot separate them and only this phrase can: a mistyped
# `branch=` must fail closed rather than be reported as removed protection.
BRANCH_UNPROTECTED_MARKER = "branch not protected"


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


def _fetch_list(
    path: str,
    description: str,
    *,
    run_fn: gh_runner.RunFunction | None = None,
) -> list[object]:
    """Fetch one GitHub API path and require a JSON array back."""
    payload = gh_runner.gh_json(["api", path], run_fn=run_fn)
    if not isinstance(payload, list):
        raise GhError(f"{description} must be a JSON array.")
    return payload


def _fetch_protection(
    repo: str,
    default_branch: str,
    *,
    run_fn: gh_runner.RunFunction | None = None,
) -> dict[str, object] | None:
    """Fetch branch protection, returning None when the branch has none.

    A branch that exists but is unprotected answers with a 404, and so does a
    branch that does not exist at all. Only the first is drift, and it is the
    single worst drift this audit can find, so it becomes a finding. The second
    means the audit was pointed somewhere wrong and must fail closed. GitHub
    separates them by message and not by status, so the message is what is
    matched, and anything else propagates.
    """
    try:
        return _fetch_object(
            f"repos/{repo}/branches/{default_branch}/protection",
            f"branch protection for {default_branch}",
            run_fn=run_fn,
        )
    except GhError as exc:
        if BRANCH_UNPROTECTED_MARKER in str(exc).lower():
            return None
        raise


def _fetch_ruleset_details(
    repo: str,
    *,
    run_fn: gh_runner.RunFunction | None = None,
) -> list[dict[str, object]]:
    """Fetch every repository ruleset detail after reading its summary list."""
    summaries = _fetch_list(f"repos/{repo}/rulesets", "Repository rulesets response", run_fn=run_fn)
    details: list[dict[str, object]] = []
    for summary in summaries:
        if not isinstance(summary, dict):
            raise GhError("Repository rulesets response contains a non-object entry.")
        ruleset_id = summary.get("id")
        if not isinstance(ruleset_id, int) or isinstance(ruleset_id, bool):
            raise GhError("Repository rulesets response contains an entry without a numeric id.")
        details.append(
            _fetch_object(
                f"repos/{repo}/rulesets/{ruleset_id}",
                f"repository ruleset {ruleset_id}",
                run_fn=run_fn,
            )
        )
    return details


def collect_named_items(payload: dict[str, object], key: str) -> set[str]:
    """Collect the string ``name`` fields from a GitHub API list payload."""
    items = payload.get(key)
    if not isinstance(items, list):
        raise GhError(f"Actions {key} response must include a {key} list.")
    names: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            raise GhError(f"Actions {key} response contains a non-object entry.")
        name = item.get("name")
        if not isinstance(name, str) or not name:
            raise GhError(f"Actions {key} response contains an entry without a name.")
        names.add(name)
    return names


def _unexpected(actual: set[str], expected: frozenset[str], label: str) -> list[str]:
    """Return one finding naming everything present that was not expected."""
    unexpected = actual - expected
    if not unexpected:
        return []
    return [f"unexpected {label}: " + ", ".join(sorted(unexpected))]


def extract_allowed_action_patterns(payload: object) -> set[str]:
    """Return the non-GitHub Actions patterns from a selected-actions response."""
    if not isinstance(payload, dict):
        raise GhError("Selected Actions response must be a JSON object.")
    raw_patterns = payload.get("patterns_allowed")
    if not isinstance(raw_patterns, list):
        raise GhError("Selected Actions patterns_allowed must be a JSON array.")
    patterns: set[str] = set()
    for pattern in raw_patterns:
        if not isinstance(pattern, str) or not pattern:
            raise GhError("Selected Actions patterns_allowed must contain non-empty strings.")
        patterns.add(pattern)
    return patterns


def extract_environment_reviewers(payload: object) -> tuple[set[str], bool | None]:
    """Return required reviewer logins and self-review policy from an environment."""
    if not isinstance(payload, dict):
        raise GhError(f"{PYPI_ENVIRONMENT_NAME} environment must be a JSON object.")
    raw_rules = payload.get("protection_rules")
    if not isinstance(raw_rules, list):
        raise GhError(f"{PYPI_ENVIRONMENT_NAME} protection_rules must be a JSON array.")

    required_rule: dict[str, object] | None = None
    for raw_rule in raw_rules:
        if not isinstance(raw_rule, dict):
            raise GhError(f"{PYPI_ENVIRONMENT_NAME} protection rules contain a non-object entry.")
        rule_type = raw_rule.get("type")
        if not isinstance(rule_type, str) or not rule_type:
            raise GhError(
                f"{PYPI_ENVIRONMENT_NAME} protection rules contain an entry without a type."
            )
        if rule_type == "required_reviewers":
            if required_rule is not None:
                raise GhError(f"{PYPI_ENVIRONMENT_NAME} has multiple required reviewer rules.")
            required_rule = raw_rule

    if required_rule is None:
        return set(), None

    prevent_self_review = required_rule.get("prevent_self_review")
    if not isinstance(prevent_self_review, bool):
        raise GhError(
            f"{PYPI_ENVIRONMENT_NAME} required reviewer rule has an invalid self-review policy."
        )
    raw_reviewers = required_rule.get("reviewers")
    if not isinstance(raw_reviewers, list):
        raise GhError(f"{PYPI_ENVIRONMENT_NAME} required reviewers must be a JSON array.")

    reviewers: set[str] = set()
    for raw_reviewer in raw_reviewers:
        if not isinstance(raw_reviewer, dict):
            raise GhError(
                f"{PYPI_ENVIRONMENT_NAME} required reviewers contains a non-object entry."
            )
        if raw_reviewer.get("type") != "User":
            raise GhError(f"{PYPI_ENVIRONMENT_NAME} required reviewers must contain User entries.")
        reviewer = raw_reviewer.get("reviewer")
        if not isinstance(reviewer, dict):
            raise GhError(
                f"{PYPI_ENVIRONMENT_NAME} required reviewers contains an entry without a reviewer."
            )
        login = reviewer.get("login")
        if not isinstance(login, str) or not login:
            raise GhError(
                f"{PYPI_ENVIRONMENT_NAME} required reviewers contains an entry without a login."
            )
        reviewers.add(login)
    return reviewers, prevent_self_review


def extract_ruleset_ref_patterns(payload: object) -> tuple[set[str], set[str]]:
    """Return included and excluded ref patterns from a ruleset response."""
    if not isinstance(payload, dict):
        raise GhError("Repository ruleset must be a JSON object.")
    conditions = payload.get("conditions")
    if not isinstance(conditions, dict):
        raise GhError("Repository ruleset conditions must be a JSON object.")
    ref_name = conditions.get("ref_name")
    if not isinstance(ref_name, dict):
        raise GhError("Repository ruleset ref_name condition must be a JSON object.")

    patterns: list[set[str]] = []
    for key in ("include", "exclude"):
        raw_patterns = ref_name.get(key)
        if not isinstance(raw_patterns, list):
            raise GhError(f"Repository ruleset ref_name {key} must be a JSON array.")
        if any(not isinstance(pattern, str) or not pattern for pattern in raw_patterns):
            raise GhError(f"Repository ruleset ref_name {key} must contain non-empty strings.")
        patterns.append(set(raw_patterns))
    return patterns[0], patterns[1]


def extract_ruleset_rule_types(payload: object) -> set[str]:
    """Return rule type names from a repository ruleset response."""
    if not isinstance(payload, dict):
        raise GhError("Repository ruleset must be a JSON object.")
    raw_rules = payload.get("rules")
    if not isinstance(raw_rules, list):
        raise GhError("Repository ruleset rules must be a JSON array.")
    rule_types: set[str] = set()
    for raw_rule in raw_rules:
        if not isinstance(raw_rule, dict):
            raise GhError("Repository ruleset rules contain a non-object entry.")
        rule_type = raw_rule.get("type")
        if not isinstance(rule_type, str) or not rule_type:
            raise GhError("Repository ruleset rules contain an entry without a type.")
        rule_types.add(rule_type)
    return rule_types


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

    Each must be a list before it is read. Iterating a dict yields its keys, so
    a payload of the wrong shape would otherwise hand back check names that were
    never actually required, which is the one direction this audit must never
    fail in. Anything that is not a list contributes nothing, leaving every
    expected check reported as missing.
    """
    required = protection.get("required_status_checks")
    if not isinstance(required, dict):
        return set()

    contexts = required.get("contexts")
    checks = required.get("checks")
    names: set[str] = set()
    if isinstance(contexts, list):
        names.update(value for value in contexts if isinstance(value, str) and value)
    if isinstance(checks, list):
        names.update(
            entry["context"]
            for entry in checks
            if isinstance(entry, dict)
            and isinstance(entry.get("context"), str)
            and entry["context"]
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


def audit_actions(
    actions_permissions: dict[str, object],
    selected_actions: dict[str, object] | None,
) -> list[str]:
    """Audit Actions enablement, pinning, and selected action patterns."""
    findings: list[str] = []
    if actions_permissions.get("enabled") is not True:
        findings.append("GitHub Actions are not enabled")

    actions_allowed = actions_permissions.get("allowed_actions")
    if actions_allowed != EXPECTED_ACTIONS_ALLOWED:
        findings.append(
            f"Actions allowed policy is {actions_allowed!r} instead of {EXPECTED_ACTIONS_ALLOWED!r}"
        )
    if actions_permissions.get("sha_pinning_required") is not EXPECTED_ACTIONS_SHA_PINNING:
        findings.append("Actions are not required to use full-length commit SHAs")

    if selected_actions is None:
        return findings

    if selected_actions.get("github_owned_allowed") is not EXPECTED_GITHUB_OWNED_ACTIONS:
        findings.append("GitHub-owned Actions are not allowed")
    if selected_actions.get("verified_allowed") is not EXPECTED_VERIFIED_ACTIONS:
        findings.append("Verified Marketplace Actions are allowed")
    allowed_patterns = extract_allowed_action_patterns(selected_actions)
    findings.extend(
        _missing(allowed_patterns, EXPECTED_ACTION_PATTERNS, "allowed Actions patterns")
    )
    findings.extend(
        _unexpected(allowed_patterns, EXPECTED_ACTION_PATTERNS, "allowed Actions patterns")
    )
    return findings


def audit_pypi_environment(payload: dict[str, object]) -> list[str]:
    """Audit the PyPI environment's reviewer and administrator bypass policy."""
    reviewers, prevent_self_review = extract_environment_reviewers(payload)
    findings = _missing(reviewers, EXPECTED_PYPI_REVIEWERS, "pypi required reviewers")

    can_admins_bypass = payload.get("can_admins_bypass")
    if not isinstance(can_admins_bypass, bool):
        raise GhError(f"{PYPI_ENVIRONMENT_NAME} can_admins_bypass must be a boolean.")
    if can_admins_bypass is not EXPECTED_PYPI_CAN_ADMINS_BYPASS:
        findings.append(f"{PYPI_ENVIRONMENT_NAME} administrator bypass is disabled")

    if prevent_self_review is None:
        findings.append(f"{PYPI_ENVIRONMENT_NAME} has no required reviewer rule")
    elif prevent_self_review is not EXPECTED_PYPI_PREVENT_SELF_REVIEW:
        findings.append(f"{PYPI_ENVIRONMENT_NAME} prevents self-review")
    return findings


def audit_release_tag_rulesets(rulesets: list[dict[str, object]]) -> list[str]:
    """Audit the active ruleset protecting version tags."""
    matching = []
    for ruleset in rulesets:
        name = ruleset.get("name")
        if not isinstance(name, str) or not name:
            raise GhError("Repository ruleset contains an entry without a name.")
        if name == RELEASE_TAG_RULESET_NAME:
            matching.append(ruleset)

    if not matching:
        return [f"missing release tag ruleset: {RELEASE_TAG_RULESET_NAME}"]

    findings: list[str] = []
    if len(matching) > 1:
        findings.append(f"multiple release tag rulesets named {RELEASE_TAG_RULESET_NAME!r}")

    ruleset = matching[0]
    target = ruleset.get("target")
    if target != EXPECTED_RELEASE_TAG_RULESET_TARGET:
        findings.append(
            f"release tag ruleset target is {target!r} instead of "
            f"{EXPECTED_RELEASE_TAG_RULESET_TARGET!r}"
        )
    enforcement = ruleset.get("enforcement")
    if enforcement != EXPECTED_RELEASE_TAG_RULESET_ENFORCEMENT:
        findings.append(
            f"release tag ruleset enforcement is {enforcement!r} instead of "
            f"{EXPECTED_RELEASE_TAG_RULESET_ENFORCEMENT!r}"
        )

    included_patterns, excluded_patterns = extract_ruleset_ref_patterns(ruleset)
    findings.extend(
        _missing(included_patterns, EXPECTED_RELEASE_TAG_PATTERNS, "release tag patterns")
    )
    findings.extend(
        _unexpected(included_patterns, EXPECTED_RELEASE_TAG_PATTERNS, "release tag patterns")
    )
    findings.extend(_unexpected(excluded_patterns, frozenset(), "excluded release tag patterns"))

    rule_types = extract_ruleset_rule_types(ruleset)
    findings.extend(_missing(rule_types, EXPECTED_RELEASE_TAG_RULES, "release tag rules"))
    findings.extend(_unexpected(rule_types, EXPECTED_RELEASE_TAG_RULES, "release tag rules"))
    return findings


def audit_repository(repository: dict[str, object], *, default_branch: str) -> list[str]:
    """Audit the repository-level settings, ignoring branch protection.

    A field the response omitted is a failure to look, not a setting at its
    wrong value. GitHub returns a reduced repository object to tokens without
    the access a field needs, and ``dict.get`` cannot tell that apart from a
    real ``false``, so an absent key would otherwise be reported as drift about
    a setting that is in fact correct.
    """
    unreadable = sorted(JUDGED_REPOSITORY_FIELDS - repository.keys())
    if unreadable:
        raise GhError(
            "The repository metadata response omitted "
            + ", ".join(unreadable)
            + ". The token cannot read them, so their values are unknown rather than wrong."
        )

    findings = []

    actual_branch = repository.get("default_branch")
    if actual_branch != default_branch:
        findings.append(f"default branch is {actual_branch!r} instead of {default_branch!r}")

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
    actions_permissions = _fetch_object(
        f"repos/{repo}/actions/permissions", "Actions permissions", run_fn=run_fn
    )
    selected_actions = None
    if actions_permissions.get("allowed_actions") == EXPECTED_ACTIONS_ALLOWED:
        selected_actions = _fetch_object(
            f"repos/{repo}/actions/permissions/selected-actions",
            "Selected Actions settings",
            run_fn=run_fn,
        )
    pypi_environment = _fetch_object(
        f"repos/{repo}/environments/{PYPI_ENVIRONMENT_NAME}",
        f"{PYPI_ENVIRONMENT_NAME} environment",
        run_fn=run_fn,
    )
    rulesets = _fetch_ruleset_details(repo, run_fn=run_fn)
    protection = _fetch_protection(repo, default_branch, run_fn=run_fn)
    variables = _fetch_object(f"repos/{repo}/actions/variables", "Actions variables", run_fn=run_fn)
    secrets = _fetch_object(f"repos/{repo}/actions/secrets", "Actions secrets", run_fn=run_fn)

    findings = audit_repository(repository, default_branch=default_branch)
    findings.extend(audit_actions(actions_permissions, selected_actions))
    findings.extend(audit_pypi_environment(pypi_environment))
    findings.extend(audit_release_tag_rulesets(rulesets))
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


def report_checked(reached_verdict: bool, *, env: Mapping[str, str] | None = None) -> None:
    """Record whether the audit reached a verdict, for the calling workflow.

    The alert jobs pick between "settings drifted" and "the audit could not read
    them" on this one bit, and it cannot travel as an exit code: `make` rewrites
    every failing recipe's status to 2, so drift and an unreadable response
    arrive identical to the workflow shell. This mirrors the same output in
    ``scripts.ci.schedule_watchdog`` for the same reason.

    Outside GitHub Actions the variable is unset and nothing is written, so the
    everyday `make ci-audit-repo-settings` is unaffected.
    """
    path = (os.environ if env is None else env).get(GITHUB_OUTPUT_ENV)
    if not path:
        return
    value = "true" if reached_verdict else "false"
    with Path(path).open("a", encoding="utf-8") as handle:
        handle.write(f"{CHECKED_OUTPUT}={value}\n")


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
        report_checked(False)
        return EXIT_CHECK_FAILED

    report_checked(True)

    if not findings:
        print(f"Repository settings for {repo} match expectations")
        return EXIT_HEALTHY

    print(f"Repository settings audit found drift in {repo}:")
    for finding in findings:
        print(f"- {finding}")
    return EXIT_DRIFT_FOUND


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
