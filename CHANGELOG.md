# Changelog

All notable changes to this project will be documented in this file.

The format follows Keep a Changelog, and releases are tagged in Git.

## Unreleased

- Replace vulnerable `xlsx` with `write-excel-file` in the web app export path.
- Make diagnostics opt-in and align privacy wording with runtime behavior.
- Add cross-runtime cleaner parity fixtures for web and Python.
- Enforce size budgets in CI and run Playwright against the built artifact.
- Fix Docker version propagation and add publish-time artifact validation.
- Add IndexedDB schema versioning for stored files and analytics payloads.
