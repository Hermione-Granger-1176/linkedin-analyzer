from __future__ import annotations

import os
from pathlib import Path

import pytest
from scripts.ci import workflow_helpers
from scripts.ci.workflow_helpers import (
    validate_lock_refresh_artifact,
    validate_lock_refresh_context,
)


def write_valid_lock_artifact(root: Path) -> None:
    """Create the expected lock refresh artifact shape."""
    root.mkdir(parents=True, exist_ok=True)
    (root / "uv.lock").write_text("version = 1\n", encoding="utf-8")


def test_validate_lock_refresh_artifact_accepts_expected_files(tmp_path: Path) -> None:
    """Accept the exact lock artifact shape produced by the refresh workflow."""
    write_valid_lock_artifact(tmp_path)

    validate_lock_refresh_artifact(tmp_path)


def test_validate_lock_refresh_artifact_rejects_symlink(tmp_path: Path) -> None:
    """Reject symlinks before artifact contents are copied into the workspace."""
    write_valid_lock_artifact(tmp_path)
    (tmp_path / "linked-lock").symlink_to(tmp_path / "uv.lock")

    with pytest.raises(ValueError, match="Artifact contains a symlink"):
        validate_lock_refresh_artifact(tmp_path)


def test_validate_lock_refresh_artifact_rejects_symlinked_root(tmp_path: Path) -> None:
    """Reject artifact roots that are themselves symlinks."""
    artifact_root = tmp_path / "artifact"
    write_valid_lock_artifact(artifact_root)
    linked_root = tmp_path / "linked-artifact"
    linked_root.symlink_to(artifact_root, target_is_directory=True)

    with pytest.raises(ValueError, match="Artifact root is a symlink"):
        validate_lock_refresh_artifact(linked_root)


@pytest.mark.skipif(not hasattr(os, "mkfifo"), reason="os.mkfifo is unavailable on this platform")
def test_validate_lock_refresh_artifact_rejects_special_file(tmp_path: Path) -> None:
    """Reject non-regular files (e.g. FIFOs) that slip past the file/directory checks."""
    write_valid_lock_artifact(tmp_path)
    os.mkfifo(tmp_path / "pipe")

    with pytest.raises(ValueError, match="Artifact contains a non-regular file"):
        validate_lock_refresh_artifact(tmp_path)


def test_validate_lock_refresh_artifact_rejects_unexpected_files(tmp_path: Path) -> None:
    """Reject extra files in the downloaded artifact tree."""
    write_valid_lock_artifact(tmp_path)
    (tmp_path / "extra.txt").write_text("unexpected\n", encoding="utf-8")

    with pytest.raises(ValueError, match=r"Unexpected file\(s\).*extra.txt"):
        validate_lock_refresh_artifact(tmp_path)


def test_validate_lock_refresh_artifact_rejects_legacy_metadata_files(tmp_path: Path) -> None:
    """Reject artifact metadata that could otherwise select the writeback target."""
    write_valid_lock_artifact(tmp_path)
    metadata_dir = tmp_path / ".artifacts"
    metadata_dir.mkdir()
    (metadata_dir / "pr-number.txt").write_text("12$(touch marker)\n", encoding="utf-8")

    with pytest.raises(ValueError, match=r"Unexpected file\(s\).*pr-number.txt"):
        validate_lock_refresh_artifact(tmp_path)


def test_validate_lock_refresh_artifact_rejects_unexpected_directories(tmp_path: Path) -> None:
    """Reject empty directories so the artifact contains only the lock file."""
    write_valid_lock_artifact(tmp_path)
    (tmp_path / ".artifacts").mkdir()

    with pytest.raises(ValueError, match=r"Unexpected directory\(ies\).*\.artifacts"):
        validate_lock_refresh_artifact(tmp_path)


def test_validate_lock_refresh_artifact_rejects_missing_required_files(tmp_path: Path) -> None:
    """Reject artifacts that omit the refreshed lock file."""
    write_valid_lock_artifact(tmp_path)
    (tmp_path / "uv.lock").unlink()

    with pytest.raises(ValueError, match="Required artifact file missing"):
        validate_lock_refresh_artifact(tmp_path)


