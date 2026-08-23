# LinkedIn Analyzer

Clean LinkedIn data exports into Excel workbooks, or inspect the same exports in a private browser app.

The repository ships two products:

- A browser app that reads, cleans, analyzes, and exports your files without uploading file contents.
- The `linkedin-analyzer` Python CLI for local scripts, batch jobs, and container use.

[![CI](https://github.com/Hermione-Granger-1176/linkedin-analyzer/actions/workflows/ci.yml/badge.svg)](https://github.com/Hermione-Granger-1176/linkedin-analyzer/actions/workflows/ci.yml) [![PyPI](https://img.shields.io/pypi/v/linkedin-analyzer)](https://pypi.org/project/linkedin-analyzer/) [![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## What it cleans

LinkedIn exports use different CSV conventions for different file types. The cleaner handles the four exports below and writes formatted `.xlsx` files.

| Export file       | Default workbook   | Main cleanup                                                  |
| ----------------- | ------------------ | ------------------------------------------------------------- |
| `Shares.csv`      | `Shares.xlsx`      | Share commentary quoting and dates                            |
| `Comments.csv`    | `Comments.xlsx`    | Backslash-escaped message text and dates                      |
| `messages.csv`    | `Messages.xlsx`    | Message quoting, dates, and conversation fields               |
| `Connections.csv` | `Connections.xlsx` | Three-row preamble, connection dates, and empty identity rows |

The browser app also provides activity charts, connection and message relationship views, rule-based insights, PNG chart downloads, Excel list exports, and an optional A4 PDF report.

## Start the web app

Install the locked development dependencies. The project needs Python 3.12 or newer, `uv` 0.11.0 or newer, and Node.js 22.22.2 or 24.15.0 within the supported major lines.

```bash
make setup
make web
```

Open the Vite URL printed in the terminal. To enable the optional diagnostics prompt in a local build, copy `.env.example` to `.env` and set `VITE_SENTRY_DSN`. Diagnostics still remain off until a user opts in.

## Run the CLI

Install the published package for normal use:

```bash
pip install linkedin-analyzer
linkedin-analyzer all
```

The CLI reads from `data/input/` and writes to `data/output/` by default. Use `linkedin-analyzer --help` for the command list, or read the [CLI reference](docs/cli.md) for paths, limits, encodings, required columns, and the Python API.

For a checkout, use the repository's Make target after `make setup`:

```bash
make run-cli args="all"
```

## Run the container

The release workflow publishes a multi-platform image to GHCR for each stable release and tags the latest stable release as `latest`.

```bash
docker run --rm -v "$PWD/data:/app/data" ghcr.io/hermione-granger-1176/linkedin-analyzer:latest all
```

The container runs as an unprivileged `app` user. The mounted `data` directory must be writable by that user. See [CLI reference](docs/cli.md) for custom paths and [operations](docs/operations.md) for release details.

## Privacy and storage

The web app processes files in the browser. It does not send CSV contents to an application server. The app may retain raw CSV text and computed analytics in IndexedDB so a reload can restore the session. A 24-hour inactivity sweep removes stored data, and **Clear data** removes it immediately.

Diagnostics use Sentry only when the build contains a DSN and the user opts in. The app reduces error events to fixed diagnostic values and safe source locations. It does not attach file contents, file names, message bodies, contact names, or URLs to diagnostics. Read [web app behavior](docs/web-app.md) for the complete storage and export rules.

## Documentation

Start with the [documentation index](docs/index.md). The pages are grouped by the task or question they answer:

- [Clean an export](docs/getting-started.md) is the tutorial for a first run.
- [Web app](docs/web-app.md) describes the browser workflow, screens, exports, limits, and privacy behavior.
- [CLI reference](docs/cli.md) lists commands, options, input files, output files, and the Python API.
- [Data formats](docs/data-formats.md) records required columns and cleaner behavior for each export.
- [Development](docs/development.md) covers setup, dependency changes, local commands, and GitHub helpers.
- [Testing](docs/testing.md) explains unit, integration, parity, browser, coverage, and benchmark checks.
- [Project structure](docs/structure.md) maps ownership across the repository.
- [Web architecture](docs/web-architecture.md) explains routing, workers, persistence, export, and observability decisions.
- [Operations](docs/operations.md) covers deployment, releases, CI, monitoring, and incident response.
- [Style guide](docs/style-guide.md) records code and documentation conventions.
- [Troubleshooting](docs/troubleshooting.md) starts with common setup, upload, test, and deployment failures.
- [Architecture decision records](docs/adr/README.md) explain decisions that affect the system design.
- [Contributing](.github/CONTRIBUTING.md) describes the contribution workflow.
- [Security policy](.github/SECURITY.md) describes private vulnerability reporting.
- [Changelog](CHANGELOG.md) records Python package changes only.

## License

[MIT](LICENSE)

Created by [Aditya Kumar Darak](https://github.com/Hermione-Granger-1176).
