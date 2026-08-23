# Data formats

The Python CLI and browser cleaner accept the same four LinkedIn CSV export types. They use the same required columns and field cleaning rules. Workbook formatting can differ between the two runtimes.

## Input files

The cleaner matches a file type from its header row. Header names are trimmed, and a leading UTF-8 byte-order mark is removed. Duplicate headers after normalization cause the run to fail.

| Type        | Expected file     | Required columns                          | Extra input handling                                                                                            |
| ----------- | ----------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Shares      | `Shares.csv`      | `Date`, `ShareLink`, `ShareCommentary`    | The cleaner keeps `SharedUrl`, `MediaUrl`, and `Visibility` when present.                                       |
| Comments    | `Comments.csv`    | `Date`, `Link`, `Message`                 | The parser uses backslash escaping for quoted fields.                                                           |
| Messages    | `messages.csv`    | `FROM`, `TO`, `DATE`, `CONTENT`           | The cleaner keeps `FOLDER`, `CONVERSATION ID`, `SENDER PROFILE URL`, and `RECIPIENT PROFILE URLS` when present. |
| Connections | `Connections.csv` | `First Name`, `Last Name`, `Connected On` | The parser skips the first three rows and keeps `URL`, `Email Address`, `Company`, and `Position` when present. |

The CLI reads UTF-8 with a byte-order mark first. When UTF-8 decoding fails and no explicit encoding was supplied, it retries with WHATWG Windows-1252 and logs a warning. Pass `--encoding` when you know the source encoding or when characters look wrong.

## Output columns

The cleaner writes the configured columns in the order below. Missing optional columns become blank output columns.

### Shares workbook

`Date`, `ShareLink`, `ShareCommentary`, `SharedUrl`, `MediaUrl`, `Visibility`

### Comments workbook

`Date`, `Link`, `Message`

### Messages workbook

`FROM`, `TO`, `DATE`, `CONTENT`, `FOLDER`, `CONVERSATION ID`, `SENDER PROFILE URL`, `RECIPIENT PROFILE URLS`

### Connections workbook

`First Name`, `Last Name`, `URL`, `Email Address`, `Company`, `Position`, `Connected On`

## Row rules

The cleaner removes blank rows. It removes rows that lack a value in a file type's required row fields. For Connections, `Connected On` must contain a value, and the cleaner removes a row when `First Name`, `Last Name`, and `URL` are all empty.

A missing required column fails the file. A malformed file fails the file. The `all` CLI command can skip a missing file only when you pass `--skip-missing`.

## Field cleaning

The cleaner applies these transformations:

- Trims ordinary text and converts missing values, empty strings, whitespace, and common NA-like values to blank cells.
- Converts Shares commentary double-double quote escaping to ordinary quotes and restores quoted line breaks.
- Converts Comments and Messages backslash-escaped quotes and double-double quotes to ordinary quotes.
- Converts `Date` and `DATE` values in `YYYY-MM-DD HH:MM:SS` format from UTC to the local timezone. Unexpected date text passes through unchanged.
- Converts Connections dates such as `30 Jan 2026` to `2026-01-30`. Unexpected date text passes through unchanged.
- Removes XML control characters that Excel cannot store while preserving tab, newline, and carriage return characters.
- Prefixes values that start with `=`, `+`, `-`, `@`, tab, carriage return, or newline with a single quote before workbook export. This prevents spreadsheet formula execution.
- Writes the workbook to a temporary file in the output directory, formats it, and replaces the destination only after the write succeeds.

## Workbook formatting

The cleaner sets column widths from the file type configuration, wraps long text in commentary, message, and content columns, aligns headers to the center, and aligns wrapped cells to the top. Empty strings become blank Excel cells.

The CLI and browser use the same cleaning rules through separate implementations. [ADR-005](adr/005-dual-runtime-cleaner-with-parity-fixtures.md) records the parity test design.

## Resource limits

The CLI defaults to a 100 MiB input file limit and 1,000,000 parsed rows. Set `--max-input-bytes 0` or `--max-rows 0` to disable one limit. The browser accepts files up to 80 MiB, limits decoded text to 60 MiB, parses at most 500,000 rows, accepts at most 256 columns per row, and limits one field to 200,000 characters.

These limits protect different runtimes. Do not assume that a file accepted by the browser app will be accepted by the CLI, or the reverse.
