# Operations

This project has three production outputs: a static web app, a Python package, and a CLI container image. The web app deploys separately from the package and image.

## Deploy the web app

Vercel reads the repository configuration from `vercel.json`:

| Setting             | Value                |
| ------------------- | -------------------- |
| Install command     | `npm ci`             |
| Build command       | `npm run build`      |
| Output directory    | `web/dist`           |
| Serverless function | `api/csp-report.mjs` |

The Vite build uses a relative base path. The app can therefore run at a domain root or below a path prefix. The hash router does not need server-side rewrites.

Configure these environment variables in the Vercel project:

| Variable                    | Where it is used                                                   | Required                    |
| --------------------------- | ------------------------------------------------------------------ | --------------------------- |
| `VITE_SENTRY_DSN`           | Browser error diagnostics after user consent                       | Optional                    |
| `VITE_APP_RELEASE`          | Browser diagnostic release grouping                                | Recommended                 |
| `CSP_REPORT_URI`            | Server-side CSP forwarding destination                             | Optional                    |
| `SENTRY_DSN`                | Server-side Sentry CSP destination when `CSP_REPORT_URI` is absent | Optional                    |
| `CSP_REPORT_MAX_PER_MINUTE` | Per-instance valid CSP report limit                                | Optional, defaults to `120` |
| `SENTRY_AUTH_TOKEN`         | Build-time hidden sourcemap upload                                 | Optional                    |
| `SENTRY_ORG`                | Build-time Sentry project selection                                | Optional                    |
| `SENTRY_PROJECT`            | Build-time Sentry project selection                                | Optional                    |

Keep `CSP_REPORT_URI`, `SENTRY_DSN`, and `CSP_REPORT_MAX_PER_MINUTE` server-side. Do not expose them through a `VITE_` variable. The Vite Sentry plugin uploads hidden source maps only when all three build-time Sentry variables are set, then removes the `.map` files from `web/dist`.

After a deploy, confirm that the response includes the headers defined in `vercel.json`:

