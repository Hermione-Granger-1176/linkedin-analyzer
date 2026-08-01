"""Cover the GitHub repository settings audit.

The audit exists because these settings live outside the repository, so nothing
else in this project can notice them changing. The tests therefore care most
about the two ways it could go quiet: reporting a setting as correct when the
payload never actually said so, and treating removed branch protection (the
worst drift there is) as a failure to look rather than a finding.
"""

from __future__ import annotations

import json

import pytest
from scripts.ci import repo_audit
from scripts.gh.gh_runner import GhError

from tests.support.gh import FakeGh, completed_process, has

REPO = "owner/name"
REPO_PATH = f"repos/{REPO}"
PROTECTION_PATH = f"{REPO_PATH}/branches/main/protection"
VARIABLES_PATH = f"{REPO_PATH}/actions/variables"
SECRETS_PATH = f"{REPO_PATH}/actions/secrets"
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


def _repository(**overrides: object) -> dict[str, object]:
    """Return the healthy repository payload with fields replaced."""
    return {**HEALTHY_REPOSITORY, **overrides}


def _protection(**overrides: object) -> dict[str, object]:
    """Return the healthy branch protection payload with fields replaced."""
    return {**HEALTHY_PROTECTION, **overrides}


def _runner(
    *,
    repository: object = None,
    protection: object = None,
    variables: object = None,
    secrets: object = None,
) -> FakeGh:
    """Return a fake gh runner answering all four audit calls.

    Any argument may be an exception, which the fake raises for that call.
    """
    return FakeGh(
        [
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
    """All four payloads are fetched, so no expectation is silently unchecked."""
    runner = _runner()
    repo_audit.audit_repo_settings(repo=REPO, run_fn=runner)
    requested = {call[-1] for call in runner.calls}
    assert requested == {REPO_PATH, PROTECTION_PATH, VARIABLES_PATH, SECRETS_PATH}


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


@pytest.mark.parametrize(("method", "expected"), sorted(repo_audit.EXPECTED_MERGE_METHODS.items()))
def test_each_merge_method_is_reported_when_it_flips(method: str, expected: bool) -> None:
    """Squash-only is what makes one pull request equal one commit on main."""
    findings = _audit(repository=_repository(**{method: not expected}))
    state = "enabled" if expected else "disabled"
    assert findings == [f"{method} should be {state}"]


def test_branches_that_survive_a_merge_are_reported() -> None:
    """Automatic deletion is what keeps merged work from accumulating as stale branches."""
    findings = _audit(repository=_repository(delete_branch_on_merge=False))
    assert findings == ["merged branches are not deleted automatically"]


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


# ─── Actions inventory ───────────────────────────────────────────────────────


def test_a_missing_variable_is_reported() -> None:
    """Without it the writeback workflows degrade into a silent skip."""
    assert _audit(variables={"variables": []}) == [
        "missing repository variables: APP_ID, ESCALATION_APP_ID"
    ]


def test_a_missing_secret_is_reported() -> None:
    """Without it the writeback workflows degrade into a silent skip."""
    assert _audit(secrets={"secrets": []}) == [
        "missing repository secrets: APP_PRIVATE_KEY, ESCALATION_APP_PRIVATE_KEY"
    ]


def test_a_missing_escalation_credential_alone_is_reported() -> None:
    """The primary app being healthy must not hide an absent escalation app."""
    assert _audit(variables={"variables": [{"name": "APP_ID"}]}) == [
        "missing repository variables: ESCALATION_APP_ID"
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
        repository=_repository(delete_branch_on_merge=False, allow_merge_commit=True),
        protection=_protection(required_signatures={"enabled": False}),
        secrets={"secrets": []},
    )
    assert findings == [
        "allow_merge_commit should be disabled",
        "merged branches are not deleted automatically",
        "main branch protection does not require signed commits",
        "missing repository secrets: APP_PRIVATE_KEY, ESCALATION_APP_PRIVATE_KEY",
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
