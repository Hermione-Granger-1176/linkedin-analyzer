"""Cover the GitHub repository settings audit.

The audit exists because these settings live outside the repository, so nothing
else in this project can notice them changing. The tests therefore care most
about the two ways it could go quiet: reporting a setting as correct when the
payload never actually said so, and treating removed branch protection (the
worst drift there is) as a failure to look rather than a finding.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

import pytest
from scripts.ci import repo_audit
from scripts.gh.gh_runner import GhError

from tests.support.gh import FakeGh, completed_process, has

if TYPE_CHECKING:
    from pathlib import Path

REPO = "owner/name"
REPO_PATH = f"repos/{REPO}"
PROTECTION_PATH = f"{REPO_PATH}/branches/main/protection"
VARIABLES_PATH = f"{REPO_PATH}/actions/variables"
SECRETS_PATH = f"{REPO_PATH}/actions/secrets"
ACTIONS_PERMISSIONS_PATH = f"{REPO_PATH}/actions/permissions"
SELECTED_ACTIONS_PATH = f"{ACTIONS_PERMISSIONS_PATH}/selected-actions"
PYPI_ENVIRONMENT_PATH = f"{REPO_PATH}/environments/{repo_audit.PYPI_ENVIRONMENT_NAME}"
DEPLOYMENT_POLICIES_PATH = f"{PYPI_ENVIRONMENT_PATH}/deployment-branch-policies"
RULESETS_PATH = f"{REPO_PATH}/rulesets"
RULESET_DETAIL_PATH = f"{RULESETS_PATH}/42"
EXPECTED_CHECKS = sorted(repo_audit.EXPECTED_REQUIRED_CHECKS)

HEALTHY_REPOSITORY: dict[str, object] = {
    "default_branch": "main",
    "allow_squash_merge": True,
    "allow_merge_commit": False,
    "allow_rebase_merge": False,
    "delete_branch_on_merge": True,
    "security_and_analysis": {
        name: {"status": "enabled"} for name in repo_audit.EXPECTED_SECURITY_FEATURES
    },
}

HEALTHY_PROTECTION: dict[str, object] = {
    "required_status_checks": {"contexts": sorted(repo_audit.EXPECTED_REQUIRED_CHECKS)},
    "required_pull_request_reviews": {"required_approving_review_count": 1},
    "required_signatures": {"enabled": True},
    "required_linear_history": {"enabled": True},
    "required_conversation_resolution": {"enabled": True},
    "allow_force_pushes": {"enabled": False},
    "allow_deletions": {"enabled": False},
}

HEALTHY_VARIABLES = {"variables": [{"name": name} for name in repo_audit.EXPECTED_VARIABLES]}
HEALTHY_SECRETS = {"secrets": [{"name": name} for name in repo_audit.EXPECTED_SECRETS]}
HEALTHY_ACTIONS_PERMISSIONS = {
    "enabled": True,
    "allowed_actions": repo_audit.EXPECTED_ACTIONS_ALLOWED,
    "sha_pinning_required": repo_audit.EXPECTED_ACTIONS_SHA_PINNING,
}
HEALTHY_SELECTED_ACTIONS = {
    "github_owned_allowed": repo_audit.EXPECTED_GITHUB_OWNED_ACTIONS,
    "verified_allowed": repo_audit.EXPECTED_VERIFIED_ACTIONS,
    "patterns_allowed": sorted(repo_audit.EXPECTED_ACTION_PATTERNS),
}
SELECTED_REFS_POLICY = {"protected_branches": False, "custom_branch_policies": True}
HEALTHY_DEPLOYMENT_POLICIES = {
    "branch_policies": [
        {"type": entry.split(" ", 1)[0], "name": entry.split(" ", 1)[1]}
        for entry in sorted(repo_audit.EXPECTED_PYPI_DEPLOYMENT_POLICIES)
    ]
}
HEALTHY_PYPI_ENVIRONMENT = {
    "can_admins_bypass": repo_audit.EXPECTED_PYPI_CAN_ADMINS_BYPASS,
    "deployment_branch_policy": SELECTED_REFS_POLICY,
    "protection_rules": [
        {
            "type": "required_reviewers",
            "prevent_self_review": repo_audit.EXPECTED_PYPI_PREVENT_SELF_REVIEW,
            "reviewers": [
                {
                    "type": "User",
                    "reviewer": {"login": reviewer},
                }
                for reviewer in sorted(repo_audit.EXPECTED_PYPI_REVIEWERS)
            ],
        }
    ],
}
HEALTHY_RULESET_DETAIL = {
    "id": 42,
    "name": repo_audit.RELEASE_TAG_RULESET_NAME,
    "target": repo_audit.EXPECTED_RELEASE_TAG_RULESET_TARGET,
    "enforcement": repo_audit.EXPECTED_RELEASE_TAG_RULESET_ENFORCEMENT,
    "conditions": {
        "ref_name": {
            "include": sorted(repo_audit.EXPECTED_RELEASE_TAG_PATTERNS),
            "exclude": [],
        }
    },
    "rules": [{"type": rule} for rule in sorted(repo_audit.EXPECTED_RELEASE_TAG_RULES)],
}
HEALTHY_RULESETS = [
    {
        "id": 42,
        "name": repo_audit.RELEASE_TAG_RULESET_NAME,
        "target": repo_audit.EXPECTED_RELEASE_TAG_RULESET_TARGET,
        "enforcement": repo_audit.EXPECTED_RELEASE_TAG_RULESET_ENFORCEMENT,
    }
]


def _repository(**overrides: object) -> dict[str, object]:
    """Return the healthy repository payload with fields replaced."""
    return {**HEALTHY_REPOSITORY, **overrides}


def _protection(**overrides: object) -> dict[str, object]:
    """Return the healthy branch protection payload with fields replaced."""
    return {**HEALTHY_PROTECTION, **overrides}


def _pypi_environment(**overrides: object) -> dict[str, object]:
    """Return the healthy PyPI environment payload with fields replaced."""
    return {**HEALTHY_PYPI_ENVIRONMENT, **overrides}


def _runner(
    *,
    repository: object = None,
    protection: object = None,
    variables: object = None,
    secrets: object = None,
    actions_permissions: object = None,
    selected_actions: object = None,
    pypi_environment: object = None,
    deployment_policies: object = None,
    rulesets: object = None,
    ruleset_detail: object = None,
) -> FakeGh:
    """Return a fake gh runner answering all repository audit calls.

    Any argument may be an exception, which the fake raises for that call.
    """
    return FakeGh(
        [
            (has(RULESET_DETAIL_PATH), _response(ruleset_detail, HEALTHY_RULESET_DETAIL)),
            (has(RULESETS_PATH), _response(rulesets, HEALTHY_RULESETS)),
            (has(SELECTED_ACTIONS_PATH), _response(selected_actions, HEALTHY_SELECTED_ACTIONS)),
            (
                has(ACTIONS_PERMISSIONS_PATH),
                _response(actions_permissions, HEALTHY_ACTIONS_PERMISSIONS),
            ),
            (
                has(DEPLOYMENT_POLICIES_PATH),
                _response(deployment_policies, HEALTHY_DEPLOYMENT_POLICIES),
            ),
            (has(PYPI_ENVIRONMENT_PATH), _response(pypi_environment, HEALTHY_PYPI_ENVIRONMENT)),
            (has(PROTECTION_PATH), _response(protection, HEALTHY_PROTECTION)),
            (has(VARIABLES_PATH), _response(variables, HEALTHY_VARIABLES)),
            (has(SECRETS_PATH), _response(secrets, HEALTHY_SECRETS)),
            (has(REPO_PATH), _response(repository, HEALTHY_REPOSITORY)),
        ]
    )


def _response(payload: object, healthy: object) -> object:
    """Turn a payload into a fake gh response, passing exceptions through."""
    if payload is None:
        payload = healthy
    if isinstance(payload, Exception):
        return payload
    return completed_process(0, json.dumps(payload))


def _audit(**kwargs: object) -> list[str]:
    """Run the full audit against a fake runner built from ``kwargs``."""
    return repo_audit.audit_repo_settings(repo=REPO, run_fn=_runner(**kwargs))  # type: ignore[arg-type]


# ─── A healthy repository ────────────────────────────────────────────────────


def test_the_expected_configuration_produces_no_findings() -> None:
    """The live repository passes this audit, so the constants describe reality."""
    assert _audit() == []


def test_every_audited_setting_is_read_from_the_api() -> None:
    """Every settings payload is fetched, so no expectation is silently unchecked."""
    runner = _runner()
    repo_audit.audit_repo_settings(repo=REPO, run_fn=runner)
    requested = {call[-1] for call in runner.calls}
    assert requested == {
        REPO_PATH,
        PROTECTION_PATH,
        VARIABLES_PATH,
        SECRETS_PATH,
        ACTIONS_PERMISSIONS_PATH,
        SELECTED_ACTIONS_PATH,
        PYPI_ENVIRONMENT_PATH,
        DEPLOYMENT_POLICIES_PATH,
        RULESETS_PATH,
        RULESET_DETAIL_PATH,
    }


# ─── Branch protection ───────────────────────────────────────────────────────


def test_an_unprotected_branch_is_a_finding_not_a_failure_to_look() -> None:
    """A 404 here means protection was removed, which is the audit's whole point."""
    findings = _audit(protection=GhError("gh api failed: Branch not protected (HTTP 404)"))
    assert findings == ["main has no branch protection at all"]


