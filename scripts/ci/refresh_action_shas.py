#!/usr/bin/env python3
"""Pin GitHub Actions `uses:` refs to full commit SHAs.

The scheduled ``refresh-action-shas`` workflow calls this to rewrite every
tag-based action reference under ``.github/workflows`` and ``.github/actions``
into an immutable ``action@<40-hex-sha> # <tag>`` form. The rewriting logic is
pure and tested here; only ``github_fetch`` touches the network.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from collections.abc import Callable, Iterable
from pathlib import Path
from urllib.request import Request, urlopen

# Matches a `uses:` line, capturing the leading prefix, the action, its ref, and
# any trailing content (e.g. an existing `# vX` comment) so it can be preserved.
USES_PATTERN = re.compile(r"^(\s*(?:-\s*)?uses:\s*)([^@\s]+)@([^\s#]+)(.*)$")
SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")

WORKFLOW_ROOTS = (Path(".github/workflows"), Path(".github/actions"))

ResolveSha = Callable[[str, str], str]
FetchSha = Callable[[str, str], str]


def is_pinnable(action: str, ref: str) -> bool:
    """Return whether an action reference should be resolved to a SHA.

    Local (``./``), Docker, and templated references are left untouched, and a
    ref that is already a 40-character SHA needs no change.
    """
    if action.startswith(("./", "docker://")) or "${{" in action:
        return False
    return not SHA_PATTERN.fullmatch(ref)


def update_line(line: str, resolve: ResolveSha) -> tuple[str, bool]:
    """Rewrite a single line's action ref to a SHA, preserving its comment.

    Returns the (possibly unchanged) line and whether it was rewritten.
    """
    match = USES_PATTERN.match(line)
    if not match:
        return line, False

    prefix, action, ref, suffix = match.groups()
    if not is_pinnable(action, ref):
        return line, False

    sha = resolve(action, ref)
    ref_suffix = suffix if suffix.strip() else f" # {ref}"
    return f"{prefix}{action}@{sha}{ref_suffix}", True


def update_text(text: str, resolve: ResolveSha) -> tuple[str, bool]:
    """Rewrite every action ref in a file's text. Returns (text, changed)."""
    new_lines = []
    changed = False
    for line in text.splitlines():
        new_line, line_changed = update_line(line, resolve)
        new_lines.append(new_line)
        changed = changed or line_changed
    if not changed:
        return text, False
    return "\n".join(new_lines) + "\n", True


def iter_workflow_files(roots: Iterable[Path]) -> list[Path]:
    """Return the sorted YAML files under the given workflow/action roots."""
    files: list[Path] = []
    for root in roots:
        if not root.exists():
            continue
        files.extend(root.rglob("*.yml"))
        files.extend(root.rglob("*.yaml"))
    return sorted(files)


def refresh_files(roots: Iterable[Path], resolve: ResolveSha) -> list[Path]:
    """Rewrite action refs in place across all roots; return changed paths."""
    changed: list[Path] = []
    for path in iter_workflow_files(roots):
        text = path.read_text(encoding="utf-8", errors="replace")
        new_text, was_changed = update_text(text, resolve)
        if not was_changed:
            continue
        path.write_text(new_text, encoding="utf-8")
        changed.append(path)
    return changed


def make_resolver(
    fetch: FetchSha,
    *,
    max_attempts: int = 3,
    sleep: Callable[[float], None] = time.sleep,
) -> ResolveSha:
    """Wrap a fetch function with per-repo caching and bounded retries."""
    cache: dict[str, str] = {}

    def resolve(action: str, ref: str) -> str:
        repo = "/".join(action.split("/")[:2])
        key = f"{repo}@{ref}"
        if key in cache:
            return cache[key]
        last_error: Exception | None = None
        for attempt in range(1, max_attempts + 1):
            try:
                sha = fetch(repo, ref)
            except Exception as exc:  # retried below, then re-raised on the last attempt
                last_error = exc
                if attempt == max_attempts:
                    break
                sleep(attempt * 0.25)
                continue
            cache[key] = sha
            return sha
        assert last_error is not None
        raise last_error

    return resolve


def github_fetch(repo: str, ref: str, *, token: str, timeout: float = 15) -> str:
    """Resolve ``repo@ref`` to a commit SHA via the GitHub commits API."""
    url = f"https://api.github.com/repos/{repo}/commits/{ref}"
    request = Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
        },
    )
    with urlopen(request, timeout=timeout) as response:
        data = json.load(response)
    return str(data["sha"])


def main(argv: list[str] | None = None) -> int:
    """Refresh action SHAs across the workflow roots."""
    _ = argv
    token = os.environ.get("GH_TOKEN")
    if not token:
        print("GH_TOKEN is required", file=sys.stderr)
        return 1
    resolve = make_resolver(lambda repo, ref: github_fetch(repo, ref, token=token))
    for path in refresh_files(WORKFLOW_ROOTS, resolve):
        print(f"Updated {path}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
