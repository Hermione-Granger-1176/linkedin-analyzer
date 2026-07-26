from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest
from scripts.ci import security_audit_policy


def _write_config(path: Path, content: str) -> Path:
    """Write one security-audit test configuration."""
    path.write_text(content, encoding="utf-8")
    return path


def test_load_exceptions_reads_valid_config(tmp_path: Path) -> None:
    """Valid entries are parsed into immutable policy objects."""
    config_file = _write_config(
        tmp_path / "security_audit.json",
        """
{
  "npm_vulnerability_exceptions": [
    {
      "id": "GHSA-aaaa-bbbb-cccc",
      "package": "left-pad",
      "reason": "No patched release yet.",
      "review_by": "2026-08-25",
      "ignore_only_without_fix": true
    },
    {
      "id": "42",
      "package": "other-package",
      "reason": "Upgrade is being tested.",
      "review_by": "2026-09-01"
    }
  ]
}
""".strip(),
    )

    exceptions = security_audit_policy.load_security_audit_exceptions(
        config_file,
        config_key=security_audit_policy.NPM_EXCEPTIONS_KEY,
    )

    assert len(exceptions) == 2
    assert exceptions[0].review_by == date(2026, 8, 25)
    assert exceptions[0].ignore_only_without_fix is True
    assert exceptions[0].key == ("left-pad", "ghsa-aaaa-bbbb-cccc")
    assert exceptions[1].ignore_only_without_fix is False


def test_load_config_rejects_missing_file(tmp_path: Path) -> None:
    """A missing policy file fails closed."""
    with pytest.raises(FileNotFoundError, match="Security audit config file not found"):
        security_audit_policy._load_security_audit_config(tmp_path / "missing.json")


def test_load_config_rejects_non_object_root(tmp_path: Path) -> None:
    """The policy root must be an object."""
    config_file = _write_config(tmp_path / "security_audit.json", "[]")

    with pytest.raises(ValueError, match="must be a JSON object"):
        security_audit_policy._load_security_audit_config(config_file)


def test_load_exceptions_defaults_missing_ecosystem_to_empty(tmp_path: Path) -> None:
    """An omitted ecosystem has no reviewed exceptions."""
    config_file = _write_config(tmp_path / "security_audit.json", "{}")

    assert (
        security_audit_policy.load_security_audit_exceptions(
            config_file,
            config_key=security_audit_policy.NPM_EXCEPTIONS_KEY,
        )
        == ()
    )


def test_load_exceptions_rejects_non_list(tmp_path: Path) -> None:
    """Each ecosystem entry must be a list."""
    config_file = _write_config(
        tmp_path / "security_audit.json",
        '{"npm_vulnerability_exceptions": {}}',
    )

    with pytest.raises(ValueError, match="'npm_vulnerability_exceptions' must be a list"):
        security_audit_policy.load_security_audit_exceptions(
            config_file,
            config_key=security_audit_policy.NPM_EXCEPTIONS_KEY,
        )


def test_load_exceptions_rejects_non_object_entry(tmp_path: Path) -> None:
    """Every list item must be an object."""
    config_file = _write_config(
        tmp_path / "security_audit.json",
        '{"npm_vulnerability_exceptions": ["bad"]}',
    )

    with pytest.raises(ValueError, match="must be objects"):
        security_audit_policy.load_security_audit_exceptions(
            config_file,
            config_key=security_audit_policy.NPM_EXCEPTIONS_KEY,
        )


def test_load_exceptions_rejects_missing_required_fields(tmp_path: Path) -> None:
    """Required policy fields cannot be empty or absent."""
    config_file = _write_config(
        tmp_path / "security_audit.json",
        '{"npm_vulnerability_exceptions": [{"id": "GHSA-aaaa-bbbb-cccc"}]}',
    )

    with pytest.raises(ValueError, match="must include package, reason, review_by"):
        security_audit_policy.load_security_audit_exceptions(
            config_file,
            config_key=security_audit_policy.NPM_EXCEPTIONS_KEY,
        )


def test_load_exceptions_rejects_invalid_review_date(tmp_path: Path) -> None:
    """Review dates must use the stable ISO format."""
    config_file = _write_config(
        tmp_path / "security_audit.json",
        """
{
  "npm_vulnerability_exceptions": [{
    "id": "42",
    "package": "left-pad",
    "reason": "No fix.",
    "review_by": "08-25-2026"
  }]
}
""".strip(),
    )

    with pytest.raises(ValueError, match=r"review_by.*YYYY-MM-DD"):
        security_audit_policy.load_security_audit_exceptions(
            config_file,
            config_key=security_audit_policy.NPM_EXCEPTIONS_KEY,
        )


def test_load_exceptions_rejects_non_boolean_fix_policy(tmp_path: Path) -> None:
    """The fix-availability policy must be an actual boolean."""
    config_file = _write_config(
        tmp_path / "security_audit.json",
        """
{
  "npm_vulnerability_exceptions": [{
    "id": "42",
    "package": "left-pad",
    "reason": "No fix.",
    "review_by": "2026-08-25",
    "ignore_only_without_fix": "yes"
  }]
}
""".strip(),
    )

    with pytest.raises(ValueError, match="must be a boolean"):
        security_audit_policy.load_security_audit_exceptions(
            config_file,
            config_key=security_audit_policy.NPM_EXCEPTIONS_KEY,
        )


def test_load_exceptions_rejects_case_variant_duplicates(tmp_path: Path) -> None:
    """Case variants cannot create two policies for the same advisory."""
    config_file = _write_config(
        tmp_path / "security_audit.json",
        """
{
  "npm_vulnerability_exceptions": [
    {
      "id": "GHSA-AAAA-BBBB-CCCC",
      "package": "Left-Pad",
      "reason": "No fix.",
      "review_by": "2026-08-25"
    },
    {
      "id": "ghsa-aaaa-bbbb-cccc",
      "package": "left-pad",
      "reason": "Duplicate.",
      "review_by": "2026-09-01"
    }
  ]
}
""".strip(),
    )

    with pytest.raises(ValueError, match=r"must not duplicate.*\[1\]"):
        security_audit_policy.load_security_audit_exceptions(
            config_file,
            config_key=security_audit_policy.NPM_EXCEPTIONS_KEY,
        )