@pytest.mark.parametrize(
    ("error", "match"),
    [
        ("gh api failed: Branch not found (HTTP 404)", "Branch not found"),
        ("gh api was refused: token missing a permission", "was refused"),
        ("gh api failed: Not Found (HTTP 404)", "Not Found"),
    ],
    ids=["missing-branch", "no-permission", "missing-repository"],
)
def test_only_an_unprotected_branch_is_softened_into_a_finding(error: str, match: str) -> None:
    """A mistyped branch also answers 404, and reporting it as removed protection would lie.

    GitHub separates "Branch not protected" from "Branch not found" by message
    alone, both under HTTP 404, so matching the status would turn every wrong
    branch or repository name into a confident claim that protection is gone.
    """
    with pytest.raises(GhError, match=match):
        _audit(protection=GhError(error))


def test_a_renamed_required_check_is_reported_by_name() -> None:
    """Renaming a job silently drops it from protection; the finding has to name which."""
    kept = sorted(repo_audit.EXPECTED_REQUIRED_CHECKS - {"CodeQL"})
    findings = _audit(protection=_protection(required_status_checks={"contexts": kept}))
    assert findings == ["main branch protection is missing required checks: CodeQL"]


def test_checks_pinned_to_an_app_id_count_the_same_as_plain_contexts() -> None:
    """GitHub reports the list twice; reading only one form would invent drift."""
    pinned = {"checks": [{"context": name} for name in repo_audit.EXPECTED_REQUIRED_CHECKS]}
    assert _audit(protection=_protection(required_status_checks=pinned)) == []