- `Content-Security-Policy`
- `Reporting-Endpoints`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy`
- `Strict-Transport-Security`
- `Cross-Origin-Opener-Policy`
- `Cross-Origin-Embedder-Policy`
- `Cross-Origin-Resource-Policy`

## Run the web smoke check

Run the HTTP smoke check after each production deploy:

```bash
make web-smoke url=https://your-production-domain.example
```

The check does not install or launch Playwright. It checks the app shell, expected security headers, and a minimal POST to `/api/csp-report` that must return `204`.

The scheduled `web-smoke.yml` workflow runs at 07:00 and 19:00 UTC and on manual dispatch. It reads the `PRODUCTION_URL` repository variable. When the variable is absent, the workflow records a skip instead of treating the repository as unhealthy. When the check fails, the workflow opens or updates the `web-smoke` alert issue. The next checked success closes it.

The smoke check is not an uptime service. Use an external monitor when the web app has an availability target.

## Understand versioning

The Python package and container image derive their version from the Git tag through `hatch-vcs`. The web app's `package.json` version is not the release source of truth. Set `VITE_APP_RELEASE` to the release tag or commit SHA when you build the web app.

Use tags in the form `vX.Y.Z`. The `pypi` environment admits only tags that match `v*`, and the publish workflow compares the built package and image versions with the tag after removing the leading `v`.

## Publish a release

Publish a release only from a commit whose `CI result` check is green.

1. Move the Python package entries from `Unreleased` to a dated version section in `CHANGELOG.md`. Keep web-only changes out because the changelog covers the Python package.
2. Merge the release commit to `main` and wait for the required checks.
3. Create the GitHub Release with the Make target:

```bash
make release-create tag=vX.Y.Z < notes.md
```

Omit the input when you want GitHub to generate release notes. Pass `prerelease=1` for a pre-release.

4. Let `.github/workflows/publish.yml` run from the published release event.
5. Set `VITE_APP_RELEASE` to the same tag or commit on the next web deployment.

The publish workflow first checks the tagged commit's latest successful `CI result`. The PyPI job builds the package, runs `twine check`, installs the wheel, and compares `linkedin-analyzer --version` with the tag. It publishes through PyPI trusted publishing with OIDC and the `pypi` environment. It does not use a stored PyPI API token.

The container job builds `linux/amd64` and `linux/arm64` images, verifies the image version, runs Trivy with every severity enabled and unfixed findings ignored, then pushes these tags:

- `ghcr.io/hermione-granger-1176/linkedin-analyzer:vX.Y.Z`
- `ghcr.io/hermione-granger-1176/linkedin-analyzer:sha-<commit-sha>`
- `ghcr.io/hermione-granger-1176/linkedin-analyzer:latest` for stable releases only

PyPI versions cannot be replaced. The publish job uses `skip-existing: true`, so rerunning a later failed job does not fail because the package already exists.

Before the first release, configure a PyPI trusted publisher for owner `Hermione-Granger-1176`, repository `linkedin-analyzer`, workflow `publish.yml`, and environment `pypi`. Keep the environment field constrained. An unconstrained publisher could accept a token from any repository job and bypass the environment reviewer gate.

## Roll back a release

Roll back each production target separately:

- **Web app:** In Vercel, promote the last known-good deployment. The service worker checks for a new build on the next navigation. A hard reload can request it sooner.
- **PyPI:** Do not reuse the broken version. Yank it when necessary, then publish a new patch version with the fix.
- **GHCR:** Point consumers to the previous immutable version or `sha-<commit-sha>` tag. Re-point `latest` only after the replacement image is available.

Run `make web-smoke` after a web rollback. Check the Sentry release value after any rollback and open a follow-up for the forward fix.

## Understand availability

The service worker can serve the cached shell and static assets after a successful visit. File processing remains local, so the app can clean and analyze already loaded data during a short backend or hosting outage. A first visit still needs the deployed assets.

`api/csp-report.mjs` is non-critical. If it is unavailable, the app can still run and CSP reports are not collected or forwarded.

The browser stores uploads locally when IndexedDB works. A 24-hour inactivity sweep removes stale files and analytics. The browser app does not provide server-side backup or recovery for user data.

## Monitor diagnostics

### Sentry diagnostics

The browser initializes Sentry only when `VITE_SENTRY_DSN` exists and the user grants consent. It sends reduced error events and numeric performance data. The reducer removes file contents, file names, message bodies, contact names, URLs, query strings, DOM text, breadcrumbs, arbitrary rejection values, and SDK attachments.

Set `VITE_APP_RELEASE` during the build so Sentry can group events by release. The metrics buffer flushes when the page becomes hidden and includes only allowlisted nonnegative numbers and positive sample counts.

Treat event volume as a lower bound. Most visitors do not opt in, and no event does not prove that no error occurred. Reproduce a suspected bug locally with a matching fixture before using event counts to judge impact.

### CSP reports

`vercel.json` sends CSP reports to `/api/csp-report` through both `report-uri` and `report-to`. The function accepts POST requests and returns `405` for other methods. It rejects bodies above 64 KiB with `413` and ignores unrecognized report bodies with `204`.

The function reduces each valid report to directives, bounded source metadata, disposition, and nonnegative numeric fields. It strips credentials, URL queries, fragments, sample text, and unknown fields. It forwards to `CSP_REPORT_URI` when set, otherwise it derives a Sentry security endpoint from `SENTRY_DSN`. With no destination, it logs a host-only summary and returns `204`.

`CSP_REPORT_MAX_PER_MINUTE` defaults to 120 valid reports per serverless instance per minute. Set it to `0` to disable that guard. The limit is per instance, not global. Use an edge or WAF rule when you need a global cap.

After configuring forwarding, run `make web-smoke url=https://your-production-domain.example` and verify a test report reaches the collector. Do not send an uploaded file as a test report.

## Protect the supply chain

GitHub Actions references are pinned to full commit SHAs. Pull requests use dependency review, and scheduled audits inspect npm dependencies, Python dependencies resolved from `uv.lock`, and the npm override policy. Both dependency audits fail closed on malformed reports, expired or unused exceptions, ambiguous exceptions, and findings whose configured exception no longer matches. They evaluate every advisory severity, including informational findings.

Review `config/security_audit.json` before changing an exception. Each exception names its ecosystem, package, advisory, reason, and ISO `review_by` date. Set `ignore_only_without_fix` when the exception must stop applying as soon as a package manager reports a fix. Use `make check-overrides` to confirm that npm overrides remain necessary.

The container publish job runs Trivy with every severity enabled and ignores only unfixed findings. A finding with an available fix blocks publication regardless of its severity or whether Trivy classifies it as `UNKNOWN`.

## Understand CI

GitHub Actions runs the primary CI workflow on pull requests and pushes to `main`:

1. `changes` classifies the diff as Python and web areas.
2. `quick-gates` runs formatting, linting, type checks, and repository checks.
3. `heavy-checks` runs tests, dead-code checks, the production web build, and bundle size checks when Python or web code changed.
4. `python-compatibility` tests Python 3.12, 3.13, and 3.14 when the Python area changed.
5. `node-compatibility` tests Node.js 22 and 24 when the web area changed.
6. `web-e2e` runs Playwright in the digest-pinned container when the web area changed.
7. `ci-result` checks that the jobs required by the detected areas ran and succeeded.

