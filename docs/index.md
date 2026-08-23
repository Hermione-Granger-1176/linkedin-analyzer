# Documentation

LinkedIn Analyzer has a Python package, a browser app, and repository automation. Start with the page that matches the work you need to do.

## Choose a page

| If you need to...                          | Read                                           |
| ------------------------------------------ | ---------------------------------------------- |
| Clean your first export                    | [Clean an export](getting-started.md)          |
| Use the browser app                        | [Web app](web-app.md)                          |
| Look up a CLI flag or output path          | [CLI reference](cli.md)                        |
| Check CSV columns or cleaning rules        | [Data formats](data-formats.md)                |
| Set up a checkout or change dependencies   | [Development](development.md)                  |
| Pick the right test or quality gate        | [Testing](testing.md)                          |
| Understand module ownership                | [Project structure](structure.md)              |
| Understand browser architecture            | [Web architecture](web-architecture.md)        |
| Deploy, release, or investigate production | [Operations](operations.md)                    |
| Fix a known setup or runtime problem       | [Troubleshooting](troubleshooting.md)          |
| Follow code and documentation conventions  | [Style guide](style-guide.md)                  |
| Understand a recorded design decision      | [Architecture decision records](adr/README.md) |

## Use the repository interface

The `Makefile` is the only interface for repository setup, checks, tests, web development, and GitHub helpers. Run `make help` for command groups, `make help-<group>` for one group, and `make help-json` when another tool needs the complete command list.

Use the [development guide](development.md) for the common path. Use the Makefile help output when you need a target that this index does not list.

## Read the product rules first

The browser app keeps uploaded file contents local, but it can retain them in browser storage so a reload can restore a session. Read [web app privacy](web-app.md#understand-where-the-app-keeps-data) before using the app on a shared computer.

The CLI writes workbooks to local paths and applies formula escaping before it saves them. Read [data formats](data-formats.md) before you process an export that contains untrusted text.

## Keep docs in sync

Update the relevant page when a command, flag, route, output, limit, workflow, or privacy rule changes. Run `make lint-doc-commands`, `make lint-make-targets`, and `make align-tables-check` before you finish a documentation change.
