# Operations and Deployment

## Production Targets

- **Web app**: Vercel hosting (`web/dist` plus the optional `api/csp-report` Serverless Function)
- **CLI package**: PyPI publish workflow (`.github/workflows/publish.yml`, OIDC trusted publishing)
- **Container image**: GHCR multi-arch publish (`linux/amd64`, `linux/arm64`)

## Web Deployment (Vercel)

1. Connect the repository in Vercel.
2. Build command: `npm run build`, as configured in `vercel.json`. Use `make web-build` for local builds.
3. Output directory: `web/dist`
4. Add environment variables:
   - `VITE_SENTRY_DSN` (optional; only used after user opt-in)
   - `VITE_APP_RELEASE` (recommended, e.g. commit SHA)
   - `CSP_REPORT_URI` or `SENTRY_DSN` (optional, server-side only; enables CSP report forwarding; see [CSP violation reporting](#csp-violation-reporting))
   - `CSP_REPORT_MAX_PER_MINUTE` (optional, server-side only; defaults to 120, use 0 to disable the per-instance CSP report guard)
5. Verify custom headers from `vercel.json` are applied after deploy.

The `api/csp-report` Serverless Function deploys automatically from the `api/` directory; no extra Vercel configuration is required.

## Post-Deploy Smoke Check

Run the lightweight smoke check after each production deploy:

```bash
make web-smoke url=https://your-production-domain.example
```

The check uses HTTP only, so it does not install or run Playwright. It verifies that the app shell loads, key security headers are present, and `/api/csp-report` accepts a minimal CSP report with HTTP 204.

## Versioning

Two independent version identifiers exist by design:

- **Python CLI / Docker image:** Derived from the Git tag at build time via `hatch-vcs` (`pyproject.toml`, `[tool.hatch.version] source = "vcs"`). Tagging a release is the single source of truth; do not hand-edit a version.
- **Web app:** The `package.json` `version` is cosmetic only. The value that matters in production is `VITE_APP_RELEASE` (recommended: the commit SHA or release tag), which is what Sentry correlates errors against. Set it per build rather than relying on `package.json`.

When cutting a release, the Git tag drives the PyPI and GHCR versions; set `VITE_APP_RELEASE` to the same tag/SHA so web telemetry lines up with the CLI release.

## Cutting a Release

Releases are tag-driven: pushing a GitHub Release publishes the PyPI package and the GHCR image from that tag. `hatch-vcs` derives the version from the tag, so there is no version number to hand-edit.

1. **Roll the changelog.** Move the `## [Unreleased]` entries in `CHANGELOG.md` into a new `## [X.Y.Z]` section with the date. Keep web-only changes out (the changelog is Python-package-only). Leave a fresh empty `Unreleased` heading.
2. **Confirm green CI on the release commit.** `publish.yml`'s `require-ci` job refuses to publish unless the tagged commit's latest `CI result` check concluded `success`. Merge to `main` and let CI finish first, then tag that commit.
3. **Tag and create the GitHub Release.** Tag `vX.Y.Z` on the release commit and publish a GitHub Release (the workflow triggers on `release: published`). Mark pre-releases as **prerelease** so the floating `:latest` Docker tag is not re-pointed (`publish.yml` only adds `:latest` for non-prereleases; `:vX.Y.Z` and `:sha-<sha>` are always pushed).
4. **Let the workflow self-verify.** `publish-pypi` builds, runs `twine check`, installs the wheel, and fails if `linkedin-analyzer --version` does not match the tag (minus the leading `v`); `publish-docker` repeats the version check on the built image and runs a Trivy HIGH/CRITICAL scan before pushing.
5. **Set `VITE_APP_RELEASE`** on the next web build to the same tag/SHA so Sentry correlates web errors to the release (see Versioning above).

Re-run-failed-jobs caveat: `gh-action-pypi-publish` runs with `skip-existing: true`, so if a later job (for example the Trivy scan) fails after PyPI already accepted the upload, you can safely re-run the failed jobs. The already-published distribution is skipped rather than erroring. PyPI versions are immutable; to fix a bad release, roll forward with a new patch tag (see Rollback).

## Availability

- The web app is a PWA: once a visitor has loaded it, the service worker (`web/src/sw.js`) serves the cached shell, so the app stays usable offline and during a brief Vercel outage. File processing is fully client-side, so a backend outage does not block cleaning or analysis of already-loaded data.
- The only server-side surface is the `api/csp-report` function, which is best-effort and non-critical: if it is down, CSP reports are simply not collected and nothing user-facing breaks.
- There is no built-in uptime monitor. If availability SLAs matter, point an external monitor (for example a simple HTTPS check) at the production URL; Vercel also exposes deployment/health status in its dashboard.

## Rollback

Each release surface rolls back independently.

- **Web app (Vercel):** In the Vercel dashboard, open the project's Deployments, find the last known-good deployment, and use **Promote to Production** (or `vercel rollback <deployment-url>`). The PWA service worker auto-refreshes clients to the promoted build; a hard reload forces it immediately.
- **PyPI (CLI):** Releases are immutable and a version cannot be re-uploaded. Roll forward by tagging a new patch release that reverts the offending change. If a release is actively harmful, `yank` it on PyPI so pip stops resolving to it while leaving existing pins working.
- **GHCR (container):** Re-point `latest` by pushing the prior good tag, or instruct consumers to pin the previous immutable `:<version>` / `:sha-<sha>` tag (both are published by `publish.yml`).

After any rollback, confirm the active release in Sentry via the `release` tag and open a follow-up to roll forward with a fix.

## Observability

### Sentry setup

- Configure `VITE_SENTRY_DSN` in each environment if you want opt-in diagnostics.
- Set `VITE_APP_RELEASE` during builds to correlate errors with deploys.
- Sentry captures:
  - unhandled runtime errors and rejections
  - page/module errors from guarded operations
  - selected performance telemetry (`web-vitals` + custom performance measures), buffered per session and sent as a single numeric-only `session-metrics` event on page hide (rather than one event per measure) to conserve quota

### CSP violation reporting

The `Content-Security-Policy` header in `vercel.json` enforces a strict policy and reports violations via `report-uri` / `report-to` to the first-party endpoint `/api/csp-report` (`Reporting-Endpoints: csp-endpoint`). Keeping the endpoint same-origin means `vercel.json` never embeds a Sentry org/project and the forwarding secret stays server-side.

- The collector (`api/csp-report.mjs`) forwards reports only when `CSP_REPORT_URI` (explicit collector URL) or `SENTRY_DSN` (server-side DSN) is configured; with neither set it accepts and drops reports so the policy stays valid.
- The collector has a per-instance report guard controlled by `CSP_REPORT_MAX_PER_MINUTE`; it defaults to 120 valid CSP reports per minute and returns 204 without forwarding or logging reports over the cap.
- Reports contain only violation metadata (blocked URI, violated directive, document URI), never uploaded file contents, so this does not change the app's local-only data guarantee.
- To verify after deploy, run `make web-smoke url=https://your-production-domain.example`, load the site, and confirm there are no unexpected CSP violations in the browser console. If forwarding is configured, confirm a test violation reaches the collector.

### Recommended alerting

- Create alerts for:
  - spike in `Unhandled error` events
  - spike in worker parse failures (`module` extra fields)
  - regression in web-vitals (`metric:web-vital:*` extras on `session-metrics` events)

### Observability blind spot (opt-in telemetry)

Diagnostics are **off until the user explicitly grants consent** (telemetry banner / footer toggle), and consent can be revoked at any time. In practice most visitors never opt in, so:

- Absence of Sentry events does **not** mean the absence of errors. It usually means no consenting users hit the path.
- Error volume is a lower bound, not a true rate; do not size incident severity from event counts alone.
- For a reproducible bug, prefer local reproduction with a matching fixture over waiting for telemetry to surface it.
- CSP violations are the one signal that does not depend on consent: they flow through `/api/csp-report` regardless (see above).

## Security and Supply Chain

- CI actions are SHA-pinned.
- Dependency review runs on pull requests.
- Scheduled dependency audits run weekly for npm and Python dependencies resolved from `uv.lock`.
- The weekly generic override-policy check verifies that any future npm overrides remain necessary; no overrides are currently configured (`make check-overrides`; see [ADR-001](adr/001-npm-overrides-for-transitive-dependency-gaps.md)).
- Docker image publish includes Trivy scan for HIGH/CRITICAL vulnerabilities.

## CI Automation and Verified Writebacks

The workflow structure mirrors the stricter automation pattern used in the `artifacts` repository:

- Pull-request verification is separated from writeback jobs.
- Generated maintenance changes are passed through short-lived workflow artifacts before any commit is created.
- Writeback jobs re-check the PR branch SHA before applying generated files, so stale artifacts cannot overwrite newer commits.
- Automated commits use `.github/actions/verified-commit`, which creates GitHub-verified commits through the API and can fall back to a PR branch.

Configured automation:

- `refresh-action-shas.yml` runs monthly or manually and converts tag-based workflow/action `uses:` refs to full commit SHAs. It leaves already pinned refs unchanged; Dependabot updates action versions.
- `refresh-python-locks.yml` refreshes `uv.lock` for same-repository Dependabot uv PRs.
- `commit-python-locks.yml` downloads the refreshed lock artifact from the completed workflow run, validates its contents, revalidates the Dependabot branch head, and commits `uv.lock` back only if it is still safe.

To enable app-authored maintenance commits, configure these repository values:

- Repository variable: `APP_ID`
- Repository secret: `APP_PRIVATE_KEY`

If they are missing, the action-SHA refresh workflow records a skipped summary instead of attempting a write.

## CLI Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `LINKEDIN_ANALYZER_DATA_DIR` | `data` | Base directory for input/output file paths |
| `LINKEDIN_ANALYZER_MAX_INPUT_BYTES` | `104857600` | Maximum input CSV size in bytes; `0` disables the limit |
| `LINKEDIN_ANALYZER_MAX_ROWS` | `1000000` | Maximum parsed row count; `0` disables the limit |
| `LOG_LEVEL` | `INFO` | Logging level (DEBUG, INFO, WARNING, ERROR, CRITICAL) |
| `LOG_FORMAT` | `text` | Log output format: `text` for human-readable, `json` for structured JSON |

### Structured JSON logging

Set `LOG_FORMAT=json` (or pass `--log-format json`) to emit one JSON object per log line:

```json
{
  "timestamp": "2026-03-05 12:00:00,000",
  "level": "INFO",
  "logger": "linkedin_analyzer",
  "message": "Processing Shares..."
}
```

This is recommended for production/container deployments where logs are ingested by a log aggregator.

## One-Time External Setup

- Configure PyPI trusted publishing for this repository (OIDC) so `publish.yml` can publish without `PYPI_API_TOKEN`.

## Incident Triage Checklist

1. Confirm scope and blast radius from Sentry events.
2. Correlate to release via `release` tag (`VITE_APP_RELEASE`).
3. Reproduce locally with same fixture/data shape when possible.
4. Add regression tests before shipping fix.
5. Backfill docs if behavior/runbook changed.
