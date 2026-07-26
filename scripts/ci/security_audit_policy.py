"""Shared configuration policy for dependency security audits."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SECURITY_AUDIT_CONFIG_FILE = REPO_ROOT / "config" / "security_audit.json"

NPM_EXCEPTIONS_KEY = "npm_vulnerability_exceptions"


@dataclass(frozen=True)
class VulnerabilityExceptionEntry:
    """One reviewed vulnerability exception entry for a package."""

    vulnerability_id: str
    package: str
    reason: str
    review_by: date
    ignore_only_without_fix: bool

    @property
    def key(self) -> tuple[str, str]:
        """Return the case-insensitive identity for this exception entry."""
        return (self.package.casefold(), self.vulnerability_id.casefold())


def _load_security_audit_config(
    config_file: Path = SECURITY_AUDIT_CONFIG_FILE,
) -> dict[str, object]:
    """Load the full security audit JSON config."""
    if not config_file.exists():
        raise FileNotFoundError(f"Security audit config file not found: {config_file}")

    payload = json.loads(config_file.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Security audit config must be a JSON object")
    return payload


def load_security_audit_exceptions(
    config_file: Path = SECURITY_AUDIT_CONFIG_FILE,
    *,
    config_key: str,
) -> tuple[VulnerabilityExceptionEntry, ...]:
    """Load and validate reviewed exceptions for one package ecosystem."""
    payload = _load_security_audit_config(config_file)
    entries = payload.get(config_key, [])
    if not isinstance(entries, list):
        raise ValueError(f"Security audit config '{config_key}' must be a list")

    exceptions: list[VulnerabilityExceptionEntry] = []
    seen_keys: set[tuple[str, str]] = set()
    for index, entry in enumerate(entries):
        entry_path = f"{config_key}[{index}]"
        if not isinstance(entry, dict):
            raise ValueError(f"Security audit exceptions must be objects: {entry_path}")

        required_fields = ("id", "package", "reason", "review_by")
        missing = [field for field in required_fields if not entry.get(field)]
        if missing:
            raise ValueError(
                "Security audit exceptions must include " + ", ".join(missing) + f": {entry_path}"
            )

        ignore_only_without_fix = entry.get("ignore_only_without_fix", False)
        if not isinstance(ignore_only_without_fix, bool):
            raise ValueError(
                "Security audit exception 'ignore_only_without_fix' must be a "
                f"boolean: {entry_path}"
            )

        try:
            review_by = date.fromisoformat(str(entry["review_by"]))
        except ValueError as exc:
            raise ValueError(
                f"Security audit exception 'review_by' must use YYYY-MM-DD: {entry_path}"
            ) from exc

        exception = VulnerabilityExceptionEntry(
            vulnerability_id=str(entry["id"]),
            package=str(entry["package"]),
            reason=str(entry["reason"]),
            review_by=review_by,
            ignore_only_without_fix=ignore_only_without_fix,
        )
        if exception.key in seen_keys:
            raise ValueError(
                "Security audit exceptions must not duplicate a package and "
                f"vulnerability id pair: {entry_path}"
            )
        seen_keys.add(exception.key)
        exceptions.append(exception)

    return tuple(exceptions)
