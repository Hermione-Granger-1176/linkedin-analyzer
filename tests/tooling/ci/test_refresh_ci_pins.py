from __future__ import annotations

import io
import json
from email.message import Message
from pathlib import Path
from urllib.request import Request

import pytest
from scripts.ci import refresh_ci_pins as pins

DIGEST = f"sha256:{'a' * 64}"


class Response(io.BytesIO):
    """Minimal context-managed HTTP response with headers."""

    def __init__(self, payload: object = None, *, digest: str | None = None) -> None:
        super().__init__(json.dumps(payload).encode("utf-8"))
        self.headers = Message()
        if digest is not None:
            self.headers["Docker-Content-Digest"] = digest

    def __enter__(self) -> Response:
        """Enter the fake response context."""
        return self

    def __exit__(self, *_args: object) -> None:
        """Close the fake response context."""
        self.close()


def test_retry_retries_then_returns() -> None:
    """Retry transient pin-service failures with bounded backoff."""
    attempts = 0
    sleeps: list[float] = []

    def fetch() -> str:
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise RuntimeError("transient")
        return "ready"

    assert pins.retry(fetch, sleep=sleeps.append) == "ready"
    assert attempts == 3
    assert sleeps == [0.25, 0.5]


def test_retry_rejects_empty_budget_and_propagates_final_error() -> None:
    """Reject an empty budget and let the final failed attempt surface."""
    with pytest.raises(ValueError, match="at least 1"):
        pins.retry(lambda: "unused", attempts=0)
    with pytest.raises(RuntimeError, match="final"):
        pins.retry(lambda: (_ for _ in ()).throw(RuntimeError("final")), attempts=1)


