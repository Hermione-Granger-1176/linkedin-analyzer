# Development Setup

## Prerequisites

- Python 3.14 (default; 3.11+ supported, see [Using an older Python version](#using-an-older-python-version)). The Docker runtime and primary CI gate use 3.14.
- Node.js 22.13.x or 24+
- [uv](https://docs.astral.sh/uv/)

The project supports Python 3.11-3.14. Python 3.14 is the default for local development, the container image, and the primary CI quality gate. Python 3.11-3.13 are verified in the CI compatibility matrix. See [Using an older Python version](#using-an-older-python-version) if you need to develop or test against Python 3.11, 3.12, or 3.13.

## Initial setup

```bash
# Install locked Python deps into .venv and Node deps into node_modules
make setup

# Optional: make diagnostics available in local/dev builds
cp .env.example .env
# Set VITE_SENTRY_DSN in .env when needed (still requires in-app opt-in)
```

Python dependencies are declared in `pyproject.toml` and resolved in `uv.lock`. The local environment remains `.venv`; uv creates and syncs it from the lockfile.

Refresh lockfiles after dependency changes:

```bash
make lock       # Python
make lock-node  # Node
```

When only selected transitive Node packages need a security refresh, update them without changing `package.json`:

```bash
make lock-node-update packages="package-a package-b"
```

When `make audit-node` reports an automatically fixable advisory, update only the lockfile and review the resulting dependency changes:

```bash
make audit-fix-node
make security
```

The npm and Python audits use the reviewed exception policy in `config/security_audit.json`. A finding may be temporarily accepted only through an ecosystem-specific entry recording the package, advisory ID, reason, and ISO `review_by` date. Set `ignore_only_without_fix` to `true` when the exception must fail as soon as the package manager reports an available fix. Both audits fail for expired, unused, duplicate, or ambiguous exceptions so that the policy cannot silently rot. The Python gate also preserves `pip-audit --strict` behavior and rejects skipped dependencies or malformed report data.

For a narrower local investigation, select the lowest severity to review:

```bash
make audit-node audit_level=high
```

Omitting `audit_level` runs the full policy gate used by CI.

### Using an older Python version

The `make install` target builds the `.venv` against the interpreter named by the `PYTHON` variable, which defaults to `3.14` (uv downloads it if it is not already installed). To work against an older supported version, override `PYTHON`. uv will download and manage the interpreter for you, so you do not need it installed system-wide:

```bash
# Build the .venv against a specific Python (uv fetches it if missing)
make clean-venv && make install PYTHON=3.12

# Subsequent targets use that .venv directly. No override is needed.
make test-py
make typecheck-py
```

`PYTHON` only affects `make install`, which is what creates the `.venv` (it defaults to `3.14`); the other targets always run the `.venv` interpreter you built. uv keeps an existing compatible `.venv` rather than rebuilding it, so remove `.venv` first when you want the interpreter to actually change. To switch back to the default:

```bash
make clean-venv && make install
```

`make clean-venv` fails closed unless `VENV` names a real, non-symlinked directory directly below the repository root. This prevents an inherited or mistyped `VENV` value from redirecting recursive deletion elsewhere.

You can also point `PYTHON` at an explicit interpreter name on your `PATH` (for example `make install PYTHON=python3.11`). The lockfile (`uv.lock`) is universal and resolves across Python 3.11-3.14, so no lock changes are needed to switch versions. Type checking (`mypy`) and linting (`ruff`) always target the Python 3.11 floor regardless of the interpreter you run, so newer-only syntax is caught early.

## Web App

```bash
# Start dev server
make web

# Run tests
make test-js

# Fast setup: Python and Node dependencies only, no browsers
make setup

# Full local setup (deps plus browsers) for hosts that already have browser libraries
make setup-all

# Shared browsers plus repository-local Ubuntu/Debian libraries, no sudo
make setup-playwright-local

# Verify the private runtime launches Chromium, Firefox, and WebKit
make playwright-local-status
make playwright-local-gate

# Run browser E2E tests through the prepared private runtime
make test-e2e local_libs=1

# CI-only setup that may install Playwright system packages through --with-deps
make setup-ci

# Capture screens at mobile/tablet/desktop viewports (writes to .artifacts/screens by default)
make web-screens

# Lint
make lint-js

# Lint stylesheets
make lint-css

# Auto-fix stylesheet lint findings
make fmt-css

# Lint YAML files
make lint-yaml

# Lint selected YAML files
make lint-yaml paths=".github/workflows/ci.yml .yamllint.yml"

# Check EditorConfig rules across supported repository files
make editorconfig-check

# Check EditorConfig rules for selected files
make editorconfig-check paths="Makefile web/src/app.js"

# Check contributor documentation uses supported Make targets
make lint-doc-commands

# Check selected contributor documents
make lint-doc-commands paths="README.md docs/development.md"

# Check every referenced Make target exists
make lint-make-targets

# Check Make targets in selected files
make lint-make-targets paths="README.md scripts/gh/pr_watch.py"

# Type-check JavaScript with checkJs
make typecheck-web

# Detect unused JS code, exports, and deps (knip)
make dead-code-js

# Format check (docs/config files)
make format-js-check

# Preview all Python formatting changes without modifying files
make format-py-diff

# Preview Python formatting changes for selected paths
make format-py-diff paths="src/linkedin_analyzer tests"
```

`make lint-make-targets` validates every `make <target>` reference in the repository, not only the ones in documentation, because a reference to a renamed target is a bug wherever it lives. Each file kind uses the rule that avoids its own false positives:

| Where                        | What counts as a reference                 |
| ---------------------------- | ------------------------------------------ |
| Markdown                     | Inline code and fenced code blocks         |
| YAML under `.github`         | Anything in a `run:` value, which is shell |
| Python and JavaScript source | Backticked spans only                      |

Source files mix prose with commands, so an unquoted scan would read ordinary English such as "make sure it works" as a reference to a target named `sure`. **When naming a Make target inside a comment, docstring, or string, wrap it in backticks** so the linter can see it. Test files are skipped, since the checkers' own fixtures deliberately name targets that do not exist.

`make setup` is the fast default and does not install browsers. `make setup-all` installs Chromium, Firefox, and WebKit in Playwright's normal user-local browser cache. It is browser-only, does not install system packages, and does not require sudo. Use it when the host already provides the libraries Playwright needs.

To install only a validated subset of browser engines, use a hyphen-separated selection:

```bash
make setup-playwright-engines engines=chromium
make setup-playwright-engines engines=chromium-webkit
```

The target accepts only `chromium`, `firefox`, and `webkit`, rejects duplicates and malformed selections, and installs without system packages by default. Use `with_deps=1` only on an ephemeral CI runner that should also install the selected engines' operating-system dependencies.

On a Debian or Ubuntu host that lacks those libraries, run `make setup-playwright-local`. It downloads package archives from the already configured APT repositories and extracts them only into this repository's ignored `.playwright/local-libs/` cache. Browsers install into Playwright's shared `~/.cache/ms-playwright` cache, so every project on the machine reuses one copy instead of duplicating roughly a gigabyte per repository. The setup uses APT simulation, `apt download`, and `dpkg-deb -x`; it never invokes package installation, sudo, or `dpkg -i`, and it does not change the system package database. The library cache has a manifest that is rebuilt when the operating system, architecture, Playwright version, browser engine set, or resolved package versions change.

Browser-running Make targets accept `local_libs=1`, including `test-e2e`, `test-e2e-headed`, `test-e2e-ui`, and `web-screens`. This wrapper requires the cache to have been prepared already, points `PLAYWRIGHT_BROWSERS_PATH` at the shared browser cache, keeps browser home, cache, configuration, runtime, and temporary files under `.playwright/runtime/`, and adds only discovered extracted library and browser-data paths to the child environment. Preparing the runtime also patches the shared WebKit bundle launcher to append any inherited `LD_LIBRARY_PATH` after its own bundle directories. Plain (non-`local_libs`) runs that do not set `LD_LIBRARY_PATH` behave exactly as before; a value set outside the wrapper is appended at lower priority instead of being dropped. The wrapper never downloads packages during a test run. Use native Playwright host detection. Do not set `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE`.

`make playwright-local-clean` and `make clean` both remove only this repository's `.playwright/` cache (the extracted libraries and per-run scratch). Neither touches the shared browser cache, since other projects depend on it; manage shared browsers with Playwright's own tooling.

Reserve `make setup-ci` for CI and ephemeral runners. It retains Playwright's `--with-deps` mode, which may install operating-system packages on the disposable runner.

## Python CLI

```bash
# Install or refresh the .venv from uv.lock
make install

# Run Python tests (coverage runs by default)
make test-py

# Coverage HTML report
make test-py ARGS="--cov-report=html"

# Python type checking
make typecheck-py

# Python lint
make lint-py

# Detect unused Python code (vulture)
make dead-code-py

# Format Python, JavaScript, and metadata
make fmt
```

## Git and issue helpers

The local git targets that used to be inline shell now run through tested helpers in `scripts/`, for the same reason the PR and CI targets do: a path or a message that reaches a shell is a path or a message the shell can reinterpret.

```bash
# Workspace health: git, Python, Node, web build, PR
make status

# Stage selected paths
make stage files="src/a.py src/b.py"
make stage file="one path with spaces.txt"

# Commit staged changes
make commit title="Subject" body="- Detail"
make commit message_file=NOTES.md

# One-screen issue overview: state, labels, assignees, recent comments
make issue-summary issue=123
```

Three details are worth knowing:

- **`make status` runs on the system interpreter**, not the venv one (`scripts/lib/workspace_status.py`). The first thing it has to be able to report is that the venv is missing, which it could not do from inside that venv. Every subprocess it runs is guarded, so a missing `uv`, `npm`, or `git` degrades to the failure branch instead of crashing the target, and a tool that cannot launch at all is named as `UNAVAILABLE` rather than leaving its section blank.
- **`make stage` never lets a shell see a path** (`scripts/lib/stage_files.py`). Paths arrive through the environment and are handed to `git add --` as separate argv entries, so spaces, globs, and metacharacters stay literal. `files=` splits on whitespace, except when its complete value names one existing or tracked path; `file=` is always taken verbatim.
- **`make commit` screens the message before git sees it** (`scripts/gh/commit_message.py`). Both input forms are assembled into a private temporary file, checked for leaked shell fragments, and then passed to `git commit -F`. This exists because a mistyped heredoc terminator once recorded `EOF && make push 2>&1 | tail -3` inside a real commit message. The screen runs first by design: validating after the commit would report the leak only once it was already in history. It rejects heredoc openers, bare terminators, redirections, and pipes into a pager, and is deliberately narrow so prose like "Document EOF handling" is not a false positive.

### Free-text arguments

No target interpolates free text into its recipe. A value like `body="..."` or `title="..."` is exported to the environment and read back as `"$$VAR"`, so it never becomes shell source text: a newline no longer ends the line inside an open quote, a `"` no longer closes it, and backticks stay literal.

Bodies go one step further. Because `--body-file -` already reads stdin, an inline `body=` is piped straight into the helper rather than written out, so the text never reaches disk at all and the targets need no `mktemp`, `chmod`, or cleanup `trap`. Where a real file is unavoidable, as in `make commit` and `make release-create`, it is created `chmod 600` and removed by a `trap`.

That makes the file form a first-class input rather than a workaround, so the comment and reply targets accept `body_file=` in place of `body=`:

```bash
# Inline body
make pr-comment body="Looks good"

# Body from a file, or from stdin with -
make pr-comment body_file=notes.md
make pr-reply thread=PRRT_... body_file=notes.md
git log -1 --format=%B | make pr-address thread=PRRT_... body_file=-
```

`make commit message_file=` and `make ci-alert-issue detail_file=` follow the same convention. `make pr-comment`, `make pr-reply`, `make pr-address`, and `make pr-edit` all run through `scripts/gh/cli.py` rather than raw `gh`, so the body arrives as one argument no matter what is in it. A guard test in `tests/test_makefile.py` fails if a recipe ever interpolates a free-text value again.

## CI

GitHub Actions runs on pull requests and pushes to `main`:

- **Quick gates**: formatting, lint, and type checks run first through `make ci-quick-gates`
- **Heavy checks**: tests, dead-code checks, and the production build run through `make ci-heavy-checks` after quick gates pass
- **Compatibility**: Python 3.11/3.12/3.13 and Node.js 22/24 matrix jobs start after quick gates (the primary gates use Python 3.14)
- **Browser checks**: Playwright E2E starts after quick gates and uploads failure artifacts
- **Result**: one stable `CI result` job aggregates every required job for branch protection

Run the primary non-browser workflow locally with `make ci-platform-checks`. It runs the quick and heavy gates in the same order as GitHub Actions.

See `.github/workflows/ci.yml`.

A weekly `dependency-audit.yml` workflow also runs two audit jobs every Monday:

- `npm-audit` runs `make audit-node` with reviewed npm exceptions from `config/security_audit.json`, then runs `make check-overrides` to verify npm overrides remain necessary (see [ADR-001](adr/001-npm-overrides-for-transitive-dependency-gaps.md) and [ADR-007](adr/007-brace-expansion-override-for-unpatched-2x-line.md)).
- `pip-audit` runs `make audit-python` against a private temporary export of `uv.lock`, including reviewed Python exceptions from the same config.

If either audit job fails, a `report-failure` job opens (or comments on the existing) `dependency-audit`-labeled issue with a link to the run, so a scheduled failure is visible without watching the Actions tab. When both audit jobs pass again, a `report-recovery` job closes that issue, so an open alert always means a currently failing audit. Both jobs call the shared `alert-issue.yml` workflow, which runs `make ci-alert-issue`.

Maintenance workflows also keep generated repository state current:

- `refresh-python-locks.yml` + `commit-python-locks.yml` refresh `uv.lock` for same-repository Dependabot uv PRs through a validated artifact handoff. The artifact contains only `uv.lock`; a read-only job validates the triggering PR's current author, repository, ref, and SHA before a separate write-capable job can download it or create a commit. See [CI Automation and Verified Writebacks](operations.md#ci-automation-and-verified-writebacks) for the full flow and fallback behavior.
- `refresh-action-shas.yml` converts tag-based GitHub Action references to full commit SHAs when app credentials are configured. Already pinned references are left unchanged; Dependabot handles action-version updates.

## Code Style

### Python

- Type hints everywhere (strict mypy)
- Ruff for linting and formatting
- pytest for tests

### JavaScript

- ESLint for linting
- Vitest for tests
- Vite for bundling

### Tool pinning

Most `devDependencies` track caret ranges, but `actionlint` is pinned to an exact version. It gates the workflow files in CI, and new patch releases can add lint rules; an exact pin keeps `make lint-workflows` reproducible so a tool bump that fails CI is always a deliberate, reviewed change rather than a surprise. Bump it like any other dependency when you want the newer rules.

## Testing

### Python tests

```bash
make test-py                                    # Full suite (coverage gate)
make test-py ARGS="tests/test_text.py --no-cov" # Specific file
make test-py ARGS="-k test_clean --no-cov"      # By name pattern
```

The 100% statement and branch coverage gate covers `src/linkedin_analyzer/` and all of the repo tooling in `scripts/`, with no exemptions. New work anywhere in either tree needs tests to land green.

### Web tests

```bash
make test-js
make test-e2e
make test-e2e ARGS="--project=chromium web/e2e/app.e2e.spec.js" # Specific project/file
```

Unit tests are in `web/tests/`; Playwright E2E tests are in `web/e2e/`.

### Cross-runtime cleaner parity

The Python cleaner (`src/linkedin_analyzer/core/text.py`) and its web port (`web/src/field-cleaners.js`) must produce identical cleaned output. Two layers enforce this, both run by `make test`:

- Hand-written `tests/fixtures/*-parity.csv` fixtures pin exact expected values for readable, targeted cases. They are asserted by `tests/test_web_parity.py` and `web/tests/parity.test.js`.
- A seeded synthetic corpus (`tests/fixtures/*-corpus.csv`) drives a few hundred rows per type through both cleaners. Both suites assert their cleaned output equals one checked-in expected file (`tests/fixtures/parity-corpus-expected.json`, produced by the web cleaner). A cleaning-behavior change in only one runtime then fails CI.

Regenerate the corpus and its expected output after an intentional cleaning change with:

```bash
make gen-parity-corpus
```

The generator (`scripts/gen-parity-corpus.mjs`) is deterministic. Date columns cleaned by `cleanDate` use only impossible or unparseable values so the expected file stays timezone independent.

## Local checks and benchmarks

`scripts/checks/` holds developer-only tools (`make` group `checks`) that run against your private LinkedIn export in `data/input/` (never committed). They are not part of `make ci`. Checks skip with exit code 0 when the export is absent unless `strict=1` is set. Cross-runtime row dumps use an owner-only temporary directory and are removed automatically.

```bash
make cleaner-diff                 # compare main and worktree web cleaner output
make cleaner-diff args="A B"      # compare two arbitrary git refs
make cleaner-diff strict=1        # fail when required private inputs are absent
make bench                        # read -> clean -> analytics timing (make bench runs=N)
make bench-decode                 # upload decode layer: speed + byte-identity vs the old path
make xrt-diff                     # stage worktree web rows and compare with CLI xlsx cells
make xrt-diff ref=A               # stage one arbitrary web ref for cross-runtime comparison
make xrt-diff strict=1            # fail when required private inputs are absent
make audit-memory-python          # per-cleaner peak RSS, one child process each
make audit-memory-browser local_libs=1   # main renderer JS heap in Chromium
make explore                      # ad-hoc statistics over the export
```

Use `make cleaner-diff` after a web cleaner change to prove it is behavior-preserving. This standalone check compares two refs and does not retain cleaned rows. Use `make bench` as the speed regression anchor. Before `make xrt-diff`, generate the CLI workbooks with `make run-cli args="all"`. The cross-runtime target stages only the selected web ref, defaulting to `worktree`, so its Python-to-web parity result is independent of the standalone ref comparison. It reports only aggregate counts and bounded mismatch coordinates, and removes the temporary rows on every exit path. The two `make audit-memory-*` targets establish memory measurements rather than budgets: `make audit-memory-python` runs each cleaner in its own child process and reports per-type peak RSS from `resource.getrusage`, writing xlsx only into an owner-only temporary directory it always removes; `make audit-memory-browser` builds the app, serves it from a private preview server on a dedicated port, and reports the Chromium main renderer JS heap (used, total, and peak used) after the real upload-to-insights flow. Web Worker heaps are excluded, so this is the main-thread heap rather than a whole-process total. The browser audit is Chromium only, needs `local_libs=1` for the private runtime, and its heap value depends on the browser version and garbage-collection timing. `make explore` identifies the export owner for message-direction stats via `$LIA_ME`, falling back to git `user.name`.
