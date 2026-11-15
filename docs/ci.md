# CI and repository automation

GitHub Actions runs the checks, scheduled audits, and maintenance pull requests for this repository. Use the Make wrappers in [GitHub helpers](github-helpers.md) to inspect and rerun workflows.

## Understand CI

GitHub Actions runs the primary CI workflow on pull requests and pushes to `main`:

1. `changes` classifies the diff as Python and web areas.
2. `quick-gates` runs formatting, linting, type checks, and repository checks.
3. `heavy-checks` runs tests, dead-code checks, the production web build, and bundle size checks when Python or web code changed.
4. `python-compatibility` tests Python 3.12, 3.13, and 3.14 when the Python area changed.
5. `node-compatibility` tests Node.js 22 and 24 when the web area changed.
6. `web-e2e` runs Playwright in the digest-pinned container when the web area changed.
7. `web-benchmark` runs `make bench-compare` against the base commit when the web area changed. It fails when the analysis pipeline slows beyond its noise allowance. The report appears in the job summary. [Benchmarks](benchmarks.md#compare-performance-against-main) explains how to read it.
8. `web-page-speed` runs `make bench-browser-container` when the web area changed. It fails when the median time from file drop to the Analytics screen showing data exceeds its budget. [Benchmarks](benchmarks.md#check-page-speed-in-ci) explains the budget.
9. `ci-result` checks that the jobs required by the detected areas ran and succeeded.

The required branch status is `CI result`. Run the same non-browser order locally with:

```bash
make ci-platform-checks
```

Run the full local gate with `make ci`. Add browser tests with `make check`.

The workflow writes Python coverage to `.artifacts/coverage/python-coverage.json` and JavaScript coverage to `coverage/coverage-summary.json`. Print both totals with:

```bash
make ci-coverage-summary
```

## Understand CI path gating

GitHub Actions classifies changed paths into Python, Web, Both, or Neither. Quick gates always run. Heavy checks, compatibility matrices, and browser checks run when their area changed. An unrecognized path fails open to Both, so a new top-level area receives the full matrix until a rule in the table below matches it.

### Which jobs run for a change

The classifier in `scripts/ci/job_gating.py` applies every matching rule, not only the first. For example, `.github/SECURITY.md` matches both `.github/` and `*.md`, so it runs Both.

| Paths                                                                                                                                                                                         | Area    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `src/`, `tests/package/`, `tests/integration/`, `tests/support/`, `tests/__init__.py`, `pyproject.toml`, `uv.lock`                                                                            | Python  |
| `web/`, `api/`, `config/`, `package.json`, `package-lock.json`, `vercel.json`                                                                                                                 | Web     |
| `Makefile`, `.github/`, `scripts/`, `tests/tooling/`, `tests/fixtures/`, `constraints/`, `Dockerfile`, `.dockerignore`, `.editorconfig`, `.npmrc`, `.pre-commit-config.yaml`, `.yamllint.yml` | Both    |
| `.agents/skills/`, `docs/`, any `*.md`, `data/`, `LICENSE`, `.gitignore`, `.env.example`                                                                                                      | Neither |
| anything else                                                                                                                                                                                 | Both    |

`tests/fixtures/` is Both because the browser parity suite reads it. Renames count as a delete plus an add (`--no-renames`), so both paths set the area.

## Inspect and operate CI

Use the Make wrappers for Actions operations:

```bash
make ci-runs
make ci-jobs
make ci-failures
make ci-watch
make ci-cancel run=123456
make ci-rerun failed=1
make ci-dispatch workflow=web-smoke.yml ref=main
```

`make ci-jobs`, `make ci-failures`, `make ci-watch`, and `make ci-rerun` act on the current branch's latest run. Pass `run=ID` to target another run. `make ci-cancel` always needs `run=ID`. `make ci-watch` exits non-zero when the run fails.

Use `make ci-caches` to inspect cache sizes. Delete a cache by ID with `make ci-cache-delete cache=1234`. A cache key can exist on more than one ref.

Rerunning a workflow keeps its run ID, so an artifact-producing workflow must include `github.run_attempt` in artifact names or allow safe overwrites. Dispatch a fresh run instead when a workflow is not safe to rerun. The primary CI workflow names its Playwright failure artifacts with the attempt number.

## Run scheduled maintenance

The scheduled workflows have these owners and times:

| Workflow                  | Schedule                             | Purpose                                                  |
| ------------------------- | ------------------------------------ | -------------------------------------------------------- |
| `dependency-audit.yml`    | Monday at 06:00 UTC                  | Run npm and Python dependency audits and check overrides |
| `codeql.yml`              | Monday at 06:30 UTC                  | Analyze JavaScript and Python                            |
| `web-smoke.yml`           | 07:00 and 19:00 UTC                  | Check the configured production origin                   |
| `audit-repo-settings.yml` | Monday at 08:23 UTC                  | Check repository settings with the audit GitHub App      |
| `refresh-action-shas.yml` | First day of each month at 03:00 UTC | Refresh CI pins and open a maintenance PR                |
| `schedule-watchdog.yml`   | Push to `main` and manual dispatch   | Detect disabled scheduled workflows                      |

`web-smoke.yml` reads the `PRODUCTION_URL` repository variable. It records a skip when the variable is absent.

## Track alert issues

The reusable `alert-issue.yml` workflow keeps one issue per monitored failure. The dependency audit, web smoke, schedule watchdog, and repository settings audit workflows call it.

| State           | Meaning                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `open`          | The monitored check found a failure. Create or comment on the matching issue.                                                   |
| `setup-failure` | The workflow failed before it could report on the monitored system. Create or comment on the matching issue with setup wording. |
| `close`         | The monitored check passed after a failure. Close the matching issue with a recovery comment.                                   |

A repeated failure adds a comment instead of replacing the issue body. Give each alert its own label. Do not close an active alert by hand to silence it.

## Automation safety

### Schedule watchdog

GitHub can disable cron workflows after repository inactivity. `schedule-watchdog.yml` runs from a push trigger, which GitHub does not disable. It finds YAML workflows that declare cron schedules and checks whether each one is enabled. It does not read run history or infer failures from run age, so an active workflow that stops firing is outside this check. Web smoke keeps its own failure and recovery alerts.

The watchdog writes a `checked` result before it reports. A failed check after `checked=true` means disabled schedules. A failure before that result means setup failure.

### Python lock refresh

`refresh-python-locks.yml` runs only for a same-repository Dependabot pull request on a `dependabot/uv/` branch. It runs `make lock` and uploads an artifact containing only `uv.lock`.

`commit-python-locks.yml` validates the completed workflow run against the live pull request before it downloads the artifact. It checks the author, repository, ref, SHA, open state, artifact contents, and current branch head. It skips stale or invalid contexts. It fails on unexpected artifact files, directories, or symlinks.

When the primary GitHub App credentials exist, `.github/actions/verified-commit` creates a verified commit or a fallback pull request. When they do not, the workflow records the fallback and can use `GITHUB_TOKEN` for the writeback path.

The validation job receives no write credential. Generated files cross the workflow boundary in a short-lived artifact containing only `uv.lock`. The write job rechecks the branch SHA before it applies the file.

### CI pin refresh

`refresh-action-shas.yml` runs monthly or on manual dispatch. It updates full commit SHAs for GitHub Actions, the Playwright package and matching container image, the pre-commit hook version, and related repository pins.

The workflow targets the protected default branch with `commit-mode: force-pr`. It uses the escalation App only for the credential check, token creation, and verified writeback. Missing escalation credentials produce a skipped summary instead of a write attempt.

Dependabot owns normal npm, Python, Dockerfile, and GitHub Action updates. The monthly refresh keeps `@playwright/test` paired with its matching container image and refreshes the exact pre-commit hook pin. It leaves the `uv` minimum version in `pyproject.toml` and TypeScript major updates to dedicated changes.

## Audit repository settings and credentials

Run the settings audit from a maintainer shell with a GitHub App token that has the read permissions the script needs:

```bash
make ci-audit-repo-settings
make ci-audit-repo-settings repo=owner/name branch=main
```

The audit checks the default branch, security scanning, branch protection, Actions policy and SHA pins, required repository variables and secrets, environments, and the protected version-tag ruleset. Verify the [PyPI trusted publisher](operations.md#publish-a-release) manually because PyPI has no read API for that setting.

The audit App needs `administration: read`, `secrets: read`, `actions_variables: read`, and `issues: write`, in addition to implicit metadata access. Do not use `GITHUB_TOKEN` for a manual audit because it cannot read the required administration settings.

The scheduled audit skips when `AUDIT_APP_ID` or `AUDIT_APP_PRIVATE_KEY` is absent. When the audit reaches a verdict, it opens or closes the `repo-settings-audit` alert issue.

The repository uses three GitHub Apps with separate roles:

| Role              | Variables and secret                              | Purpose                                                     |
| ----------------- | ------------------------------------------------- | ----------------------------------------------------------- |
| Primary writeback | `APP_ID`, `APP_PRIVATE_KEY`                       | Verified `uv.lock` writeback on Dependabot branches         |
| Escalation        | `ESCALATION_APP_ID`, `ESCALATION_APP_PRIVATE_KEY` | Monthly CI pin refresh pull request                         |
| Audit             | `AUDIT_APP_ID`, `AUDIT_APP_PRIVATE_KEY`           | Read-only repository settings audit and alert issue updates |

Scope each installation to the required repositories. Keep private keys available only to the steps that create an App token or perform the verified writeback. Do not reuse one App for another role.

## Protect the supply chain

Run `make security` to audit npm dependencies, Python dependencies from `uv.lock`, and npm overrides. The [scheduled audit](#run-scheduled-maintenance) checks every advisory severity and opens an [alert issue](#track-alert-issues) on failure. Invalid audit reports and expired, unused, or ambiguous exceptions fail the audit.

Review `config/security_audit.json` before changing an exception. Each entry requires a package, advisory, reason, and ISO `review_by` date. Set `ignore_only_without_fix` when a reported fix must invalidate the exception.

Run `make check-overrides` to test removal in a temporary dependency tree without changing the repository. List direct development dependencies added solely for `$name` overrides in `npm_override_dev_dependencies` so the trial removes them too. An unneeded override fails the check, and the scheduled audit raises an alert for it. Record each override's rationale, compatibility evidence, and removal criteria in an [ADR](adr/README.md).