@pytest.mark.parametrize(
    ("pr_number", "head_sha", "head_ref"),
    [
        ("123", "a" * 40, "dependabot/uv/requests-2.32.0"),
        ("42", "0123456789abcdef0123456789abcdef01234567", "dependabot/uv/foo/bar-1.0"),
    ],
)
def test_validate_lock_refresh_context_accepts_expected_values(
    pr_number: str, head_sha: str, head_ref: str
) -> None:
    """Accept trusted Dependabot workflow-run context values."""
    validate_lock_refresh_context(pr_number, head_sha, head_ref)


@pytest.mark.parametrize(
    ("pr_number", "head_sha", "head_ref", "message"),
    [
        ("0", "a" * 40, "dependabot/uv/requests-2.32.0", "pull request number"),
        ("12$(touch marker)", "a" * 40, "dependabot/uv/requests-2.32.0", "pull request number"),
        ("12", "a" * 39, "dependabot/uv/requests-2.32.0", "head SHA"),
        ("12", "A" * 40, "dependabot/uv/requests-2.32.0", "head SHA"),
        ("12", "a" * 40, "feature/unsafe", "head ref"),
        ("12", "a" * 40, "dependabot/uv/$(touch marker)", "head ref"),
        ("12", "a" * 40, "dependabot/uv/unsafe\nbranch", "head ref"),
        ("12", "a" * 40, "dependabot/uv/unsafe/", "valid Git branch name"),
        ("12", "a" * 40, "dependabot/uv/unsafe..branch", "valid Git branch name"),
        ("12", "a" * 40, "dependabot/uv/unsafe//branch", "valid Git branch name"),
        ("12", "a" * 40, "dependabot/uv/.unsafe", "valid Git branch name"),
    ],
)
def test_validate_lock_refresh_context_rejects_untrusted_values(
    pr_number: str, head_sha: str, head_ref: str, message: str
) -> None:
    """Reject values that cannot safely select a trusted writeback target."""
    with pytest.raises(ValueError, match=message):
        validate_lock_refresh_context(pr_number, head_sha, head_ref)


def test_validate_lock_refresh_artifact_rejects_a_missing_root(tmp_path: Path) -> None:
    """A download that produced nothing at all is rejected by path."""
    with pytest.raises(ValueError, match="Artifact root does not exist"):
        validate_lock_refresh_artifact(tmp_path / "absent")


def test_artifact_files_skips_non_regular_entries(tmp_path: Path) -> None:
    """Entries that vanish or are not regular files are not collected."""
    root = tmp_path / "artifact"
    root.mkdir()
    (root / "uv.lock").write_text("version = 1\n", encoding="utf-8")
    os.mkfifo(root / "pipe")

    assert workflow_helpers._artifact_files(root) == {Path("uv.lock")}


def test_main_validates_a_lock_artifact(tmp_path: Path) -> None:
    """The validate-lock-artifact subcommand exits zero for a valid tree."""
    root = tmp_path / "artifact"
    write_valid_lock_artifact(root)

    assert workflow_helpers.main(["validate-lock-artifact", "--root", str(root)]) == 0


def test_main_rejects_an_invalid_lock_artifact(tmp_path: Path) -> None:
    """The validate-lock-artifact subcommand surfaces validation errors."""
    root = tmp_path / "artifact"
    root.mkdir()

    with pytest.raises(ValueError, match="missing"):
        workflow_helpers.main(["validate-lock-artifact", "--root", str(root)])


def test_main_validates_a_lock_context() -> None:
    """The validate-lock-context subcommand exits zero for trusted values."""
    exit_code = workflow_helpers.main(
        [
            "validate-lock-context",
            "--pr-number",
            "42",
            "--head-sha",
            "a" * 40,
            "--head-ref",
            "dependabot/uv/requests-2.32.0",
        ]
    )

    assert exit_code == 0


def test_main_rejects_an_untrusted_lock_context() -> None:
    """The validate-lock-context subcommand surfaces validation errors."""
    with pytest.raises(ValueError, match="head ref"):
        workflow_helpers.main(
            [
                "validate-lock-context",
                "--pr-number",
                "42",
                "--head-sha",
                "a" * 40,
                "--head-ref",
                "feature/unsafe",
            ]
        )