@pytest.mark.parametrize(
    "required_status_checks",
    [
        {},
        {"contexts": None, "checks": None},
        {"contexts": ["", 7], "checks": [{"context": ""}, {"context": 7}, "not-a-dict"]},
        "not-an-object",
        # A mapping keyed by the expected names. Iterating it yields those names
        # as strings, so reading it without a list check would certify every
        # required check from a payload that never required any of them.
        {"contexts": dict.fromkeys(EXPECTED_CHECKS, 1)},
        {"checks": dict.fromkeys(EXPECTED_CHECKS, 1)},
        {"contexts": "CodeQL", "checks": "CodeQL"},
    ],
    ids=[
        "absent",
        "null-lists",
        "unusable-entries",
        "wrong-shape",
        "contexts-as-a-mapping",
        "checks-as-a-mapping",
        "lists-as-strings",
    ],
)
def test_an_unusable_required_checks_payload_reports_every_check_missing(
    required_status_checks: object,
) -> None:
    """No check name can be certified from a payload that does not name it."""
    findings = _audit(protection=_protection(required_status_checks=required_status_checks))
    expected = ", ".join(sorted(repo_audit.EXPECTED_REQUIRED_CHECKS))
    assert findings == [f"main branch protection is missing required checks: {expected}"]


@pytest.mark.parametrize(
    "reviews",
    [None, "not-an-object", {}, {"required_approving_review_count": 0}],
    ids=["null", "wrong-shape", "empty", "zero"],
)
def test_review_requirements_below_one_approval_are_reported(reviews: object) -> None:
    """Anything short of a stated count of at least one leaves merges unreviewed."""
    findings = _audit(protection=_protection(required_pull_request_reviews=reviews))
    assert findings == ["main branch protection does not require at least 1 approving review"]


def test_a_boolean_approval_count_is_not_mistaken_for_one_approval() -> None:
    """`True` is an int in Python, so it would otherwise pass as a count of 1."""
    reviews = {"required_approving_review_count": True}
    findings = _audit(protection=_protection(required_pull_request_reviews=reviews))
    assert findings == ["main branch protection does not require at least 1 approving review"]


@pytest.mark.parametrize("block", sorted(repo_audit.REQUIRED_PROTECTION_BLOCKS))
@pytest.mark.parametrize("value", [{"enabled": False}, "not-an-object"], ids=["off", "wrong-shape"])
def test_each_required_protection_block_is_reported_when_it_is_not_enabled(
    block: str, value: object
) -> None:
    """A block that is off and a block that is unreadable both fail to protect anything."""
    findings = _audit(protection=_protection(**{block: value}))
    assert findings == [f"main branch protection {repo_audit.REQUIRED_PROTECTION_BLOCKS[block]}"]


@pytest.mark.parametrize("block", sorted(repo_audit.FORBIDDEN_PROTECTION_BLOCKS))
def test_each_forbidden_protection_block_is_reported_when_it_is_enabled(block: str) -> None:
    """These two let history be rewritten or removed, which nothing else here compensates for."""
    findings = _audit(protection=_protection(**{block: {"enabled": True}}))
    assert findings == [f"main branch protection {repo_audit.FORBIDDEN_PROTECTION_BLOCKS[block]}"]


def test_a_non_default_branch_is_audited_under_its_own_name() -> None:
    """The branch argument has to reach both the API path and the findings."""
    runner = FakeGh(
        [
            (has(RULESET_DETAIL_PATH), _response(None, HEALTHY_RULESET_DETAIL)),
            (has(RULESETS_PATH), _response(None, HEALTHY_RULESETS)),
            (has(SELECTED_ACTIONS_PATH), _response(None, HEALTHY_SELECTED_ACTIONS)),
            (has(ACTIONS_PERMISSIONS_PATH), _response(None, HEALTHY_ACTIONS_PERMISSIONS)),
            (has(DEPLOYMENT_POLICIES_PATH), _response(None, HEALTHY_DEPLOYMENT_POLICIES)),
            (has(PYPI_ENVIRONMENT_PATH), _response(None, HEALTHY_PYPI_ENVIRONMENT)),
            (has(f"{REPO_PATH}/branches/release/protection"), _response(None, HEALTHY_PROTECTION)),
            (has(VARIABLES_PATH), _response(None, HEALTHY_VARIABLES)),
            (has(SECRETS_PATH), _response(None, HEALTHY_SECRETS)),
            (has(REPO_PATH), _response(_repository(default_branch="release"), None)),
        ]
    )
    assert repo_audit.audit_repo_settings(repo=REPO, default_branch="release", run_fn=runner) == []


