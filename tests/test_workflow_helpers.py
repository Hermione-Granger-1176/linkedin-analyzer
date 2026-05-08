from __future__ import annotations

from pathlib import Path

import pytest
from scripts.ci.workflow_helpers import (
    app_token_allowed,
    read_lock_refresh_metadata,
    validate_lock_refresh_artifact,
)


def write_valid_lock_artifact(root: Path) -> None:
    """Create the expected lock refresh artifact shape."""
    artifact_dir = root / ".artifacts"
    artifact_dir.mkdir()
    (root / "uv.lock").write_text("version = 1\n", encoding="utf-8")
    (artifact_dir / "pr-number.txt").write_text("123\n", encoding="utf-8")
    (artifact_dir / "head-sha.txt").write_text("abc123\n", encoding="utf-8")
    (artifact_dir / "head-ref.txt").write_text("dependabot/example\n", encoding="utf-8")


def test_app_token_policy_blocks_untrusted_pull_requests() -> None:
    """Block token minting for fork and Dependabot pull requests."""
    assert not app_token_allowed(
        event_name="pull_request",
        head_repo_fork=True,
        pr_author="contributor",
    )
    assert not app_token_allowed(
        event_name="pull_request",
        head_repo_fork=False,
        pr_author="dependabot[bot]",
    )


def test_app_token_policy_allows_trusted_events() -> None:
    """Allow token minting outside untrusted pull request contexts."""
    assert app_token_allowed(
        event_name="schedule",
        head_repo_fork=True,
        pr_author="dependabot[bot]",
    )
    assert app_token_allowed(
        event_name="pull_request",
        head_repo_fork=False,
        pr_author="maintainer",
    )


def test_validate_lock_refresh_artifact_accepts_expected_files(tmp_path: Path) -> None:
    """Accept the exact lock artifact shape produced by the refresh workflow."""
    write_valid_lock_artifact(tmp_path)

    validate_lock_refresh_artifact(tmp_path)


def test_validate_lock_refresh_artifact_rejects_symlink(tmp_path: Path) -> None:
    """Reject symlinks before artifact contents are copied into the workspace."""
    write_valid_lock_artifact(tmp_path)
    (tmp_path / ".artifacts" / "linked-lock").symlink_to(tmp_path / "uv.lock")

    with pytest.raises(ValueError, match="Artifact contains a symlink"):
        validate_lock_refresh_artifact(tmp_path)


def test_validate_lock_refresh_artifact_rejects_unexpected_files(tmp_path: Path) -> None:
    """Reject extra files in the downloaded artifact tree."""
    write_valid_lock_artifact(tmp_path)
    (tmp_path / ".artifacts" / "extra.txt").write_text("unexpected\n", encoding="utf-8")

    with pytest.raises(ValueError, match=r"Unexpected file\(s\).*extra.txt"):
        validate_lock_refresh_artifact(tmp_path)


def test_validate_lock_refresh_artifact_rejects_missing_required_files(tmp_path: Path) -> None:
    """Reject artifacts that omit required metadata files."""
    write_valid_lock_artifact(tmp_path)
    (tmp_path / ".artifacts" / "head-sha.txt").unlink()

    with pytest.raises(ValueError, match="Required artifact file missing"):
        validate_lock_refresh_artifact(tmp_path)


def test_read_lock_refresh_metadata_strips_expected_values(tmp_path: Path) -> None:
    """Read and trim lock-refresh metadata values."""
    write_valid_lock_artifact(tmp_path)

    assert read_lock_refresh_metadata(tmp_path) == {
        "pr-number": "123",
        "head-sha": "abc123",
        "head-ref": "dependabot/example",
    }
