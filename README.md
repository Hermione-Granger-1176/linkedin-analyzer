<h1 align="center">LinkedIn Analyzer</h1>

<p align="center">
  Clean and analyze your LinkedIn data exports.<br>
  <sub>Web app or Python CLI. Your data never leaves your browser.</sub>
</p>

<p align="center">
  <a href="https://github.com/Hermione-Granger-1176/linkedin-analyzer/actions/workflows/ci.yml"><img src="https://github.com/Hermione-Granger-1176/linkedin-analyzer/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</p>

<br>

## What it does

LinkedIn's data exports are messy. This tool fixes that.

- **Shares.csv** has weird nested quote escaping
- **Comments.csv** has backslash-escaped quotes

Upload your files, get clean Excel outputs. Plus analytics dashboards with timelines, topic breakdowns, and activity heatmaps.

<br>

## Quick start

**Web** — Just open the app and drag your CSV files. No install needed.

**CLI** — For automation:
```bash
pip install -e .
linkedin-analyzer shares
linkedin-analyzer comments
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
  <img src="https://img.shields.io/badge/SheetJS-107C10?style=flat" alt="SheetJS">
</p>

**Python CLI**
<p>
  <img src="https://img.shields.io/badge/openpyxl-217346?style=flat" alt="openpyxl">
  <img src="https://img.shields.io/badge/Click-4EAA25?style=flat" alt="Click">
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

| | |
|---|---|
| **100% client-side** | Files never leave your browser |
| **Offline support** | Works after first load |
| **Light/dark theme** | Hand-drawn sketch aesthetic |
| **Analytics** | Timeline, topics, heatmap |
| **Excel export** | Formatted .xlsx with proper columns |
| **Type-safe CLI** | Strict mypy, full test coverage |

<br>

## Documentation

See the [`docs/`](docs/) folder for:

- [Web App Guide](docs/web-app.md)
- [Python CLI Reference](docs/cli.md)
- [Development Setup](docs/development.md)
- [Project Structure](docs/structure.md)

<br>

## License

[MIT](LICENSE)

---

<p align="center">
  <sub>Created by <a href="https://github.com/Hermione-Granger-1176">Aditya Kumar Darak</a></sub>
</p>
