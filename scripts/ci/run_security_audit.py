#!/usr/bin/env python3
"""Run a policy-driven Python dependency security audit for exported requirements.

A bare ``pip-audit --strict`` fails the build on any advisory, including
triaged transitive ones, with no principled override. This module wraps
``pip-audit --strict --format json`` with a reviewed-exception policy:
exceptions expire on a ``review_by`` date, an exception is evicted once a fix
becomes available (when it was granted only while unfixed), and unused
exceptions are reported so the allow-list never rots.

``--strict`` semantics are preserved twice over: the flag is always passed, and
any dependency pip-audit reports as skipped is surfaced as an audit error.

Exceptions live under ``python_vulnerability_exceptions`` in
``config/security_audit.json``.
"""

from __future__ import annotations

import argparse
import json
import shlex
import subprocess
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from scripts import REPO_ROOT

SECURITY_AUDIT_CONFIG_FILE = REPO_ROOT / "config" / "security_audit.json"

# Default pip-audit invocation. The Makefile overrides this with the uv-managed
# form so the audit runs against the same resolver that produced the lock.
DEFAULT_PIP_AUDIT_COMMAND = "pip-audit"


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
        """Return the unique identity for this exception entry."""
        return (self.package.lower(), self.vulnerability_id)


@dataclass(frozen=True)
class VulnerabilityFinding:
    """One vulnerability reported by pip-audit."""

    vulnerability_id: str
    aliases: tuple[str, ...]
    package: str
    version: str
    fix_versions: tuple[str, ...]

    @property
    def all_ids(self) -> tuple[str, ...]:
        """Return the primary vulnerability id plus aliases."""
        return (self.vulnerability_id, *self.aliases)


def _relative_path(path: Path) -> str:
    """Return a repo-relative path string, or the original path."""
    try:
        return str(path.relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


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


PYTHON_EXCEPTIONS_KEY = "python_vulnerability_exceptions"
NPM_EXCEPTIONS_KEY = "npm_vulnerability_exceptions"


def _load_security_audit_exceptions(
    config_file: Path = SECURITY_AUDIT_CONFIG_FILE,
    *,
    config_key: str = PYTHON_EXCEPTIONS_KEY,
) -> tuple[VulnerabilityExceptionEntry, ...]:
    """Load reviewed vulnerability exceptions for one ecosystem from the config.

    Args:
        config_file: Path to the shared security audit JSON config.
        config_key: Top-level key holding the ecosystem's exception list (for
            example ``python_vulnerability_exceptions`` or
            ``npm_vulnerability_exceptions``).
    """
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


def _parse_vulnerability(
    vulnerability: object,
    *,
    package: str,
    version: str,
    requirements_file: Path,
) -> VulnerabilityFinding:
    """Parse one pip-audit vulnerability entry into a finding."""
    relative_requirements_file = _relative_path(requirements_file)
    if not isinstance(vulnerability, dict):
        raise ValueError(
            f"pip-audit vulnerabilities must be objects for {relative_requirements_file}"
        )

    aliases = vulnerability.get("aliases", [])
    if not isinstance(aliases, list) or not all(isinstance(alias, str) for alias in aliases):
        raise ValueError(f"pip-audit aliases must be string lists for {relative_requirements_file}")

    fix_versions = vulnerability.get("fix_versions", [])
    if not isinstance(fix_versions, list) or not all(
        isinstance(fix_version, str) for fix_version in fix_versions
    ):
        raise ValueError(
            f"pip-audit fix_versions must be string lists for {relative_requirements_file}"
        )

    return VulnerabilityFinding(
        vulnerability_id=str(vulnerability.get("id", "")),
        aliases=tuple(aliases),
        package=package,
        version=version,
        fix_versions=tuple(fix_versions),
    )


def _skipped_dependency(dependency: object, requirements_file: Path) -> str | None:
    """Return a ``--strict`` error for a dependency pip-audit could not audit.

    ``pip-audit --strict`` exits non-zero when it skips a dependency, but its
    exit code is indistinguishable from "vulnerabilities found". The skip is
    also recorded in the JSON report, so read it from there instead.
    """
    if not isinstance(dependency, dict):
        return None

    skip_reason = dependency.get("skip_reason")
    if not skip_reason:
        return None

    return (
        f"pip-audit skipped {dependency.get('name', '<unknown>')} in "
        f"{_relative_path(requirements_file)}: {skip_reason}"
    )


def _parse_dependency_findings(
    dependency: object, requirements_file: Path
) -> tuple[VulnerabilityFinding, ...]:
    """Parse all pip-audit findings for one dependency entry."""
    relative_requirements_file = _relative_path(requirements_file)
    if not isinstance(dependency, dict):
        raise ValueError(
            f"pip-audit dependency entries must be objects for {relative_requirements_file}"
        )

    vulns = dependency.get("vulns", [])
    if not isinstance(vulns, list):
        raise ValueError(
            f"pip-audit dependency vulns must be a list for {relative_requirements_file}"
        )

    package = str(dependency.get("name", ""))
    version = str(dependency.get("version", ""))
    return tuple(
        _parse_vulnerability(
            vulnerability,
            package=package,
            version=version,
            requirements_file=requirements_file,
        )
        for vulnerability in vulns
    )


def _run_pip_audit(
    requirements_file: Path, *, pip_audit_command: str = DEFAULT_PIP_AUDIT_COMMAND
) -> tuple[tuple[VulnerabilityFinding, ...], tuple[str, ...]]:
    """Run pip-audit for one requirements file and return findings and skip errors.

    ``pip_audit_command`` is a shell-style command string, so an override may
    carry a launcher (for example ``uv run --with pip-audit pip-audit``). It is
    split with :func:`shlex.split` before the fixed audit arguments are
    appended; ``--strict`` is always among them.
    """
    command = [
        *shlex.split(pip_audit_command),
        "--strict",
        "--requirement",
        str(requirements_file),
        "--format",
        "json",
        "--progress-spinner",
        "off",
    ]
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            check=False,
            text=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            f"pip-audit timed out after 120 seconds for {_relative_path(requirements_file)}"
        ) from exc
    except FileNotFoundError as exc:
        raise RuntimeError(
            f"pip-audit executable not found: {pip_audit_command}. Run `make setup` first."
        ) from exc
    if result.returncode not in {0, 1}:
        stderr = result.stderr.strip() or result.stdout.strip() or "unknown error"
        raise RuntimeError(f"pip-audit failed for {_relative_path(requirements_file)}: {stderr}")

    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"pip-audit returned invalid JSON for {_relative_path(requirements_file)}"
        ) from exc

    dependencies = payload.get("dependencies")
    if not isinstance(dependencies, list):
        raise ValueError(
            f"pip-audit JSON for {_relative_path(requirements_file)} "
            "must include a dependencies list"
        )

    skipped = tuple(
        error
        for dependency in dependencies
        if (error := _skipped_dependency(dependency, requirements_file)) is not None
    )
    findings = tuple(
        finding
        for dependency in dependencies
        if not (isinstance(dependency, dict) and dependency.get("skip_reason"))
        for finding in _parse_dependency_findings(dependency, requirements_file)
    )
    return findings, skipped


