# CLAUDE.md

LinkedIn Analyzer cleans and analyzes LinkedIn data exports. Two surfaces share one repo: a Python CLI (`src/linkedin_analyzer/`, published to PyPI) and a Vite single-page web app (`web/`, deployed to Vercel). File contents stay local in the web app; diagnostics are opt-in.

## Rules

1. **The Makefile is the only interface.** Never run `.venv/bin/*`, `pytest`, `ruff`, `mypy`, `npm run`, `npx`, `vite`, `playwright`, or `gh` directly. Always use `make <target>`. If unsure what's available, run `make help` first — the list is auto-generated from the Makefile.
2. **Use the `make pr`/`make git`/`make ci` targets for GitHub work.** Prefer `make pr-create`, `make pr-review-comments`, `make pr-address`, `make pr-summary`, `make ci-failures` over raw `gh`. `make pr-review-comments` prints a `thread=PRRT_...` id for each review thread; pass that id straight to `make pr-reply thread=... body="..."`, `make pr-resolve thread=...`, or `make pr-address thread=... body="..."` (reply + resolve in one) — no `databaseId` lookup needed. The PR number is auto-detected from the current branch (override with `pr_num=N`). Never pass extra flags like `--jq` to a make target, since make parses them itself and errors.
3. **If a target is missing, add it.** Put `## description` after the target name in the Makefile and it appears in `make help` automatically.
4. **Each tool has one config file.** To change what gets linted/tested/typed, edit that tool's config, nowhere else. See the tool configuration table below.
5. **Configs auto-discover from roots; never enumerate files.** Point tools at directory roots or globs (like coverage's `source = ["src/linkedin_analyzer"]`) so new files are covered automatically. Don't list individual source files — that rots the day someone adds a file and forgets. Tool _config-file_ location pointers (e.g. knip's `vite.config`) are fine; per-file source lists are not.
6. **Read before acting.** Read the Makefile and existing code before proposing changes.
7. **Don't run auto-fix commands** (`make fmt`, `make lock`, etc.) unless the user asks.
8. **Don't commit, push, or open/merge PRs unless asked.** Make and verify changes in the working tree and stop there; the user decides when to commit and push. For small tooling/doc tweaks, fold them into the current in-progress branch instead of opening a separate PR.
9. **CHANGELOG.md is Python-only.** It tracks the `linkedin-analyzer` package; do not add web/Node changes there.

## Structure

- `src/linkedin_analyzer/`: Python package — `cli.py`, `core/` (text, types, paths, cleaner, excel), `cleaners/` (comments, connections, messages, shares)
- `web/`: Vite SPA — `src/` (router, screens, cleaner, storage, telemetry, sentry), `index.html` shell, `tests/` (Vitest unit), `e2e/` (Playwright), `vite.config.js`, `vitest.config.js`
- `api/`: Vercel Serverless Functions — `csp-report.mjs` collects CSP violation reports
- `tests/`: Python tests
- `scripts/`: repo tooling
- `config/`: shared JS/web tool configs (eslint, prettier, playwright, jsconfig)
- `docs/`: developer documentation (see Docs below)

## Local commands

**Run `make help` for the command groups, then `make help-<group>` to expand one** (e.g. `make help-pr`, `make help-ci`); `make help-json` emits the whole surface as JSON for tooling. Groups: setup, lint, format, typecheck, test, web, quality, deps, util, git, pr, ci. Everything is generated from `## comment` annotations and `# ─── Title @slug ───` section headers in the Makefile.

Key entry points (requires Python 3.11+, uv, and Node.js 22.13.x or 24+):

- `make setup`: fast default (Python + Node deps, no Playwright browsers)
- `make setup-all`: full setup including Playwright browsers
- `make ci`: full local CI gate (`check-local` is an alias)
- `make check`: full gate including browser tests
- `make ci-python` / `make ci-web`: per-surface CI gates
- `make test`: non-browser Python + JS tests; `make test-e2e` for Playwright
- `make dead-code`: detect unused code (vulture for Python, knip for JS)
- `make fmt`: auto-fix Python, JS, and metadata formatting
- `make web`: start the Vite dev server
- `make security`: dependency and override audits
- `make pr` / `make git` / `make ci`: drill into PR, git, and CI sub-commands
- `make status`: quick workspace health check

Python deps live in `pyproject.toml` (frozen in `uv.lock`); Node deps in `package.json` (frozen in `package-lock.json`). Refresh with `make lock` / `make lock-node`.

## Common commands

High-frequency loops (full surface via `make help`). The PR/CI targets wrap a tested Python helper in `scripts/gh/`; PR number and repo are auto-detected.

| Need | Command |
| --- | --- |
| Review threads (with `thread=` ids) | `make pr-review-comments` |
| Reply to **and** resolve a thread | `make pr-address thread=PRRT_... body="..."` |
| Reply only / resolve only | `make pr-reply thread=PRRT_... body="..."` / `make pr-resolve thread=PRRT_...` |
| PR overview (state, CI, open threads) | `make pr-summary` |
| Why is CI red | `make ci-failures` |
| New branch off `main` | `make branch name=X` |
| Full local gate / parallel | `make ci` / `make ci-fast` |
| Discover commands | `make help` → `make help-<group>` → `make help-json` |

## Tool configuration

Each tool has one config file that owns its scope. The Makefile just calls tools.

| Tool       | Config (source of truth)      | What it defines                                 |
| ---------- | ----------------------------- | ----------------------------------------------- |
| ruff       | `pyproject.toml`              | Python lint/format rules                        |
| mypy       | `pyproject.toml`              | Python type checking                            |
| pytest     | `pyproject.toml`              | Test paths and options                          |
| coverage   | `pyproject.toml`              | Coverage source and report thresholds           |
| vulture    | `pyproject.toml`              | Python dead-code detection                      |
| ESLint     | `config/eslint.config.mjs`    | JS lint rules                                   |
| Prettier   | `config/prettierrc.json`      | JS/JSON/MD/YAML formatting (+ `prettierignore`) |
| Playwright | `config/playwright.config.js` | Browser e2e test config                         |
| Vite       | `web/vite.config.js`          | Web build + generated PWA manifest              |
| Vitest     | `web/vitest.config.js`        | Web unit test config                            |
| jsconfig   | `config/jsconfig.json`        | JS editor/type hints                            |
| knip       | `config/knip.json`            | JS dead-code, unused exports and deps           |

## Deployment

- **Web app**: Vercel hosting (`web/dist` plus the `api/csp-report` Serverless Function). `vercel.json` sets security headers, CSP, and `Reporting-Endpoints` → `/api/csp-report`.
- **CLI package**: PyPI via `.github/workflows/publish.yml` (OIDC trusted publishing)
- **Container image**: GHCR multi-arch publish (`linux/amd64`, `linux/arm64`)

## Docs

Developer documentation lives in `docs/`:

- [`structure.md`](docs/structure.md): full repository layout
- [`development.md`](docs/development.md): local development workflow
- [`cli.md`](docs/cli.md): Python CLI usage
- [`web-app.md`](docs/web-app.md): web app architecture and deployment
- [`operations.md`](docs/operations.md): production targets, CI, and operations
- [`style-guide.md`](docs/style-guide.md): coding conventions
- [`adr/`](docs/adr): architecture decision records

## Conventions

- Commit subjects: imperative, sentence case, no Conventional Commit prefix; short `-` bullet body for non-trivial commits.
- Branch from `main` with `make branch name=X`; open PRs against `main`.