# ─── Repository settings ─────────────────────────────────────────────────────


def test_a_changed_default_branch_is_reported() -> None:
    """Every protection expectation below is scoped to the default branch."""
    findings = _audit(repository=_repository(default_branch="master"))
    assert findings == ["default branch is 'master' instead of 'main'"]


@pytest.mark.parametrize(
    "field",
    ["allow_squash_merge", "allow_merge_commit", "allow_rebase_merge", "delete_branch_on_merge"],
)
def test_a_field_only_a_writing_token_can_read_is_not_judged(field: str) -> None:
    """GitHub returns these only to a token with push access, which the audit App lacks.

    They arrive as ``null`` rather than as their real value, so judging them
    would alarm every week about settings that are in fact correct.
    """
    assert field not in repo_audit.JUDGED_REPOSITORY_FIELDS
    assert _audit(repository=_repository(**{field: None})) == []


def test_a_disabled_security_feature_is_reported_by_name() -> None:
    """Turning one off is a single click in the web UI and invisible everywhere else."""
    features = {name: {"status": "enabled"} for name in repo_audit.EXPECTED_SECURITY_FEATURES}
    features["secret_scanning_push_protection"] = {"status": "disabled"}
    findings = _audit(repository=_repository(security_and_analysis=features))
    assert findings == ["missing security and analysis features: secret_scanning_push_protection"]


@pytest.mark.parametrize(
    "security_and_analysis",
    [None, "not-an-object", {"secret_scanning": "not-an-object"}],
    ids=["absent", "wrong-shape", "wrong-entry-shape"],
)
def test_security_features_that_cannot_be_read_are_reported_as_missing(
    security_and_analysis: object,
) -> None:
    """The block is absent for a caller without admin access; that is not a pass."""
    findings = _audit(repository=_repository(security_and_analysis=security_and_analysis))
    expected = ", ".join(sorted(repo_audit.EXPECTED_SECURITY_FEATURES))
    assert findings == [f"missing security and analysis features: {expected}"]


# ─── New repository policy settings ──────────────────────────────────────────


def test_actions_policy_drift_is_reported() -> None:
    """Actions enablement, allowlisting, and SHA pinning all remain enforced."""
    findings = _audit(
        actions_permissions={
            "enabled": False,
            "allowed_actions": "all",
            "sha_pinning_required": False,
        }
    )
    assert findings == [
        "GitHub Actions are not enabled",
        "Actions allowed policy is 'all' instead of 'selected'",
        "Actions are not required to use full-length commit SHAs",
    ]


def test_selected_actions_drift_is_reported() -> None:
    """The selected Actions policy reports missing and unexpected patterns."""
    findings = _audit(
        selected_actions={
            "github_owned_allowed": False,
            "verified_allowed": True,
            "patterns_allowed": ["astral-sh/setup-uv@*", "example/unused-action@*"],
        }
    )
    assert "GitHub-owned Actions are not allowed" in findings
    assert "Verified Marketplace Actions are allowed" in findings
    assert "missing allowed Actions patterns" in findings[2]
    assert findings[3] == "unexpected allowed Actions patterns: example/unused-action@*"


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        (None, "must be a JSON object"),
        ({}, "patterns_allowed must be a JSON array"),
        ({"patterns_allowed": [7]}, "must contain non-empty strings"),
        ({"patterns_allowed": [""]}, "must contain non-empty strings"),
    ],
    ids=["not-an-object", "missing-patterns", "non-string-pattern", "empty-pattern"],
)
def test_selected_actions_malformed_patterns_fail_closed(payload: object, message: str) -> None:
    """Selected Actions data cannot certify a policy when its shape is malformed."""
    with pytest.raises(GhError, match=message):
        repo_audit.extract_allowed_action_patterns(payload)


def test_pypi_environment_drift_is_reported() -> None:
    """The PyPI environment keeps review protection and the intended bypass policy."""
    findings = _audit(
        pypi_environment={
            "can_admins_bypass": False,
            "deployment_branch_policy": SELECTED_REFS_POLICY,
            "protection_rules": [
                {
                    "type": "required_reviewers",
                    "prevent_self_review": True,
                    "reviewers": [],
                }
            ],
        }
    )
    assert findings == [
        "missing pypi required reviewers: Hermione-Granger-1176",
        "pypi administrator bypass is disabled",
        "pypi prevents self-review",
    ]