def _matches_exception(
    exception: VulnerabilityExceptionEntry, finding: VulnerabilityFinding
) -> bool:
    """Return whether a reviewed exception matches one vulnerability finding."""
    return (
        exception.package.lower() == finding.package.lower()
        and exception.vulnerability_id in finding.all_ids
    )


def _audit_python_dependencies(
    *,
    today: date,
    exceptions: tuple[VulnerabilityExceptionEntry, ...],
    requirements_file: Path,
    pip_audit_command: str = DEFAULT_PIP_AUDIT_COMMAND,
) -> tuple[
    tuple[tuple[VulnerabilityFinding, VulnerabilityExceptionEntry], ...],
    tuple[str, ...],
]:
    """Run policy checks for the exported requirements file."""
    ignored: list[tuple[VulnerabilityFinding, VulnerabilityExceptionEntry]] = []
    matched_exception_keys: set[tuple[str, str]] = set()

    findings, skipped = _run_pip_audit(requirements_file, pip_audit_command=pip_audit_command)
    errors: list[str] = list(skipped)

    for finding in findings:
        matching_exceptions = tuple(
            entry for entry in exceptions if _matches_exception(entry, finding)
        )
        if not matching_exceptions:
            errors.append(
                "Unreviewed Python vulnerability: "
                f"{finding.package} {finding.version} {finding.vulnerability_id}"
            )
            continue

        matched_exception_keys.update(entry.key for entry in matching_exceptions)
        finding_errors = []
        for matching_exception in matching_exceptions:
            if today > matching_exception.review_by:
                finding_errors.append(
                    "Expired Python vulnerability exception: "
                    f"{matching_exception.package} "
                    f"{matching_exception.vulnerability_id} "
                    f"review_by={matching_exception.review_by.isoformat()}"
                )
            elif matching_exception.ignore_only_without_fix and finding.fix_versions:
                finding_errors.append(
                    "Python vulnerability exception must be removed because fixes "
                    "are available: "
                    f"{finding.package} {finding.vulnerability_id} "
                    f"fix_versions={', '.join(finding.fix_versions)}"
                )

        if finding_errors:
            errors.extend(finding_errors)
            continue

        ignored.append((finding, matching_exceptions[0]))

    for exception in exceptions:
        if exception.key not in matched_exception_keys:
            errors.append(
                "Unused Python vulnerability exception: "
                f"{exception.package} {exception.vulnerability_id}"
            )

    return tuple(ignored), tuple(errors)


def _resolve_requirements_file(requirements_file: Path) -> Path:
    """Resolve and validate the exported requirements file path."""
    resolved = (
        requirements_file if requirements_file.is_absolute() else REPO_ROOT / requirements_file
    )
    if not resolved.is_file():
        raise FileNotFoundError(f"Python security requirements file not found: {resolved}")
    return resolved


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse CLI arguments."""
    parser = argparse.ArgumentParser(description="Run the Python dependency security audit")
    parser.add_argument(
        "--requirements",
        required=True,
        type=Path,
        help="Exported requirements.txt file to audit",
    )
    parser.add_argument(
        "--pip-audit",
        default=DEFAULT_PIP_AUDIT_COMMAND,
        help=(
            "pip-audit command to invoke, split with shlex so an override may "
            "carry a launcher such as 'uv run --with pip-audit pip-audit' "
            f"(defaults to '{DEFAULT_PIP_AUDIT_COMMAND}')"
        ),
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    """Run the policy-driven Python security audit."""
    args = _parse_args(argv)
    exceptions = _load_security_audit_exceptions()
    requirements_file = _resolve_requirements_file(args.requirements)
    ignored, errors = _audit_python_dependencies(
        today=date.today(),
        exceptions=exceptions,
        requirements_file=requirements_file,
        pip_audit_command=args.pip_audit,
    )

    if ignored:
        print("Reviewed Python vulnerability exceptions:")
        for finding, exception in ignored:
            print(
                "- "
                f"{finding.package} {finding.version} "
                f"{finding.vulnerability_id} "
                f"(review by {exception.review_by.isoformat()})"
            )
            print(f"  reason: {exception.reason}")

    if errors:
        print("Python dependency audit failed:")
        for error in errors:
            print(f"- {error}")
        return 1

    print("Python dependency audit passed.")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