The required branch status is `CI result`. Run the same non-browser order locally with:

```bash
make ci-platform-checks
```

Run the full local gate with `make ci`. Add browser tests with `make check`.

The workflow writes Python coverage to `.artifacts/coverage/python-coverage.json` and JavaScript coverage to `coverage/coverage-summary.json`. Print both totals with:

```bash
make ci-coverage-summary
```

## Inspect and operate CI

Use the Make wrappers for Actions operations:

```bash
make ci-runs
make ci-jobs run=123456
make ci-failures run=123456
make ci-watch
make ci-cancel run=123456
make ci-rerun run=123456 failed=1
make ci-dispatch workflow=web-smoke.yml ref=main
```

Use `make ci-caches` to inspect cache sizes. Prefer a cache ID when you run `make ci-cache-delete cache=1234`; a cache key can exist on more than one ref.

Rerunning a workflow keeps its run ID. An artifact-producing workflow must include `github.run_attempt` in artifact names or allow safe overwrites. Use a fresh dispatch when a workflow is not safe to rerun. The primary CI workflow includes attempt-specific Playwright failure artifacts.

## Run scheduled maintenance

The scheduled workflows have these owners and times:

| Workflow                  | Schedule                             | Purpose                                                  |
| ------------------------- | ------------------------------------ | -------------------------------------------------------- |
| `dependency-audit.yml`    | Monday at 06:00 UTC                  | Run npm and Python dependency audits and check overrides |
| `codeql.yml`              | Monday at 06:30 UTC                  | Analyze JavaScript and Python                            |
| `web-smoke.yml`           | 07:00 and 19:00 UTC                  | Check the configured production origin                   |
| `audit-repo-settings.yml` | Monday at 08:23 UTC                  | Check repository settings with the audit GitHub App      |
| `refresh-action-shas.yml` | First day of each month at 03:00 UTC | Refresh CI pins and open a maintenance PR                |
| `schedule-watchdog.yml`   | Push to `main` and manual dispatch   | Detect stale or disabled scheduled workflows             |

Run any workflow with `make ci-dispatch workflow=<workflow-file>`. Scheduled dependency audits fail closed on malformed reports, expired exceptions, unused exceptions, and ambiguous exceptions. The Docker publish scan also gates every severity that Trivy reports when a fix exists.

## Track alert issues

The reusable `alert-issue.yml` workflow keeps one issue per monitored failure. It is called by the dependency audit, web smoke, schedule watchdog, and repository settings audit workflows.

| State           | Meaning                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `open`          | The monitored check found a failure. Create or comment on the matching issue.                                                   |
| `setup-failure` | The workflow failed before it could report on the monitored system. Create or comment on the matching issue with setup wording. |
| `close`         | The monitored check passed after a failure. Close the matching issue with a recovery comment.                                   |

A repeated failure adds a comment instead of replacing the issue body. Give each alert its own label. Do not close an active alert by hand to silence it.

## Protect scheduled automation

GitHub can disable cron workflows after repository inactivity. `schedule-watchdog.yml` runs from a push trigger that GitHub does not disable, then checks that scheduled workflows are active and that their recent schedule runs are within their expected cadence plus grace period.

The watchdog writes a `checked` result before it reports. A failed check after `checked=true` means stale or disabled schedules. A failure before that result means setup failure. This distinction prevents a permission or API problem from opening the wrong alert.

## Refresh Python locks safely

`refresh-python-locks.yml` runs only for a same-repository Dependabot pull request on a `dependabot/uv/` branch. It runs `make lock` and uploads an artifact containing only `uv.lock`.

`commit-python-locks.yml` validates the completed workflow run against the live pull request before it downloads the artifact. It checks the author, repository, ref, SHA, open state, artifact contents, and current branch head. It skips stale or invalid contexts. It fails on unexpected artifact files, directories, or symlinks.

When the primary GitHub App credentials exist, `.github/actions/verified-commit` creates a verified commit or a fallback pull request. When they do not, the workflow records the fallback and can use `GITHUB_TOKEN` for the writeback path.

The validation job receives no write credential. Generated files cross the workflow boundary in a short-lived artifact containing only `uv.lock`, and the write job rechecks the branch SHA before applying it. This prevents a stale or unexpected artifact from overwriting a newer Dependabot commit.

## Refresh CI pins safely

`refresh-action-shas.yml` runs monthly or on manual dispatch. It updates full commit SHAs for GitHub Actions, the Playwright package and matching container image, the pre-commit hook version, and related repository pins. It leaves `uv` as the minimum version in `pyproject.toml`.

