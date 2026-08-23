# Contributing

This repository contains a Python CLI and a browser app. Keep changes focused, test behavior at the runtime you change, and update the relevant docs when the public behavior changes.

## Set up the repository

Install Python 3.12 or newer, Node.js 22.22.2 or newer in the 22 line or 24.15.0 or newer in the 24 line, and `uv` 0.11.0 or newer. Then run:

```bash
make setup
make install-hooks
```

Read [development](../docs/development.md) for browser setup, dependency changes, local diagnostics, and GitHub helpers.

## Create a branch

Create a branch from `main` with:

```bash
make branch name=describe-the-change
```

Use `make branch-current` only when the current checkout is already the intended base.

## Run checks

Run the narrow checks while you work:

```bash
make lint-py
make lint-js
make lint-css
make typecheck-py
make typecheck-web
make test-py
make test-js
```

Run the full non-browser gate before review:

```bash
make ci
```

Run `make check` when the change affects browser behavior, browser files, or the Playwright suite. Read [testing](../docs/testing.md) for coverage, parity, browser runtime, and benchmark checks.

## Update documentation

Use [the documentation index](../docs/index.md) to choose the page. Put user actions in a how-to or tutorial, facts in a reference, and design reasons in an explanation. Keep Markdown paragraphs on one line and align tables with `make align-tables`.

Run these checks after documentation changes:

```bash
make lint-doc-commands
make lint-make-targets
make align-tables-check
```

## Open a pull request

Describe the behavior change and the reason for it. Include the tests you ran and call out any intentionally untested path. Add a parity fixture when Python and browser cleaner behavior changes together.

Use the Make wrappers for GitHub work. Put pull request bodies on standard input and titles in `TITLE`:

```bash
TITLE='Describe the change' make pr-create < pull-request.md
```

The maintainer decides when to commit, push, open, or merge a pull request. Follow the repository commit format in [the style guide](../docs/style-guide.md).

## Protect private data

Do not commit LinkedIn exports, generated workbooks, browser storage dumps, screenshots containing personal data, or logs containing names or message text. Use the checked-in fixtures under `tests/fixtures/` and `web/e2e/fixtures/` for tests.

Report security issues through the [security policy](SECURITY.md), not through a public issue.
