# Changelog

All notable changes to this project will be documented in this file.

This changelog tracks the `linkedin-analyzer` Python package — the CLI published to PyPI and the container image that ships it. Web app changes are intentionally out of scope.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Python 3.14 to the supported classifiers, with documentation for 3.11–3.13 development under uv.

### Changed

- Default local and CI Python to 3.14 to match the container runtime; compatibility matrix now covers 3.11/3.12/3.13.

### Fixed

- Write cleaned Excel output atomically so a crash mid-export cannot leave a truncated or corrupt `.xlsx` at the destination.
- Preserve exception tracebacks in structured JSON logs.
- Preserve the declared pandas 2.0 compatibility when escaping formula-like cell values.
- Reject duplicate CSV headers created by BOM and whitespace normalization with a clear error.
- Align connection-date cleaning for invalid calendar dates.
- Support Excel column width mappings beyond column `Z`.
- Include CI helper scripts in strict Python type checking.

## [0.5.0] - 2026-03-06

### Added

- Structured JSON logging for the CLI (`--log-format json` / `LOG_FORMAT` env).
- `LOG_LEVEL` and `LINKEDIN_ANALYZER_DATA_DIR` environment variable support.
- Dynamic versioning from git tags via `hatch-vcs`.
- Cross-runtime parity fixtures pinning the Python cleaner's output against a shared reference.
- Publish-time artifact validation and Docker version propagation.

### Changed

- Bump the Python Docker base image from 3.12-slim to 3.14-slim.

### Fixed

- Docker version propagation for `hatch-vcs` builds.

### Security

- Expand OWASP CSV injection escaping to cover all formula prefixes.
- Add a Trivy container image scan before the Docker push in CI.

## [0.4.0] - 2026-03-05

### Changed

- Expand the Python test matrix to 3.11, 3.12, and 3.13.
- Switch PyPI publishing to OIDC trusted publishing (no API token secret).
- Switch Docker publishing to multi-arch `linux/amd64,linux/arm64` via `docker/build-push-action`.

## [0.3.0] - 2026-03-02

No changes to the `linkedin-analyzer` Python package in this release.

## [0.2.0] - 2026-02-28

### Added

- Messages and Connections CSV cleaning in the Python CLI.

### Changed

- Code-quality pass on the Python package: `from __future__ import annotations` in package init files and assorted refactors.

## [0.1.0] - 2026-01-31

Initial release of the `linkedin-analyzer` Python CLI.

### Added

- Python CLI (`linkedin-analyzer`) for cleaning LinkedIn **Shares** and **Comments** CSV exports to formatted Excel files.
- Centralized default paths and deduplicated CLI argument handling.
- 95 %+ test coverage with `pytest-cov` threshold enforcement.
- MIT license (SPDX text).

### Fixed

- Repository URLs in `pyproject.toml`.

[Unreleased]: https://github.com/Hermione-Granger-1176/linkedin-analyzer/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/Hermione-Granger-1176/linkedin-analyzer/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Hermione-Granger-1176/linkedin-analyzer/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Hermione-Granger-1176/linkedin-analyzer/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Hermione-Granger-1176/linkedin-analyzer/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Hermione-Granger-1176/linkedin-analyzer/releases/tag/v0.1.0
