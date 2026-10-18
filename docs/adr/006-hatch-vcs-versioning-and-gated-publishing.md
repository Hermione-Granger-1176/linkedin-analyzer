# ADR-006: hatch-vcs tag-driven versioning and CI-gated trusted publishing

**Date:** 2026-07-03 **Status:** Accepted **Deciders:** Aditya Kumar Darak

## Context

The `linkedin-analyzer` package ships to PyPI and as a GHCR container image. Manually maintained versions can disagree between `pyproject.toml`, the wheel, and the image. Publishing must require passing CI and avoid long-lived API tokens.

## Decision

Derive the version from the Git tag. Require passing CI and use OIDC trusted publishing.

- `pyproject.toml` sets `[tool.hatch.version] source = "vcs"`. At build time, `hatch-vcs` computes the version from the Git tag without a manually maintained version field.
- `.github/workflows/publish.yml` runs a `require-ci` job that refuses to publish unless the tagged commit's `CI result` check concluded `success`. `publish-pypi` uses PyPI OIDC trusted publishing (`id-token: write`, `environment: pypi`, no stored token) and self-verifies that `linkedin-analyzer --version` matches the tag. `publish-docker` repeats the version check on the image and runs a Trivy HIGH/CRITICAL scan before pushing.

## Consequences

- One tag drives the PyPI and GHCR versions, so the artifacts cannot disagree, and releases are reproducible from the tag.
- PyPI access uses the repository's trusted-publisher configuration without a stored API token.
- Releases require tagging discipline (tag a commit that already has green CI). Re-running a failed later job is safe because `gh-action-pypi-publish` runs with `skip-existing: true`, so an already-accepted upload is skipped rather than erroring.
