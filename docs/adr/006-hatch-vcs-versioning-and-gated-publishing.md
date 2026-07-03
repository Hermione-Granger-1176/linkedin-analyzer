# ADR-006: hatch-vcs tag-driven versioning and CI-gated trusted publishing

**Date:** 2026-07-03 **Status:** Accepted **Deciders:** Aditya Kumar Darak

## Context

The `linkedin-analyzer` package ships to PyPI and as a GHCR container image. A hand-edited version number is easy to forget or to desync between `pyproject.toml`, the built wheel, and the Docker image. Publishing also needs to be secure (no long-lived API token to leak) and must not ship an artifact that never passed CI.

## Decision

Derive the version from the Git tag and gate publishing on green CI plus OIDC trusted publishing.

- `pyproject.toml` sets `[tool.hatch.version] source = "vcs"`, so `hatch-vcs` computes the version from the tag at build time. Tagging a release is the single source of truth; there is no version to hand-edit.
- `.github/workflows/publish.yml` runs a `require-ci` job that refuses to publish unless the tagged commit's `CI result` check concluded `success`. `publish-pypi` uses PyPI OIDC trusted publishing (`id-token: write`, `environment: pypi`, no stored token) and self-verifies that `linkedin-analyzer --version` matches the tag. `publish-docker` repeats the version check on the image and runs a Trivy HIGH/CRITICAL scan before pushing.

## Consequences

- One tag drives the PyPI and GHCR versions, so the artifacts cannot disagree, and releases are reproducible from the tag.
- No API token exists to rotate or leak; access is tied to the repository's trusted-publisher configuration.
- Releases require tagging discipline (tag a commit that already has green CI). Re-running a failed later job is safe because `gh-action-pypi-publish` runs with `skip-existing: true`, so an already-accepted upload is skipped rather than erroring.
