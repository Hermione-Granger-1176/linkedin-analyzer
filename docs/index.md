# Documentation

Each page answers one kind of question. Pick the row that matches what you need.

## Use the product

| If you need to...                   | Read                                  |
| ----------------------------------- | ------------------------------------- |
| Clean your first export             | [Clean an export](getting-started.md) |
| Use the browser app                 | [Web app](web-app.md)                 |
| Look up a CLI flag or output path   | [CLI reference](cli.md)               |
| Check CSV columns or cleaning rules | [Data formats](data-formats.md)       |
| Fix a setup or runtime problem      | [Troubleshooting](troubleshooting.md) |

## Work on the code

| If you need to...                             | Read                                    |
| --------------------------------------------- | --------------------------------------- |
| Set up a checkout or change dependencies      | [Development](development.md)           |
| Open a PR, answer reviews, or inspect CI runs | [GitHub helpers](github-helpers.md)     |
| Pick the right test                           | [Testing](testing.md)                   |
| Measure speed or memory                       | [Benchmarks](benchmarks.md)             |
| Follow code and documentation conventions     | [Style guide](style-guide.md)           |
| Find where a module lives                     | [Project structure](structure.md)       |
| Understand how the browser app fits together  | [Web architecture](web-architecture.md) |

## Run the project

| If you need to...                                  | Read                                  |
| -------------------------------------------------- | ------------------------------------- |
| Deploy, release, roll back, or triage an incident  | [Operations](operations.md)           |
| Understand CI jobs, scheduled workflows, or alerts | [CI and repository automation](ci.md) |
| Read why a design decision was made                | [Decision records](adr/README.md)     |

Pages describe the system as it is now. History and design rationale live only in the [decision records](adr/README.md).

## Keep docs in sync

Update the owning page when a command, flag, route, output, limit, workflow, or privacy rule changes. Before you finish, run `make lint-doc-commands`, `make lint-make-targets`, and `make align-tables-check`.