The workflow targets the protected default branch with `commit-mode: force-pr`. It uses the escalation App only for the credential check, token creation, and verified writeback. Missing escalation credentials produce a skipped summary instead of a write attempt.

Dependabot owns normal npm, Python, Dockerfile, and GitHub Action updates. The monthly refresh keeps `@playwright/test` paired with its matching container image and refreshes the exact pre-commit hook pin. It deliberately leaves the `uv` minimum version and TypeScript major updates to dedicated changes.

## Audit repository settings

Run the settings audit from a maintainer shell with a GitHub App token that has the read permissions the script needs:

```bash
make ci-audit-repo-settings
make ci-audit-repo-settings repo=owner/name branch=main
```

The audit checks the default branch, security scanning, branch protection, Actions policy and SHA pins, required repository variables and secrets, environments, and the protected version-tag ruleset. It does not read PyPI settings because PyPI has no read API for the trusted publisher. Configure the PyPI publisher with owner `Hermione-Granger-1176`, repository `linkedin-analyzer`, workflow `publish.yml`, and environment `pypi`.

The audit App needs `administration: read`, `secrets: read`, `actions_variables: read`, and `issues: write`, in addition to implicit metadata access. Do not use `GITHUB_TOKEN` for a manual audit because it cannot read the required administration settings.

The audit workflow runs on Monday at 08:23 UTC and on manual dispatch. It skips when `AUDIT_APP_ID` or `AUDIT_APP_PRIVATE_KEY` is absent. It opens or closes the `repo-settings-audit` alert issue when the audit reaches a verdict.

The expected settings include `main` as the default branch, enabled secret scanning and push protection, protected version tags matching `v*`, SHA-pinned Actions, required CI and security checks, review and history protections, required repository variables and secrets, and the `pypi` environment reviewer rule. The audit intentionally cannot inspect the PyPI trusted publisher because PyPI does not expose a read API. Verify that publisher manually with owner `Hermione-Granger-1176`, repository `linkedin-analyzer`, workflow `publish.yml`, and environment `pypi`.

## Keep credentials separate

The repository uses three GitHub Apps with separate roles:

| Role              | Variables and secret                              | Purpose                                                     |
| ----------------- | ------------------------------------------------- | ----------------------------------------------------------- |
| Primary writeback | `APP_ID`, `APP_PRIVATE_KEY`                       | Verified `uv.lock` writeback on Dependabot branches         |
| Escalation        | `ESCALATION_APP_ID`, `ESCALATION_APP_PRIVATE_KEY` | Monthly CI pin refresh pull request                         |
| Audit             | `AUDIT_APP_ID`, `AUDIT_APP_PRIVATE_KEY`           | Read-only repository settings audit and alert issue updates |

Scope each installation to the required repositories. Keep private keys available only to the steps that create an App token or perform the verified writeback.

The primary App writes validated `uv.lock` commits to Dependabot branches. The escalation App creates the protected-branch pin refresh pull request. The audit App reads repository settings and updates alert issues. Do not reuse one App for another role or expose a private key to a whole job when only one step needs it.

## Recover external services

The project is maintained by Aditya Kumar Darak under `Hermione-Granger-1176`. Recovery ownership is distributed across these services:

| Service            | Recovery action                                                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub             | Recover the maintainer account and rotate GitHub App keys when needed.                                                                               |
| Vercel             | Recover the linked account, reconnect the repository, and restore the environment variables in this document.                                        |
| Sentry             | Recover the account and rotate `VITE_SENTRY_DSN`, `SENTRY_AUTH_TOKEN`, or both. Diagnostics are optional, so a Sentry outage does not block the app. |
| PyPI               | Recreate the trusted publisher with environment `pypi`. No long-lived PyPI token is required.                                                        |
| GHCR               | Recover GitHub repository access. The publish workflow uses `GITHUB_TOKEN`.                                                                          |
| Security reporting | Use the private contact in [.github/SECURITY.md](../.github/SECURITY.md).                                                                            |

If the sole maintainer becomes unavailable, a new maintainer can fork the repository and configure new Vercel, Sentry, PyPI, and GitHub App connections. The build does not depend on an unrecoverable shared secret.

## Triage an incident

1. Confirm whether the problem affects the web app, the CLI package, the container image, or repository automation.
2. Check the latest smoke run, CI run, deployment, and release tag.
3. Reproduce with a fixture that has the same file shape. Do not use a real export in a test or issue.
4. Check Sentry only as opt-in evidence. Treat missing events as unknown, not as proof that the path is healthy.
5. Add a regression test before you ship the fix.
6. Update the relevant product, reference, or operations page when behavior or recovery steps change.
