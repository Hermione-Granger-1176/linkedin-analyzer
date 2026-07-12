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

Refresh `uv.lock` after Python dependency changes:

```bash
make lock
```

### Using an older Python version

The `make install` target builds the `.venv` against the interpreter named by the `PYTHON` variable, which defaults to `3.14` (uv downloads it if it is not already installed). To work against an older supported version, override `PYTHON`. uv will download and manage the interpreter for you, so you do not need it installed system-wide:

```bash
# Build the .venv against a specific Python (uv fetches it if missing)
rm -rf .venv && make install PYTHON=3.12

# Subsequent targets use that .venv directly. No override is needed.
make test-py
make typecheck-py
```

`PYTHON` only affects `make install`, which is what creates the `.venv` (it defaults to `3.14`); the other targets always run the `.venv` interpreter you built. uv keeps an existing compatible `.venv` rather than rebuilding it, so remove `.venv` first when you want the interpreter to actually change. To switch back to the default:

```bash
rm -rf .venv && make install
```

You can also point `PYTHON` at an explicit interpreter name on your `PATH` (for example `make install PYTHON=python3.11`). The lockfile (`uv.lock`) is universal and resolves across Python 3.11-3.14, so no lock changes are needed to switch versions. Type checking (`mypy`) and linting (`ruff`) always target the Python 3.11 floor regardless of the interpreter you run, so newer-only syntax is caught early.

## Web App

```bash
# Start dev server
make web

# Run tests
make test-js

# Install browser for E2E (one-time)
make setup-all

# CI/Linux setup with Playwright system deps
make setup-ci

# Run browser E2E tests
make test-e2e

# Lint
make lint-js

# Type-check JavaScript with checkJs
make typecheck-web

# Detect unused JS code, exports, and deps (knip)
make dead-code-js

# Format check (docs/config files)
make format-js-check
```

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

## CI

GitHub Actions runs on pull requests and pushes to `main`:

- **Quality gate**: workflow lint + Python lint/format/typecheck/dead-code/tests + web format/lint/typecheck/dead-code/unit tests
- **Compatibility**: Python 3.11/3.12/3.13 and Node.js 22/24 matrix jobs (the quality gate runs the primary 3.14)
- **Web build**: production build + size-budget check
- **Browser checks**: Playwright E2E in an isolated job with failure artifacts

See `.github/workflows/ci.yml`.

A weekly `dependency-audit.yml` workflow also runs every Monday across two jobs:

- `make audit-node` and `make audit-python` for the npm and Python dependency audits
- `make check-overrides` to verify any future npm overrides remain necessary; the original overrides have been removed (see [ADR-001](adr/001-npm-overrides-for-transitive-dependency-gaps.md))

If either audit job fails, a `report-failure` job opens (or comments on the existing) `dependency-audit`-labeled issue with a link to the run, so a scheduled failure is visible without watching the Actions tab.

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

### Web tests

```bash
make test-js
make test-e2e
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

`scripts/checks/` holds developer-only tools (`make` group `checks`) that run against your private LinkedIn export in `data/input/` (never committed). They are not part of `make ci`; each one prints `SKIP:` and exits 0 when the export is absent, so they are safe to run anywhere. Generated row dumps go to a temp folder (`$LIA_CHECKS_OUT`, default `$TMPDIR/linkedin-analyzer/checks-out`), never the repo.

```bash
make cleaner-diff                 # web cleaner output unchanged vs main (sha256 per type)
make cleaner-diff args="A B"      # compare two arbitrary git refs
make bench                        # read -> clean -> analytics timing (make bench runs=N)
make bench-decode                 # upload decode layer: speed + byte-identity vs the old path
make xrt-diff                     # Python CLI xlsx vs web cleaner rows, cell by cell
make explore                      # ad-hoc statistics over the export
```

Use `make cleaner-diff` after any change to the web cleaner to prove it is behavior-preserving, and `make bench` as the speed regression anchor. The cross-runtime `make xrt-diff` reads the CLI's `data/output/*.xlsx` (`make run-cli args="all"`) and the dumps from `make cleaner-diff`, so run those two first. `make explore` identifies the export owner for message-direction stats via `$LIA_ME`, falling back to git `user.name`.
