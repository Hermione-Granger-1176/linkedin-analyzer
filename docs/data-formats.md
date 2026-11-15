# Data formats

The Python CLI and the browser cleaner accept the same four LinkedIn CSV exports. Both apply the same required columns and field cleaning rules. Workbook formatting can differ between them.

## Input files

A file matches a type when its header row contains every required column. The CLI uses the command you run instead, such as `linkedin-analyzer shares`.

Header names are trimmed, and a leading UTF-8 byte-order mark is removed. A file with duplicate headers after that step fails.

| Type        | Expected file     | Required columns                          | Extra input handling                                                                                            |
| ----------- | ----------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Shares      | `Shares.csv`      | `Date`, `ShareLink`, `ShareCommentary`    | The cleaner keeps `SharedUrl`, `MediaUrl`, and `Visibility` when present.                                       |
| Comments    | `Comments.csv`    | `Date`, `Link`, `Message`                 | The parser uses backslash escaping for quoted fields.                                                           |
| Messages    | `messages.csv`    | `FROM`, `TO`, `DATE`, `CONTENT`           | The cleaner keeps `FOLDER`, `CONVERSATION ID`, `SENDER PROFILE URL`, and `RECIPIENT PROFILE URLS` when present. |
| Connections | `Connections.csv` | `First Name`, `Last Name`, `Connected On` | The parser skips the first three rows and keeps `URL`, `Email Address`, `Company`, and `Position` when present. |

## Encoding

Without `--encoding`, the CLI reads the file as BOM-aware UTF-8. If decoding fails, it reads the file as WHATWG Windows-1252 and logs a warning. The browser uses the same fallback and shows a warning.

The [`--encoding` option](cli.md#set-global-options) turns off the fallback and reads the file in the encoding you name. That encoding applies as given. For example, `iso-8859-1` keeps bytes 0x80 to 0x9F as C1 control characters, where Windows-1252 maps them to other characters.

## Output columns

The cleaner writes the configured columns in the order below. Missing optional columns become blank columns.

### Shares workbook

`Date`, `ShareLink`, `ShareCommentary`, `SharedUrl`, `MediaUrl`, `Visibility`

### Comments workbook

`Date`, `Link`, `Message`

### Messages workbook

`FROM`, `TO`, `DATE`, `CONTENT`, `FOLDER`, `CONVERSATION ID`, `SENDER PROFILE URL`, `RECIPIENT PROFILE URLS`

### Connections workbook

`First Name`, `Last Name`, `URL`, `Email Address`, `Company`, `Position`, `Connected On`

## Row rules

The cleaner removes blank rows. It then removes each row that lacks a value in a required column. For Connections, only `Connected On` must have a value. The cleaner also removes a Connections row when `First Name`, `Last Name`, and `URL` are all empty.

A file fails when it lacks a required column or cannot be parsed.

## Field cleaning

The cleaner applies these rules:

- Trims text. Missing values, empty strings, whitespace, and common NA-like values become blank cells.
- In `ShareCommentary`, converts doubled quotes to a single quote and restores quoted line breaks.
- In the Comments `Message` column and the Messages `CONTENT` column, converts backslash-escaped quotes (`\"`) and doubled quotes to `"`.
- Reads `Date` and `DATE` values in `YYYY-MM-DD HH:MM:SS` format as UTC, then writes them in the local time zone in the same format. A trailing ` UTC` is accepted. Other text passes through unchanged.
- Converts `Connected On` values such as `30 Jan 2026` to `2026-01-30`. Other text passes through unchanged.
- Removes control characters that Excel cannot store. Tab, line feed, and carriage return stay.
- Before workbook export, adds a single quote (`'`) in front of any value that starts with `=`, `+`, `-`, `@`, tab, carriage return, or line feed. This stops spreadsheet formula execution.

## Workbook formatting

The CLI sets column widths from each file type's configuration. It wraps long text in the commentary, message, and content columns, centers headers, and aligns wrapped cells to the top. Empty strings become blank cells.

The CLI writes the workbook to a temporary file in the output directory and replaces the destination only after the write succeeds. A failed run leaves an existing workbook unchanged.

The CLI and the browser apply the same cleaning rules through separate implementations. [ADR-005](adr/005-dual-runtime-cleaner-with-parity-fixtures.md) describes how parity is tested.

## Resource limits

Each runtime enforces its own limits. The CLI defaults are in [global options](cli.md#set-global-options). The browser limits are in [browser limits](web-app.md#check-browser-limits). Do not assume that a file one runtime accepts will pass the other.