def test_github_latest_version_reads_a_semver_release(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Read a stable release tag through an authenticated GitHub API request."""
    requests: list[Request] = []

    def fake_urlopen(request: Request, timeout: float) -> Response:
        requests.append(request)
        assert timeout == 15
        return Response({"tag_name": "v6.1.2"})

    monkeypatch.setattr(pins, "urlopen", fake_urlopen)

    assert pins.github_latest_version("owner/tool", token="secret") == "6.1.2"
    assert requests[0].full_url.endswith("/repos/owner/tool/releases/latest")
    assert requests[0].get_header("Authorization") == "Bearer secret"


@pytest.mark.parametrize("payload", [[], {}, {"tag_name": None}, {"tag_name": "latest"}])
def test_github_latest_version_rejects_invalid_payloads(
    monkeypatch: pytest.MonkeyPatch, payload: object
) -> None:
    """Reject release responses that cannot become an exact semantic version."""
    monkeypatch.setattr(pins, "urlopen", lambda *_args, **_kwargs: Response(payload))
    with pytest.raises(ValueError, match="invalid latest release tag"):
        pins.github_latest_version("owner/tool", token="secret")


def test_locked_playwright_version_reads_exact_package(tmp_path: Path) -> None:
    """Read the installed Playwright version instead of the manifest range."""
    path = tmp_path / "package-lock.json"
    path.write_text(
        json.dumps({"packages": {"node_modules/@playwright/test": {"version": "1.62.0"}}}),
        encoding="utf-8",
    )
    assert pins.locked_playwright_version(path) == "1.62.0"


@pytest.mark.parametrize(
    "payload",
    [{}, {"packages": {}}, {"packages": {"node_modules/@playwright/test": {"version": 7}}}],
)
def test_locked_playwright_version_rejects_missing_or_invalid_versions(
    tmp_path: Path, payload: object
) -> None:
    """Fail closed when the lockfile cannot identify one exact Playwright release."""
    path = tmp_path / "package-lock.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(ValueError, match="no exact"):
        pins.locked_playwright_version(path)


def test_registry_digest_reads_an_immutable_mcr_digest(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Resolve the exact MCR manifest list digest with a HEAD request."""
    requests: list[Request] = []

    def fake_urlopen(request: Request, timeout: float) -> Response:
        requests.append(request)
        assert timeout == 15
        return Response(digest=DIGEST)

    monkeypatch.setattr(pins, "urlopen", fake_urlopen)
    image = "mcr.microsoft.com/playwright:v1.62.0-noble"

    assert pins.registry_digest(image) == DIGEST
    assert requests[0].method == "HEAD"
    assert requests[0].full_url.endswith("/manifests/v1.62.0-noble")


@pytest.mark.parametrize(
    ("image", "digest"),
    [
        ("docker.io/playwright:v1.62.0", DIGEST),
        ("mcr.microsoft.com/playwright:", DIGEST),
        ("mcr.microsoft.com/playwright:v1.62.0-noble", None),
        ("mcr.microsoft.com/playwright:v1.62.0-noble", "sha256:short"),
    ],
)
def test_registry_digest_rejects_unsupported_images_and_invalid_responses(
    monkeypatch: pytest.MonkeyPatch, image: str, digest: str | None
) -> None:
    """Never write a digest from the wrong registry or an invalid response."""
    monkeypatch.setattr(pins, "urlopen", lambda *_args, **_kwargs: Response(digest=digest))
    with pytest.raises(ValueError, match=r"Unsupported|invalid digest"):
        pins.registry_digest(image)


def test_replace_one_changes_once_and_detects_noop(tmp_path: Path) -> None:
    """Require one owned pin while avoiding needless file writes."""
    path = tmp_path / "config"
    path.write_text("pin=old\n", encoding="utf-8")
    pattern = pins.re.compile(r"(?m)^pin=\S+$")

    assert pins.replace_one(path, pattern, "pin=new", label="test pin")
    assert not pins.replace_one(path, pattern, "pin=new", label="test pin")


@pytest.mark.parametrize("text", ["none\n", "pin=a\npin=b\n"])
def test_replace_one_rejects_missing_or_duplicate_pins(tmp_path: Path, text: str) -> None:
    """Fail when a refactor makes pin ownership ambiguous."""
    path = tmp_path / "config"
    path.write_text(text, encoding="utf-8")
    with pytest.raises(ValueError, match="Expected exactly one"):
        pins.replace_one(path, pins.re.compile(r"(?m)^pin=\S+$"), "pin=new", label="test pin")


def test_refresh_project_pins_updates_each_owned_file(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Update the pre-commit and Playwright pins as one maintenance unit."""
    pre_commit = tmp_path / ".pre-commit-config.yaml"
    makefile = tmp_path / "Makefile"
    pre_commit.write_text(
        "repos:\n  - repo: https://github.com/pre-commit/pre-commit-hooks\n    rev: v4.0.0\n",
        encoding="utf-8",
    )
    makefile.write_text(
        f"PLAYWRIGHT_CI_IMAGE := mcr.microsoft.com/playwright:v1.1.0-noble@{DIGEST}\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(pins, "PRE_COMMIT_PATH", pre_commit)
    monkeypatch.setattr(pins, "MAKEFILE_PATH", makefile)

    changed = pins.refresh_project_pins(
        pre_commit_hooks_version="6.0.0",
        playwright_version="1.62.0",
        playwright_digest=f"sha256:{'b' * 64}",
    )

    # No pyproject.toml among them: uv's required-version is a hand-raised
    # floor, so this script has no business rewriting it.
    assert changed == [pre_commit, makefile]
    assert "rev: v6.0.0" in pre_commit.read_text(encoding="utf-8")
    assert "v1.62.0-noble@sha256:" in makefile.read_text(encoding="utf-8")


def test_refresh_project_pins_reports_no_changes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Leave already current project pins untouched."""
    pre_commit = tmp_path / ".pre-commit-config.yaml"
    makefile = tmp_path / "Makefile"
    pre_commit.write_text(
        "repos:\n  - repo: https://github.com/pre-commit/pre-commit-hooks\n    rev: v6.0.0\n",
        encoding="utf-8",
    )
    makefile.write_text(
        f"PLAYWRIGHT_CI_IMAGE := mcr.microsoft.com/playwright:v1.62.0-noble@{DIGEST}\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(pins, "PRE_COMMIT_PATH", pre_commit)
    monkeypatch.setattr(pins, "MAKEFILE_PATH", makefile)

    assert (
        pins.refresh_project_pins(
            pre_commit_hooks_version="6.0.0",
            playwright_version="1.62.0",
            playwright_digest=DIGEST,
        )
        == []
    )


def test_main_requires_token(monkeypatch: pytest.MonkeyPatch) -> None:
    """Do not perform partial refreshes without GitHub authentication."""
    monkeypatch.delenv("GH_TOKEN", raising=False)
    assert pins.main([]) == 1


def test_main_refreshes_actions_and_project_pins(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Orchestrate every pin owner and report the unique changed paths."""
    action_path = tmp_path / "action.yml"
    project_path = tmp_path / "Makefile"
    calls: list[tuple[str, object]] = []

    monkeypatch.setenv("GH_TOKEN", "token")
    monkeypatch.setattr(pins.refresh_action_shas, "WORKFLOW_ROOTS", (tmp_path,))
    monkeypatch.setattr(
        pins.refresh_action_shas,
        "make_resolver",
        lambda fetch: calls.append(("resolver", fetch)) or (lambda _action, _ref: "a" * 40),
    )
    monkeypatch.setattr(
        pins.refresh_action_shas,
        "refresh_files",
        lambda roots, resolve: calls.append(("actions", (roots, resolve))) or [action_path],
    )
    monkeypatch.setattr(pins, "PACKAGE_LOCK_PATH", tmp_path / "package-lock.json")
    monkeypatch.setattr(pins, "locked_playwright_version", lambda _path: "1.62.0")
    monkeypatch.setattr(
        pins,
        "github_latest_version",
        lambda repo, **_kwargs: {"pre-commit/pre-commit-hooks": "6.0.0"}[repo],
    )
    monkeypatch.setattr(pins, "registry_digest", lambda _image: DIGEST)
    monkeypatch.setattr(
        pins,
        "refresh_project_pins",
        lambda **kwargs: calls.append(("project", kwargs)) or [project_path, action_path],
    )

    assert pins.main([]) == 0
    assert [name for name, _value in calls] == ["resolver", "actions", "project"]
    assert capsys.readouterr().out.splitlines() == [
        f"Updated {project_path}",
        f"Updated {action_path}",
    ]
