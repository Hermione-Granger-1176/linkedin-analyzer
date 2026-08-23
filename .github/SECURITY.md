# Security policy

## Supported versions

Security fixes apply to the latest commit on `main` and the latest release published to PyPI. Update the package or checkout before you report an issue. The web app follows `main` because the browser deployment does not use the Python package version.

## Report a vulnerability privately

Do not open a public issue for a security vulnerability.

Use [GitHub Private Vulnerability Reporting](https://github.com/Hermione-Granger-1176/linkedin-analyzer/security/advisories/new) when possible. If that channel is unavailable, email `adityadarak9314@outlook.com`.

Do not attach a real LinkedIn export, workbook, browser storage dump, or message transcript. Replace personal data with a minimal fixture that still reproduces the issue.

Include these details when they are available:

- A short description of the issue and its impact.
- Reproduction steps or a proof of concept.
- The affected version, commit, operating system, browser, Python version, or Node.js version.
- The input shape or fixture needed to reproduce the behavior, with personal data removed.
- A suggested mitigation.

## Response

The maintainer targets an initial response within five business days. Triage and severity assessment start when the issue is reproducible. Fix timing depends on impact, exploitability, and the affected release target.

The repository also publishes the same contact and policy through `web/public/.well-known/security.txt`.
