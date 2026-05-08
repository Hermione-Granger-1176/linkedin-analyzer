<h1 align="center">LinkedIn Analyzer</h1>

<p align="center">
  Clean and analyze your LinkedIn data exports.<br>
  <sub>Web app or Python CLI. File contents stay local in the web app; optional diagnostics are opt-in.</sub>
</p>

<p align="center">
  <a href="https://github.com/Hermione-Granger-1176/linkedin-analyzer/actions/workflows/ci.yml"><img src="https://github.com/Hermione-Granger-1176/linkedin-analyzer/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://pypi.org/project/linkedin-analyzer/"><img src="https://img.shields.io/pypi/v/linkedin-analyzer" alt="PyPI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</p>

<br>

## What it does

LinkedIn's data exports are messy. This tool fixes that.

- **Shares.csv** has weird nested quote escaping
- **Comments.csv** has backslash-escaped quotes
- **messages.csv** has mixed participant/profile fields that need normalization
- **Connections.csv** often includes preamble rows and noisy identity fields

Upload your files, get clean Excel outputs. Plus analytics dashboards, relationship views from messages/connections, and rule-based insights.

<br>

## Quick start

**Development** — Install locked Python and Node dependencies:

```bash
# Requires Python 3.11+, uv, and Node.js 20.19+/22.13+/24+
make setup
```

**Web** — Run the Vite dev server and open the local URL:

```bash
cp .env.example .env  # optional; set VITE_SENTRY_DSN + VITE_APP_RELEASE for opt-in diagnostics
make web
```

**CLI** — For automation:

```bash
pip install linkedin-analyzer
linkedin-analyzer shares
linkedin-analyzer comments
linkedin-analyzer messages
linkedin-analyzer connections
linkedin-analyzer all
```

**Container** — Run the published CLI image:

```bash
docker run --rm -v "$PWD/data:/app/data" ghcr.io/hermione-granger-1176/linkedin-analyzer:latest --version
```

<br>

## Tech stack

<p>
  <img src="https://img.shields.io/badge/HTML5-E34F26?style=flat&logo=html5&logoColor=white" alt="HTML5">
  <img src="https://img.shields.io/badge/CSS3-1572B6?style=flat&logo=css3&logoColor=white" alt="CSS3">
  <img src="https://img.shields.io/badge/JavaScript-F7DF1E?style=flat&logo=javascript&logoColor=black" alt="JavaScript">
  <img src="https://img.shields.io/badge/Python-3776AB?style=flat&logo=python&logoColor=white" alt="Python">
</p>

**Web app**

<p>
  <img src="https://img.shields.io/badge/Rough.js-000000?style=flat" alt="Rough.js">
  <img src="https://img.shields.io/badge/Canvas_API-FF6384?style=flat" alt="Canvas API">
  <img src="https://img.shields.io/badge/IndexedDB-4285F4?style=flat" alt="IndexedDB">
  <img src="https://img.shields.io/badge/Web_Workers-FF9800?style=flat" alt="Web Workers">
  <img src="https://img.shields.io/badge/write--excel--file-107C10?style=flat" alt="write-excel-file">
</p>

**Python CLI**

<p>
  <img src="https://img.shields.io/badge/openpyxl-217346?style=flat" alt="openpyxl">
  <img src="https://img.shields.io/badge/argparse-4EAA25?style=flat" alt="argparse">
  <img src="https://img.shields.io/badge/mypy-strict-blue?style=flat" alt="mypy strict">
</p>

**Dev & CI**

<p>
  <img src="https://img.shields.io/badge/pytest-0A9EDC?style=flat&logo=pytest&logoColor=white" alt="pytest">
  <img src="https://img.shields.io/badge/Ruff-D7FF64?style=flat&logo=ruff&logoColor=black" alt="Ruff">
  <img src="https://img.shields.io/badge/ESLint-4B32C3?style=flat&logo=eslint&logoColor=white" alt="ESLint">
  <img src="https://img.shields.io/badge/GitHub_Actions-2088FF?style=flat&logo=github-actions&logoColor=white" alt="GitHub Actions">
</p>

<br>

## Features

| Feature              | Detail                                                    |
| -------------------- | --------------------------------------------------------- |
| **100% client-side** | File contents stay local in your browser                  |
| **Light/dark theme** | Hand-drawn sketch aesthetic                               |
| **Guided tutorials** | Per-page tutorials                                        |
| **Analytics**        | Timeline, topics, heatmap                                 |
| **Messages view**    | Top contacts, silent connections, fading chats            |
| **SPA routing**      | Hash routes with URL-synced filters                       |
| **Excel export**     | Formatted .xlsx with proper columns                       |
| **Connections**      | Network growth, top companies, top positions              |
| **Chart export**     | Download any chart as PNG                                 |
| **PWA-ready**        | Installable with auto-refreshing service worker caching   |
| **Session cleanup**  | Stale uploads and cached analytics cleared asynchronously |
| **Social previews**  | Open Graph and Twitter Card meta tags                     |
| **Type-safe CLI**    | Strict mypy, high test coverage (95% threshold)           |

<br>

## Documentation

See the [`docs/`](docs/) folder for:

- [Web App Guide](docs/web-app.md)
- [Python CLI Reference](docs/cli.md)
- [Development Setup](docs/development.md)
- [Project Structure](docs/structure.md)
- [Style Guide](docs/style-guide.md)
- [Operations and Deployment](docs/operations.md)

Architecture Decision Records: [`docs/adr/`](docs/adr/)

Security reporting guidelines: [`.github/SECURITY.md`](.github/SECURITY.md)

<br>

## License

[MIT](LICENSE)

---

<p align="center">
  <sub>Created by <a href="https://github.com/Hermione-Granger-1176">Aditya Kumar Darak</a></sub>
</p>
