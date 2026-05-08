# Operations and Deployment

## Production Targets

- **Web app**: static hosting on Vercel (`web/dist`)
- **CLI package**: PyPI publish workflow (`.github/workflows/publish.yml`, OIDC trusted publishing)
- **Container image**: GHCR multi-arch publish (`linux/amd64`, `linux/arm64`)

## Web Deployment (Vercel)

1. Connect the repository in Vercel.
2. Build command: `npm run build`
3. Output directory: `web/dist`
4. Add environment variables:
   - `VITE_SENTRY_DSN` (optional; only used after user opt-in)
   - `VITE_APP_RELEASE` (recommended, e.g. commit SHA)
5. Verify custom headers from `vercel.json` are applied after deploy.

## Observability

### Sentry setup

- Configure `VITE_SENTRY_DSN` in each environment if you want opt-in diagnostics.
- Set `VITE_APP_RELEASE` during builds to correlate errors with deploys.
- Sentry captures:
  - unhandled runtime errors and rejections
  - page/module errors from guarded operations
  - selected performance telemetry (`web-vitals` + custom performance measures)

### Recommended alerting

- Create alerts for:
  - spike in `Unhandled error` events
  - spike in worker parse failures (`module` extra fields)
  - regression in web-vitals (`web-vital:*` metric messages)

## Security and Supply Chain

- CI actions are SHA-pinned.
- Dependency review runs on pull requests.
- Scheduled dependency audits run weekly for npm and Python dependencies resolved from `uv.lock`.
- Weekly override staleness check flags npm overrides that can be removed (`make check-overrides`; see [ADR-001](adr/001-npm-overrides-for-transitive-dependency-gaps.md)).
- Docker image publish includes Trivy scan for HIGH/CRITICAL vulnerabilities.

## CI Automation and Verified Writebacks

The workflow structure mirrors the stricter automation pattern used in the `artifacts` repository:

- Pull-request verification is separated from writeback jobs.
- Generated maintenance changes are passed through short-lived workflow artifacts before any commit is created.
- Writeback jobs re-check the PR branch SHA before applying generated files, so stale artifacts cannot overwrite newer commits.
- Automated commits use `.github/actions/verified-commit`, which creates GitHub-verified commits through the API and can fall back to a PR branch.

Configured automation:

- `refresh-action-shas.yml` runs monthly or manually and pins workflow/action `uses:` refs to full commit SHAs.
- `refresh-python-locks.yml` refreshes `uv.lock` for same-repository Dependabot uv PRs.
- `commit-python-locks.yml` downloads the refreshed lock artifact from the completed workflow run, validates its contents, revalidates the Dependabot branch head, and commits `uv.lock` back only if it is still safe.

To enable app-authored maintenance commits, configure these repository values:

- Repository variable: `APP_ID`
- Repository secret: `APP_PRIVATE_KEY`

If they are missing, the action-SHA refresh workflow records a skipped summary instead of attempting a write.

## CLI Environment Variables

| Variable                     | Default | Description                                                               |
| ---------------------------- | ------- | ------------------------------------------------------------------------- |
| `LINKEDIN_ANALYZER_DATA_DIR` | `data`  | Base directory for input/output file paths                                |
| `LOG_LEVEL`                  | `INFO`  | Logging level (DEBUG, INFO, WARNING, ERROR, CRITICAL)                     |
| `LOG_FORMAT`                 | `text`  | Log output format — `text` for human-readable, `json` for structured JSON |

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