def test_pypi_without_required_reviewer_rule_is_reported() -> None:
    """An environment without a reviewer rule cannot protect package publishing."""
    findings = _audit(
        pypi_environment={
            "can_admins_bypass": True,
            "deployment_branch_policy": SELECTED_REFS_POLICY,
            "protection_rules": [{"type": "wait_timer"}],
        }
    )
    assert findings == [
        "missing pypi required reviewers: Hermione-Granger-1176",
        "pypi has no required reviewer rule",
    ]


def test_pypi_environment_open_to_every_ref_is_reported() -> None:
    """A null policy lets a release from any ref request publishing credentials."""
    findings = _audit(pypi_environment=_pypi_environment(deployment_branch_policy=None))
    assert findings == ["pypi allows deployments from any branch or tag"]


def test_pypi_environment_limited_to_protected_branches_is_reported() -> None:
    """Releases are tagged, and this option admits only branches, so it blocks every release."""
    findings = _audit(
        pypi_environment=_pypi_environment(
            deployment_branch_policy={"protected_branches": True, "custom_branch_policies": False}
        )
    )
    assert findings == ["pypi restricts deployments to protected branches, not release tags"]


def test_pypi_deployment_ref_drift_is_reported() -> None:
    """The tag pattern must be present, and nothing may be added alongside it."""
    findings = _audit(deployment_policies={"branch_policies": [{"name": "main", "type": "branch"}]})
    assert findings == [
        "missing pypi deployment refs: tag v*",
        "unexpected pypi deployment refs: branch main",
    ]


def test_pypi_deployment_policies_are_only_fetched_when_they_exist() -> None:
    """An unrestricted environment has no policy list, so the audit must not ask for one."""
    runner = _runner(pypi_environment=_pypi_environment(deployment_branch_policy=None))
    repo_audit.audit_repo_settings(repo=REPO, run_fn=runner)
    assert DEPLOYMENT_POLICIES_PATH not in {call[-1] for call in runner.calls}


def test_pypi_deployment_policies_must_be_fetched_before_they_are_audited() -> None:
    """Auditing selected refs without the policy list would silently pass."""
    with pytest.raises(GhError, match="deployment branch policies were not fetched"):
        repo_audit.audit_pypi_environment(HEALTHY_PYPI_ENVIRONMENT)


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        (None, "deployment branch policies must be a JSON object"),
        ({}, "branch_policies must be a JSON array"),
        ({"branch_policies": ["bad"]}, "contains a non-object entry"),
        ({"branch_policies": [{"type": "tag"}]}, "contains an entry without a name"),
        ({"branch_policies": [{"name": "v*"}]}, "contains an entry without a type"),
    ],
    ids=["not-object", "not-array", "non-object-entry", "no-name", "no-type"],
)
def test_pypi_deployment_policies_malformed_entries_fail_closed(
    payload: object, message: str
) -> None:
    """Malformed policy data must not read as a correctly restricted environment."""
    with pytest.raises(GhError, match=message):
        repo_audit.extract_deployment_policies(payload)


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        (None, "must be a JSON object"),
        ({}, "protection_rules must be a JSON array"),
        ({"protection_rules": ["bad"]}, "contain a non-object entry"),
        ({"protection_rules": [{}]}, "contain an entry without a type"),
        (
            {"protection_rules": [{"type": "required_reviewers"}]},
            "invalid self-review policy",
        ),
        (
            {"protection_rules": [{"type": "required_reviewers", "prevent_self_review": False}]},
            "required reviewers must be a JSON array",
        ),
        (
            {
                "protection_rules": [
                    {
                        "type": "required_reviewers",
                        "prevent_self_review": False,
                        "reviewers": ["bad"],
                    }
                ]
            },
            "required reviewers contains a non-object entry",
        ),
        (
            {
                "protection_rules": [
                    {
                        "type": "required_reviewers",
                        "prevent_self_review": False,
                        "reviewers": [{"type": "Team"}],
                    }
                ]
            },
            "must contain User entries",
        ),
        (
            {
                "protection_rules": [
                    {
                        "type": "required_reviewers",
                        "prevent_self_review": False,
                        "reviewers": [{"type": "User"}],
                    }
                ]
            },
            "without a reviewer",
        ),
        (
            {
                "protection_rules": [
                    {
                        "type": "required_reviewers",
                        "prevent_self_review": False,
                        "reviewers": [{"type": "User", "reviewer": {}}],
                    }
                ]
            },
            "without a login",
        ),
        (
            {
                "protection_rules": [
                    {"type": "required_reviewers", "prevent_self_review": False, "reviewers": []},
                    {"type": "required_reviewers", "prevent_self_review": False, "reviewers": []},
                ]
            },
            "multiple required reviewer rules",
        ),
    ],
    ids=[
        "not-an-object",
        "missing-rules",
        "non-object-rule",
        "missing-rule-type",
        "missing-self-review-policy",
        "missing-reviewers",
        "non-object-reviewer",
        "team-reviewer",
        "missing-reviewer-object",
        "missing-login",
        "multiple-rules",
    ],
)
def test_pypi_environment_malformed_reviewers_fail_closed(payload: object, message: str) -> None:
    """Malformed environment protection data must not be treated as healthy."""
    with pytest.raises(GhError, match=message):
        repo_audit.extract_environment_reviewers(payload)


