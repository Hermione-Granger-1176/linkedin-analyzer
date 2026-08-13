# CLAUDE.md

LinkedIn Analyzer cleans and analyzes LinkedIn data exports. Two surfaces share one repo: a Python CLI (`src/linkedin_analyzer/`, published to PyPI) and a Vite single-page web app (`web/`, deployed to Vercel). File contents stay local in the web app; diagnostics are opt-in.

## Rules

1. **The Makefile is the only interface.** Always `make <target>`, never the underlying tool. `make help` lists the groups, `make help-<group>` expands one, `make help-json` emits the whole surface for tooling. All of it is generated from the Makefile, so it is never out of date.
2. **If a target is missing, add it.** Put `## description` after the target name and it appears in `make help` automatically.
3. **Do GitHub work through `make pr` / `make git` / `make issue` / `make ci`.** PR number and repo are auto-detected (override with `pr_num=N`). `make pr-review-comments` prints a `thread=PRRT_...` id for each thread; pass it to `make pr-address` to reply and resolve in one step. `make pr-watch request=1` captures a baseline, re-requests Copilot, and waits for a genuinely new review; bare `make pr-watch` only observes the review already there, so after pushing a fix you need `request=1` or it settles on the previous round. Run it in the background. Pass make arguments only, never tool flags like `--jq`.
4. **Text goes in on stdin; a title goes in the environment.** A heredoc is the everyday form:

   ```bash
   make pr-address thread=PRRT_... <<'EOF'
   Fixed in abc123.
   EOF
   ```

   That is the whole convention, for every target that takes prose. Redirect a file (`make pr-comment < notes.md`) when the text is already in one, or when it might contain a line matching the terminator. Set a title alongside it as `TITLE='...' make issue-create < issue.md`.

5. **Each tool has one config file, pointed at directory roots.** Change what gets linted, typed, or tested by editing that tool's config and nothing else: `pyproject.toml` owns ruff, mypy, pytest, coverage, and vulture; `config/` owns ESLint, stylelint, Prettier, Playwright, knip, and jsconfig; `web/` owns Vite and Vitest. Point them at roots or globs so a new file is covered the day it lands. Config-file _locations_ may be named; per-file source lists may not.
6. **Coverage is 100% over `src/linkedin_analyzer` and `scripts`, statements and branches, with no `omit`.** A new script needs its tests in the same change.
7. **Read before acting.** Read the Makefile and the existing code before proposing changes.
8. **Auto-fix commands are the user's call** (`make fmt`, `make align-tables`, `make lock`). To see what a formatter would change, use `make format-py-diff` or `make format-js-diff path=...` and apply it by hand.
9. **Committing, pushing, and opening or merging PRs are the user's call.** Make and verify changes in the working tree and stop there. Fold small tooling or doc tweaks into the branch in progress rather than opening a second PR.
10. **CHANGELOG.md tracks the Python package only.** Web and Node changes do not go there.

## Daily drivers

Enough to work without looking anything up. `make help` has the rest.

| Need                               | Command                                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------------------- |
| Full gate, serial / parallel       | `make ci` / `make ci-fast`                                                              |
| Tests only                         | `make test` (both) / `make test-py` / `make test-js` / `make test-e2e`                  |
| Lint and types                     | `make lint-py` / `make lint-js` / `make typecheck-py`                                   |
| See what a formatter would change  | `make format-py-diff` / `make format-js-diff path=...`                                  |
| Apply every repository formatter   | `make fmt`                                                                              |
| Align Markdown table pipes         | `make align-tables [paths="README.md docs/example.md"]`                                 |
| Workspace health                   | `make status`                                                                           |
| Unused code                        | `make dead-code`                                                                        |
| Dev server                         | `make web`                                                                              |
| New branch off `main`              | `make branch name=X`                                                                    |
| Stage and commit                   | `make stage files="a.py b.py"` then `make commit <<'EOF'`                               |
| Open a PR                          | `make pr-create` (`--fill` from commits) or `TITLE='...' make pr-create <<'EOF'`        |
| Review threads, with `thread=` ids | `make pr-review-comments`                                                               |
| Reply and resolve in one           | `make pr-address thread=PRRT_... <<'EOF'`                                               |
| Wait for a new review and checks   | `make pr-watch request=1` (background)                                                  |
| PR overview                        | `make pr-summary`                                                                       |
| Why CI is red                      | `make ci-failures`                                                                      |
| Issues                             | `make issue-list` / `make issue-view issue=N` / `TITLE='...' make issue-create <<'EOF'` |

## Layout

```text
linkedin-analyzer/
├── api/                         # Vercel functions
├── config/                      # Shared JavaScript and web tool configuration
├── docs/                        # Developer documentation and ADRs
├── scripts/                     # Checks, CI, fixtures, GitHub, lint, and setup tooling
├── src/linkedin_analyzer/       # Published Python package
├── tests/                       # Package, integration, and repository-tooling tests
└── web/
    ├── e2e/                    # Playwright tests
    ├── src/
    │   ├── app/                # Application composition
    │   ├── features/           # User-facing capabilities
    │   ├── platform/           # Browser infrastructure
    │   ├── shared/             # Reused application primitives
    │   └── styles/             # Foundation, feature, and component styles
    └── tests/                  # Vitest tests that mirror source ownership
```

Setup needs Python 3.12+, uv, and Node.js 22.22.2+ or 24.15.0+ within those supported major lines. `make setup` is the fast default; `make setup-all` adds Playwright browsers. On a host without browser libraries, `make setup-playwright-local` builds a private sudo-free runtime and `local_libs=1` routes browser targets through it. Python deps live in `pyproject.toml` (frozen in `uv.lock`), Node deps in `package.json` (frozen in `package-lock.json`).

## Conventions

- Commit subjects: imperative, sentence case, no Conventional Commit prefix; short `-` bullet body for non-trivial commits.
- Branch from `main` with `make branch name=X`; open PRs against `main`.

## Docs

- [`structure.md`](docs/structure.md): full repository layout
- [`development.md`](docs/development.md): local workflow, and why free text travels the way it does
- [`cli.md`](docs/cli.md): Python CLI usage
- [`web-app.md`](docs/web-app.md): web app architecture and deployment
- [`operations.md`](docs/operations.md): production targets, CI, releases, and deployment
- [`style-guide.md`](docs/style-guide.md): coding conventions
- [`adr/`](docs/adr): architecture decision records
