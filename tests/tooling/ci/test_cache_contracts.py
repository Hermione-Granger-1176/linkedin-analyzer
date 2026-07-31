from __future__ import annotations

import json
import re
import tomllib
from pathlib import Path

REPO_ROOT = Path(__file__).parents[3]
CI_SETUP = (REPO_ROOT / ".github/actions/ci-setup/action.yml").read_text(encoding="utf-8")
CI_WORKFLOW = (REPO_ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
AUDIT_WORKFLOW = (REPO_ROOT / ".github/workflows/dependency-audit.yml").read_text(encoding="utf-8")
REFRESH_WORKFLOW = (REPO_ROOT / ".github/workflows/refresh-python-locks.yml").read_text(
    encoding="utf-8"
)
PUBLISH_WORKFLOW = (REPO_ROOT / ".github/workflows/publish.yml").read_text(encoding="utf-8")


def test_uv_setup_uses_one_pinned_version_without_a_duplicate_cache() -> None:
    """Install uv from the project pin and keep one dependency cache owner."""
    pyproject = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8"))

    # A floor rather than an exact pin, so an install a few patches behind still
    # runs; setup-uv resolves the newest release that satisfies it. The floor may
    # be raised, but it may not drop below the version the project has actually
    # been exercised against, nor take a shape that stops being a floor at all.
    required_uv = pyproject["tool"]["uv"]["required-version"]
    floor = re.fullmatch(r">=(\d+)\.(\d+)\.(\d+)", required_uv)
    assert floor is not None, f"uv required-version must be a >=X.Y.Z floor, got {required_uv!r}"
    assert tuple(int(part) for part in floor.groups()) >= (0, 11, 0)
    assert len(re.findall(r"astral-sh/setup-uv@[0-9a-f]{40} # v\d+\.\d+\.\d+", CI_SETUP)) == 1
    assert "enable-cache: false" in CI_SETUP
    assert "cache: pip" not in CI_SETUP
    assert "python -m pip install" not in CI_SETUP


def test_materialized_dependency_caches_use_exact_inputs() -> None:
    """Invalidate complete environments on manifest, lock, platform, or toolchain changes."""
    assert (
        "venv-${{ runner.os }}-${{ runner.arch }}"
        "-${{ steps.setup-python.outputs.python-version }}"
        "-${{ hashFiles('pyproject.toml', 'uv.lock') }}"
    ) in CI_SETUP
    assert (
        "node-modules-${{ runner.os }}-${{ runner.arch }}"
        "-${{ steps.node-version.outputs.version }}"
        "-${{ hashFiles('package.json', 'package-lock.json') }}"
    ) in CI_SETUP

    venv_block = CI_SETUP.split("- name: Cache virtual environment", maxsplit=1)[1].split(
        "- name:", maxsplit=1
    )[0]
    node_modules_block = CI_SETUP.split("- name: Cache node modules", maxsplit=1)[1].split(
        "- name:", maxsplit=1
    )[0]
    assert "restore-keys" not in venv_block
    assert "restore-keys" not in node_modules_block


def test_download_caches_only_restore_when_installation_can_consume_them() -> None:
    """Do not transfer package archives beside a complete environment hit."""
    assert "steps.venv-cache.outputs.cache-hit != 'true'" in CI_SETUP
    assert "steps.node-modules-cache.outputs.cache-hit != 'true'" in CI_SETUP
    assert "path: ~/.cache/uv" in CI_SETUP
    assert "path: ~/.npm" in CI_SETUP
    assert "make ci-prune-uv-cache" in CI_SETUP


def test_python_sync_refreshes_revision_derived_editable_metadata() -> None:
    """A venv hit must not preserve hatch-vcs metadata from another commit."""
    sync_block = CI_SETUP.split("- name: Synchronize Python dependencies", maxsplit=1)[1].split(
        "- name:", maxsplit=1
    )[0]

    assert "make install" in sync_block
    assert sync_block.index("make install") < sync_block.index('if [ "$VENV_CACHE_HIT"')


def test_e2e_uses_an_immutable_version_matched_playwright_container() -> None:
    """Run browsers from the exact project-compatible image without host installation."""
    package_lock = json.loads((REPO_ROOT / "package-lock.json").read_text(encoding="utf-8"))
    package_version = package_lock["packages"]["node_modules/@playwright/test"]["version"]
    image_match = re.search(
        r"PLAYWRIGHT_CI_IMAGE := mcr\.microsoft\.com/playwright:v(?P<version>[^-]+)-noble"
        r"@sha256:(?P<digest>[0-9a-f]{64})",
        (REPO_ROOT / "Makefile").read_text(encoding="utf-8"),
    )

    assert image_match is not None
    assert image_match.group("version") == package_version
    assert image_match.group("digest") == (
        "baed2032d533817f3dbe6425de795788430ba345e819a1201337009ba17c9d07"
    )
    assert "run: make web-e2e-container" in CI_WORKFLOW
    assert "playwright-engines" not in CI_SETUP
    assert "Cache Playwright browsers" not in CI_SETUP
    assert "Install Playwright browsers" not in CI_SETUP
    assert "playwright install" not in CI_SETUP


def test_specialized_workflows_share_setup_or_intentionally_skip_dependency_caches() -> None:
    """Prevent audit and lock-refresh jobs from drifting into duplicate cache paths."""
    assert AUDIT_WORKFLOW.count("uses: ./.github/actions/ci-setup") == 2
    assert "cache: npm" not in AUDIT_WORKFLOW
    assert "cache: pip" not in AUDIT_WORKFLOW
    assert "actions/cache@" not in AUDIT_WORKFLOW

    assert (
        len(re.findall(r"astral-sh/setup-uv@[0-9a-f]{40} # v\d+\.\d+\.\d+", REFRESH_WORKFLOW)) == 1
    )
    assert "enable-cache: false" in REFRESH_WORKFLOW
    assert "actions/cache@" not in REFRESH_WORKFLOW
    assert "python -m pip install" not in REFRESH_WORKFLOW


def test_release_build_cache_is_registry_backed_and_shared_across_releases() -> None:
    """Keep trusted release builds on one durable multi-platform cache."""
    cache_ref = "type=registry,ref=${{ steps.image-meta.outputs.image }}:buildcache"

    assert PUBLISH_WORKFLOW.count(f"cache-from: {cache_ref}") == 2
    assert PUBLISH_WORKFLOW.count(f"cache-to: {cache_ref},mode=max") == 2
    assert "cache-from: type=gha" not in PUBLISH_WORKFLOW
    assert "cache-to: type=gha" not in PUBLISH_WORKFLOW