def test_release_tag_ruleset_drift_is_reported() -> None:
    """The release tag ruleset reports all of its policy drift in one pass."""
    findings = _audit(
        ruleset_detail={
            "id": 42,
            "name": repo_audit.RELEASE_TAG_RULESET_NAME,
            "target": "branch",
            "enforcement": "disabled",
            "conditions": {
                "ref_name": {
                    "include": ["refs/tags/v*", "refs/tags/beta*"],
                    "exclude": ["refs/tags/v0.*"],
                }
            },
            "rules": [{"type": "creation"}, {"type": "update"}],
        }
    )
    assert findings == [
        "release tag ruleset target is 'branch' instead of 'tag'",
        "release tag ruleset enforcement is 'disabled' instead of 'active'",
        "unexpected release tag patterns: refs/tags/beta*",
        "unexpected excluded release tag patterns: refs/tags/v0.*",
        "missing release tag rules: deletion, non_fast_forward",
        "unexpected release tag rules: update",
    ]


def test_missing_release_tag_ruleset_is_reported() -> None:
    """Removing the release tag ruleset is visible as repository settings drift."""
    assert _audit(rulesets=[]) == ["missing release tag ruleset: Protect version tags"]


def test_unrelated_ruleset_is_ignored() -> None:
    """Other repository rulesets do not change the release tag contract."""
    detail = {**HEALTHY_RULESET_DETAIL, "name": "Unrelated ruleset"}
    assert _audit(ruleset_detail=detail) == ["missing release tag ruleset: Protect version tags"]


def test_duplicate_release_tag_rulesets_are_reported() -> None:
    """Duplicate ruleset names make the release protection ambiguous."""
    findings = repo_audit.audit_release_tag_rulesets(
        [HEALTHY_RULESET_DETAIL, HEALTHY_RULESET_DETAIL]
    )
    assert findings == ["multiple release tag rulesets named 'Protect version tags'"]


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        (None, "must be a JSON object"),
        ({}, "conditions must be a JSON object"),
        ({"conditions": {}}, "ref_name condition must be a JSON object"),
        (
            {"conditions": {"ref_name": {}}},
            "ref_name include must be a JSON array",
        ),
        (
            {"conditions": {"ref_name": {"include": []}}},
            "ref_name exclude must be a JSON array",
        ),
        (
            {"conditions": {"ref_name": {"include": [7], "exclude": []}}},
            "ref_name include must contain non-empty strings",
        ),
        (
            {"conditions": {"ref_name": {"include": [], "exclude": [""]}}},
            "ref_name exclude must contain non-empty strings",
        ),
    ],
    ids=[
        "not-an-object",
        "missing-conditions",
        "missing-ref-name",
        "missing-include",
        "missing-exclude",
        "invalid-include",
        "invalid-exclude",
    ],
)
def test_release_tag_ref_patterns_malformed_data_fail_closed(payload: object, message: str) -> None:
    """Malformed ruleset ref conditions cannot certify the protected tag scope."""
    with pytest.raises(GhError, match=message):
        repo_audit.extract_ruleset_ref_patterns(payload)


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        (None, "must be a JSON object"),
        ({}, "rules must be a JSON array"),
        ({"rules": ["bad"]}, "contain a non-object entry"),
        ({"rules": [{}]}, "contain an entry without a type"),
    ],
    ids=["not-an-object", "missing-rules", "non-object-rule", "missing-rule-type"],
)
def test_release_tag_rules_malformed_data_fail_closed(payload: object, message: str) -> None:
    """Malformed ruleset rules cannot certify release tag protection."""
    with pytest.raises(GhError, match=message):
        repo_audit.extract_ruleset_rule_types(payload)


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"actions_permissions": []}, "Actions permissions must be a JSON object"),
        ({"selected_actions": []}, "Selected Actions settings must be a JSON object"),
        ({"pypi_environment": []}, "pypi environment must be a JSON object"),
        ({"rulesets": {}}, "Repository rulesets response must be a JSON array"),
        ({"rulesets": ["bad"]}, "contains a non-object entry"),
        (
            {"rulesets": [{"id": "42"}]},
            "contains an entry without a numeric id",
        ),
        ({"ruleset_detail": []}, "repository ruleset 42 must be a JSON object"),
        (
            {"pypi_environment": {"can_admins_bypass": "yes", "protection_rules": []}},
            "can_admins_bypass must be a boolean",
        ),
        ({"ruleset_detail": {"id": 42}}, "contains an entry without a name"),
        (
            {"pypi_environment": _pypi_environment(deployment_branch_policy="all")},
            "deployment_branch_policy must be a JSON object or null",
        ),
        ({"deployment_policies": []}, "pypi deployment branch policies must be a JSON object"),
    ],
    ids=[
        "actions-permissions",
        "selected-actions",
        "pypi-environment",
        "rulesets-not-list",
        "rulesets-not-object",
        "ruleset-id",
        "ruleset-detail",
        "pypi-bypass-policy",
        "ruleset-name",
        "pypi-deployment-policy-shape",
        "pypi-deployment-policies",
    ],
)
def test_new_repository_policy_responses_fail_closed(kwargs: object, message: str) -> None:
    """Every new settings endpoint rejects malformed top-level responses."""
    with pytest.raises(GhError, match=message):
        _audit(**kwargs)  # type: ignore[arg-type]


