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
   - `VITE_SENTRY_DSN` (optional but recommended)
   - `VITE_APP_RELEASE` (recommended, e.g. commit SHA)
5. Verify custom headers from `vercel.json` are applied after deploy.

## Observability

### Sentry setup

- Configure `VITE_SENTRY_DSN` in each environment.
- Set `VITE_APP_RELEASE` during builds to correlate errors with deploys.
- Sentry captures:
  - unhandled runtime errors and rejections
  - page/module errors from guarded operations
  - selected performance telemetry (`web-vitals` + measured spans)

### Recommended alerting

- Create alerts for:
  - spike in `Unhandled error` events
  - spike in worker parse failures (`module` extra fields)
  - regression in web-vitals (`web-vital:*` metric messages)

## Security and Supply Chain

- CI actions are SHA-pinned.
- Dependency review runs on pull requests.
- Scheduled dependency audits run weekly for npm and pip.
- Docker image publish includes Trivy scan for HIGH/CRITICAL vulnerabilities.

## One-Time External Setup

- Configure PyPI trusted publishing for this repository (OIDC) so `publish.yml` can publish without `PYPI_API_TOKEN`.

## Incident Triage Checklist

1. Confirm scope and blast radius from Sentry events.
2. Correlate to release via `release` tag (`VITE_APP_RELEASE`).
3. Reproduce locally with same fixture/data shape when possible.
4. Add regression tests before shipping fix.
5. Backfill docs if behavior/runbook changed.
