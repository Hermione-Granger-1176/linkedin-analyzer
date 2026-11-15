# Operations

This project has three production outputs: a static web app, a Python package, and a CLI container image. The web app deploys separately from the package and image. CI workflows, scheduled automation, and alert issues are in [CI and repository automation](ci.md).

## Deploy the web app

Vercel reads the repository configuration from `vercel.json`:

| Setting             | Value                   |
| ------------------- | ----------------------- |
| Install command     | `npm ci`                |
| Build command       | `npm run build`         |
| Output directory    | `web/dist`              |
| Serverless function | `api/csp-report.mjs`    |
| Serverless function | `api/sentry-tunnel.mjs` |

The Vite build uses a relative base path, so the app runs at a domain root or under a path prefix. The hash router needs no server-side rewrites.

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

The scheduled `web-smoke.yml` workflow runs this check against `PRODUCTION_URL`. Its schedule and alert behavior are in [CI and repository automation](ci.md#run-scheduled-maintenance).

The smoke check is not an uptime service. Use an external monitor when the web app has an availability target.

## Understand versioning

The Python package and container image derive their version from the Git tag through `hatch-vcs`. The web app's `package.json` version is not the release source of truth. Set `VITE_APP_RELEASE` to the release tag or commit SHA when you build the web app.

Use tags in the form `vX.Y.Z`. The `pypi` environment admits only tags that match `v*`, and the publish workflow compares the built package and image versions with the tag after removing the leading `v`.

## Publish a release

Publish a release only from a commit whose `CI result` check is green.

1. Move the Python package entries from `Unreleased` to a dated version section in `CHANGELOG.md`. Leave out web-only changes.
2. Merge the release commit to `main` and wait for the required checks.
3. Create the GitHub Release with the Make target:

```bash
make release-create tag=vX.Y.Z < notes.md
```

Omit the input when you want GitHub to generate release notes. Pass `prerelease=1` for a pre-release.

4. Let `.github/workflows/publish.yml` run from the published release event.
5. Set `VITE_APP_RELEASE` to the same tag or commit on the next web deployment.

The publish workflow first checks the tagged commit's latest successful `CI result`. Then two jobs run:

- `build-python` builds the package, runs `twine check`, installs the wheel, compares `linkedin-analyzer --version` with the tag, and uploads `dist/` as an artifact. It has no `id-token` permission.
- `publish-pypi` holds the `pypi` environment and `id-token: write`. It installs nothing and runs two SHA-pinned actions, `actions/download-artifact` and `pypa/gh-action-pypi-publish`. The publish action uploads through PyPI trusted publishing with OIDC. The workflow stores no PyPI API token.

The job split is explained in [ADR-006](adr/006-hatch-vcs-versioning-and-gated-publishing.md).

The container job builds `linux/amd64` and `linux/arm64` images, verifies the image version, runs Trivy with every severity enabled and unfixed findings ignored, then pushes these tags:

- `ghcr.io/hermione-granger-1176/linkedin-analyzer:vX.Y.Z`
- `ghcr.io/hermione-granger-1176/linkedin-analyzer:sha-<commit-sha>`
- `ghcr.io/hermione-granger-1176/linkedin-analyzer:latest` for stable releases only

PyPI does not allow replacing a version. The publish job sets `skip-existing: true`, so a rerun does not fail on a version that already exists.

Before the first release, configure a PyPI trusted publisher for owner `Hermione-Granger-1176`, repository `linkedin-analyzer`, workflow `publish.yml`, and environment `pypi`. Keep the environment field constrained.

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

The SDK sends each envelope (Sentry's request format) to the same-origin relay in `api/sentry-tunnel.mjs`, not to Sentry, so the CSP keeps `connect-src 'self'`. The relay forwards an envelope only when the envelope header names the same DSN as `VITE_SENTRY_DSN` or `SENTRY_DSN`. It cannot reach any other Sentry project or host. The relay checks the destination only. The browser reducer removes private data before sending, and the relay forwards envelope bytes unchanged. Sentry sees the relay's address, not the visitor's.

The relay returns `403` for any other DSN and `404` when neither variable is set. Otherwise it returns Sentry's status code and copies Sentry's rate-limit headers. Vercel exposes project variables to functions at runtime, so one `VITE_SENTRY_DSN` serves both the build and the relay.

Set `VITE_APP_RELEASE` during the build so Sentry can group events by release. The metrics buffer flushes when the page becomes hidden and includes only allowlisted nonnegative numbers and positive sample counts.

Consent limits which errors appear in diagnostics. Missing events do not establish that no errors occurred. Reproduce a suspected bug locally with a matching fixture before using event counts to judge impact.

### CSP reports

`vercel.json` sends CSP reports to `/api/csp-report` through both `report-uri` and `report-to`. The function accepts POST requests and returns `405` for other methods. It rejects bodies above 64 KiB with `413` and ignores unrecognized report bodies with `204`.

The function reduces each valid report to directives, bounded source metadata, disposition, and nonnegative numeric fields. It strips credentials, URL queries, fragments, sample text, and unknown fields. It forwards to `CSP_REPORT_URI` when set, otherwise it derives a Sentry security endpoint from `SENTRY_DSN`. With no destination, it logs a host-only summary and returns `204`.

`CSP_REPORT_MAX_PER_MINUTE` defaults to 120 valid reports per serverless instance per minute. Set it to `0` to disable that guard. The limit is per instance, not global. Use an edge or WAF rule when you need a global cap.

After configuring forwarding, run `make web-smoke url=https://your-production-domain.example` and verify a test report reaches the collector. Do not send an uploaded file as a test report.

## Recover external services

The project is maintained by Aditya Kumar Darak under `Hermione-Granger-1176`. Recovery ownership is distributed across these services:

| Service            | Recovery action                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| GitHub             | Recover the maintainer account and rotate GitHub App keys when needed.                                                             |
| Vercel             | Recover the linked account, reconnect the repository, and restore the environment variables in this document.                      |
| Sentry             | Recover the account and rotate `VITE_SENTRY_DSN`, `SENTRY_AUTH_TOKEN`, or both. Diagnostics are optional and do not block the app. |
| PyPI               | Recreate the trusted publisher with environment `pypi`. No long-lived PyPI token is required.                                      |
| GHCR               | Recover GitHub repository access. The publish workflow uses `GITHUB_TOKEN`.                                                        |
| Security reporting | Use the private contact in [.github/SECURITY.md](../.github/SECURITY.md).                                                          |

If the sole maintainer becomes unavailable, a new maintainer can fork the repository and configure new Vercel, Sentry, PyPI, and GitHub App connections.

## Triage an incident

1. Confirm whether the problem affects the web app, the CLI package, the container image, or repository automation.
2. Check the latest smoke run, CI run, deployment, and release tag.
3. Reproduce with a fixture that has the same file shape. Do not use a real export in a test or issue.
4. Check Sentry only as opt-in evidence. Treat missing events as unknown, not as proof that the path is healthy.
5. Add a regression test before you ship the fix.
6. Update the relevant product, reference, or operations page when behavior or recovery steps change.