# ─── Actions inventory ───────────────────────────────────────────────────────


def test_a_missing_variable_is_reported() -> None:
    """Without it the writeback workflows degrade into a silent skip."""
    assert _audit(variables={"variables": []}) == [
        "missing repository variables: APP_ID, AUDIT_APP_ID, ESCALATION_APP_ID"
    ]


def test_a_missing_secret_is_reported() -> None:
    """Without it the writeback workflows degrade into a silent skip."""
    assert _audit(secrets={"secrets": []}) == [
        "missing repository secrets: "
        "APP_PRIVATE_KEY, AUDIT_APP_PRIVATE_KEY, ESCALATION_APP_PRIVATE_KEY"
    ]


def test_a_missing_escalation_credential_alone_is_reported() -> None:
    """The primary app being healthy must not hide an absent escalation app."""
    assert _audit(variables={"variables": [{"name": "APP_ID"}]}) == [
        "missing repository variables: AUDIT_APP_ID, ESCALATION_APP_ID"
    ]


@pytest.mark.parametrize(
    ("entry", "message"),
    [
        ("not-a-dict", "contains a non-object entry"),
        ({}, "contains an entry without a name"),
        ({"name": ""}, "contains an entry without a name"),
        ({"name": 7}, "contains an entry without a name"),
    ],
    ids=["non-object", "missing-name", "empty-name", "non-string-name"],
)
def test_an_unreadable_inventory_entry_is_a_failure_to_look(entry: object, message: str) -> None:
    """A malformed entry makes the inventory unreadable even beside the expected item."""
    with pytest.raises(GhError, match=message):
        _audit(variables={"variables": [entry, {"name": "APP_ID"}]})


@pytest.mark.parametrize(
    "payload", [{}, {"variables": "not-a-list"}], ids=["absent", "wrong-shape"]
)
def test_an_inventory_response_without_a_list_is_a_failure_to_look(payload: object) -> None:
    """An empty answer and an unusable one are different; only the first is drift."""
    with pytest.raises(GhError, match="must include a variables list"):
        _audit(variables=payload)


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"repository": []}, "repository metadata must be a JSON object"),
        ({"protection": []}, "branch protection for main must be a JSON object"),
        ({"variables": []}, "Actions variables must be a JSON object"),
        ({"secrets": []}, "Actions secrets must be a JSON object"),
    ],
    ids=["repository", "protection", "variables", "secrets"],
)
def test_a_response_that_is_not_an_object_fails_the_audit(kwargs: object, message: str) -> None:
    """Every fetch is shape-checked, so no expectation is skipped over silently."""
    with pytest.raises(GhError, match=message):
        _audit(**kwargs)  # type: ignore[arg-type]


# ─── Findings can accumulate ─────────────────────────────────────────────────


def test_every_drifted_setting_is_reported_in_one_pass() -> None:
    """One run has to name all of them; fixing them one round trip at a time is worse."""
    findings = _audit(
        repository=_repository(default_branch="master"),
        protection=_protection(required_signatures={"enabled": False}),
        secrets={"secrets": []},
    )
    assert findings == [
        "default branch is 'master' instead of 'main'",
        "main branch protection does not require signed commits",
        "missing repository secrets: "
        "APP_PRIVATE_KEY, AUDIT_APP_PRIVATE_KEY, ESCALATION_APP_PRIVATE_KEY",
    ]


# ─── The command line ────────────────────────────────────────────────────────


def _patch_audit(monkeypatch: pytest.MonkeyPatch, result: object) -> None:
    """Replace the audit with one returning ``result`` or raising it."""

    def fake_audit(**_kwargs: object) -> list[str]:
        if isinstance(result, Exception):
            raise result
        assert isinstance(result, list)
        return result

    monkeypatch.setattr(repo_audit, "audit_repo_settings", fake_audit)


