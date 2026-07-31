#!/usr/bin/env python3
"""Refresh external CI tool and runtime pins that Dependabot cannot couple."""

from __future__ import annotations

import json
import os
import re
import sys
import time
from collections.abc import Callable
from pathlib import Path
from urllib.request import Request, urlopen

from scripts.ci import refresh_action_shas

REPO_ROOT = Path()
MAKEFILE_PATH = REPO_ROOT / "Makefile"
PACKAGE_LOCK_PATH = REPO_ROOT / "package-lock.json"
PRE_COMMIT_PATH = REPO_ROOT / ".pre-commit-config.yaml"

PLAYWRIGHT_IMAGE_PATTERN = re.compile(
    r"(?m)^PLAYWRIGHT_CI_IMAGE := "
    r"mcr\.microsoft\.com/playwright:v[^-\s]+-noble@sha256:[0-9a-f]{64}$"
)
# uv is deliberately absent: tool.uv.required-version is a floor, and a floor
# that is rewritten to the newest release every week is not a floor. Raise it by
# hand when something actually needs a newer uv.
PRE_COMMIT_HOOKS_PATTERN = re.compile(
    r"(?m)(^\s*-\s+repo:\s+https://github\.com/pre-commit/pre-commit-hooks\s*$"
    r".*?^\s+rev:\s*)\S+",
    re.DOTALL,
)
SEMVER_PATTERN = re.compile(r"v?([0-9]+\.[0-9]+\.[0-9]+)")
DIGEST_PATTERN = re.compile(r"sha256:[0-9a-f]{64}")

FetchText = Callable[[], str]


def retry(
    fetch: FetchText, *, attempts: int = 3, sleep: Callable[[float], None] = time.sleep
) -> str:
    """Return a fetched value with bounded backoff for transient registry failures."""
    if attempts < 1:
        raise ValueError("attempts must be at least 1")
    for attempt in range(1, attempts):
        try:
            return fetch()
        except Exception:
            sleep(attempt * 0.25)
    return fetch()


def github_latest_version(repo: str, *, token: str, timeout: float = 15) -> str:
    """Return the stable semantic version from a repository's latest GitHub release."""
    request = Request(
        f"https://api.github.com/repos/{repo}/releases/latest",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
        },
    )
    with urlopen(request, timeout=timeout) as response:
        payload = json.load(response)
    tag = payload.get("tag_name") if isinstance(payload, dict) else None
    match = SEMVER_PATTERN.fullmatch(tag) if isinstance(tag, str) else None
    if match is None:
        raise ValueError(f"GitHub returned an invalid latest release tag for {repo}")
    return match.group(1)


def locked_playwright_version(path: Path) -> str:
    """Read the exact installed Playwright test version from package-lock.json."""
    payload = json.loads(path.read_text(encoding="utf-8"))
    version = payload.get("packages", {}).get("node_modules/@playwright/test", {}).get("version")
    if not isinstance(version, str) or SEMVER_PATTERN.fullmatch(version) is None:
        raise ValueError("package-lock.json has no exact @playwright/test semantic version")
    return version


def registry_digest(image: str, *, timeout: float = 15) -> str:
    """Resolve an MCR Playwright tag to its immutable OCI manifest digest."""
    prefix = "mcr.microsoft.com/playwright:"
    if not image.startswith(prefix) or not image.removeprefix(prefix):
        raise ValueError(f"Unsupported Playwright image reference: {image}")
    tag = image.removeprefix(prefix)
    request = Request(
        f"https://mcr.microsoft.com/v2/playwright/manifests/{tag}",
        method="HEAD",
        headers={
            "Accept": (
                "application/vnd.oci.image.index.v1+json, "
                "application/vnd.docker.distribution.manifest.list.v2+json"
            )
        },
    )
    with urlopen(request, timeout=timeout) as response:
        digest = response.headers.get("Docker-Content-Digest")
    if not isinstance(digest, str) or DIGEST_PATTERN.fullmatch(digest) is None:
        raise ValueError(f"MCR returned an invalid digest for {image}")
    return digest


def replace_one(path: Path, pattern: re.Pattern[str], replacement: str, *, label: str) -> bool:
    """Replace one required pin and report whether the file changed."""
    text = path.read_text(encoding="utf-8")
    new_text, count = pattern.subn(replacement, text)
    if count != 1:
        raise ValueError(f"Expected exactly one {label} in {path}, found {count}")
    if new_text == text:
        return False
    path.write_text(new_text, encoding="utf-8")
    return True


def refresh_project_pins(
    *,
    pre_commit_hooks_version: str,
    playwright_version: str,
    playwright_digest: str,
) -> list[Path]:
    """Refresh every non-Dependabot pin owned by the project."""
    changed: list[Path] = []
    if replace_one(
        PRE_COMMIT_PATH,
        PRE_COMMIT_HOOKS_PATTERN,
        rf"\g<1>v{pre_commit_hooks_version}",
        label="pre-commit-hooks revision",
    ):
        changed.append(PRE_COMMIT_PATH)

    image = f"mcr.microsoft.com/playwright:v{playwright_version}-noble@{playwright_digest}"
    if replace_one(
        MAKEFILE_PATH,
        PLAYWRIGHT_IMAGE_PATTERN,
        f"PLAYWRIGHT_CI_IMAGE := {image}",
        label="Playwright CI image pin",
    ):
        changed.append(MAKEFILE_PATH)
    return changed


def main(argv: list[str] | None = None) -> int:
    """Refresh GitHub Action refs and project-owned CI pins."""
    _ = argv
    token = os.environ.get("GH_TOKEN")
    if not token:
        print("GH_TOKEN is required", file=sys.stderr)
        return 1

    resolve_action = refresh_action_shas.make_resolver(
        lambda repo, ref: refresh_action_shas.github_fetch(repo, ref, token=token)
    )
    changed = refresh_action_shas.refresh_files(refresh_action_shas.WORKFLOW_ROOTS, resolve_action)

    playwright_version = locked_playwright_version(PACKAGE_LOCK_PATH)
    playwright_image = f"mcr.microsoft.com/playwright:v{playwright_version}-noble"
    changed.extend(
        refresh_project_pins(
            pre_commit_hooks_version=retry(
                lambda: github_latest_version("pre-commit/pre-commit-hooks", token=token)
            ),
            playwright_version=playwright_version,
            playwright_digest=retry(lambda: registry_digest(playwright_image)),
        )
    )

    for path in sorted(set(changed)):
        print(f"Updated {path}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