def test_a_clean_audit_exits_healthy(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """The healthy path has to stay distinguishable from the other two codes."""
    _patch_audit(monkeypatch, [])
    assert repo_audit.main(["--repo", REPO]) == repo_audit.EXIT_HEALTHY
    assert "match expectations" in capsys.readouterr().out


def test_drift_exits_with_its_own_code_and_lists_the_findings(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """The exit code is the verdict; the list is what makes it actionable."""
    _patch_audit(monkeypatch, ["push protection is off"])
    assert repo_audit.main(["--repo", REPO]) == repo_audit.EXIT_DRIFT_FOUND
    assert "- push protection is off" in capsys.readouterr().out


def test_a_failure_to_look_exits_differently_from_drift(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """A caller must never read an infrastructure failure as a verdict about the settings."""
    _patch_audit(monkeypatch, GhError("token missing a permission"))
    assert repo_audit.main(["--repo", REPO]) == repo_audit.EXIT_CHECK_FAILED
    error = capsys.readouterr().err
    assert "could not complete" in error
    assert "administration: read" in error


def test_the_repository_is_resolved_when_none_is_given(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """The everyday invocation passes no repo at all."""
    _patch_audit(monkeypatch, [])
    monkeypatch.setattr(repo_audit.gh_runner, "resolve_repo", lambda: REPO)
    assert repo_audit.main([]) == repo_audit.EXIT_HEALTHY
    assert REPO in capsys.readouterr().out


@pytest.mark.parametrize(
    ("reached_verdict", "expected"),
    [(True, "checked=true"), (False, "checked=false")],
    ids=["reached", "could-not-look"],
)
def test_the_verdict_reaches_the_workflow_as_an_output(
    tmp_path: Path, reached_verdict: bool, expected: str
) -> None:
    """The alert jobs pick their state on this bit, which no exit code can carry."""
    output = tmp_path / "github-output"

    repo_audit.report_checked(reached_verdict, env={repo_audit.GITHUB_OUTPUT_ENV: str(output)})

    assert output.read_text(encoding="utf-8") == f"{expected}\n"


def test_the_verdict_is_appended_beside_any_other_step_output(tmp_path: Path) -> None:
    """One file collects every output of the step; truncating it would drop the others."""
    output = tmp_path / "github-output"
    output.write_text("already=here\n", encoding="utf-8")

    repo_audit.report_checked(True, env={repo_audit.GITHUB_OUTPUT_ENV: str(output)})

    assert output.read_text(encoding="utf-8") == "already=here\nchecked=true\n"


@pytest.mark.parametrize("env", [{}, {"GITHUB_OUTPUT": ""}], ids=["unset", "empty"])
def test_nothing_is_written_outside_github_actions(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, env: dict[str, str]
) -> None:
    """`make ci-audit-repo-settings` at a terminal has no output file to write to.

    A real path is left in the process environment so the assertion has
    something to catch: writing anywhere at all would create it.
    """
    unwanted = tmp_path / "should-not-be-written"
    monkeypatch.setenv(repo_audit.GITHUB_OUTPUT_ENV, str(unwanted))

    repo_audit.report_checked(True, env=env)

    assert not unwanted.exists()


def test_a_drift_verdict_is_reported_as_reached(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Drift is a verdict, so it must not be mistaken for the audit failing to look."""
    output = tmp_path / "github-output"
    monkeypatch.setenv(repo_audit.GITHUB_OUTPUT_ENV, str(output))
    _patch_audit(monkeypatch, ["allow_merge_commit should be disabled"])

    assert repo_audit.main(["--repo", REPO]) == repo_audit.EXIT_DRIFT_FOUND
    capsys.readouterr()

    assert output.read_text(encoding="utf-8") == "checked=true\n"


def test_a_failure_to_look_is_reported_as_unchecked(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Collapsing this into drift would alert on settings the audit never read."""
    output = tmp_path / "github-output"
    monkeypatch.setenv(repo_audit.GITHUB_OUTPUT_ENV, str(output))
    _patch_audit(monkeypatch, GhError("token missing a permission"))

    assert repo_audit.main(["--repo", REPO]) == repo_audit.EXIT_CHECK_FAILED
    capsys.readouterr()

    assert output.read_text(encoding="utf-8") == "checked=false\n"


@pytest.mark.parametrize(
    "omitted",
    sorted(repo_audit.JUDGED_REPOSITORY_FIELDS),
)
def test_a_field_the_response_omitted_is_a_failure_to_look(omitted: str) -> None:
    """GitHub returns a reduced repository object to a token without the access a field needs.

    Treating the absence as `false` would raise a drift alert about a setting
    that is in fact correct, which is the opposite of this audit's contract.
    """
    payload = {key: value for key, value in _repository().items() if key != omitted}

    with pytest.raises(GhError, match=f"omitted {omitted}|omitted .*{omitted}"):
        repo_audit.audit_repository(payload, default_branch="main")


def test_the_unreadable_fields_are_all_named_at_once(monkeypatch: pytest.MonkeyPatch) -> None:
    """One run should name every field the token could not read, not just the first.

    The judged set is one field today, so the set is widened here rather than
    letting the message-building go untested until a second field is added.
    """
    monkeypatch.setattr(
        repo_audit, "JUDGED_REPOSITORY_FIELDS", frozenset({"default_branch", "homepage", "topics"})
    )
    payload = {
        key: value for key, value in _repository().items() if key not in {"homepage", "topics"}
    }

    with pytest.raises(GhError) as excinfo:
        repo_audit.audit_repository(payload, default_branch="main")

    assert "omitted homepage, topics" in str(excinfo.value)
