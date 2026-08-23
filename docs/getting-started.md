# Clean an export

Build a cleaned Excel workbook from one LinkedIn CSV export with the browser app or the Python CLI.

## Prepare an export

Download your LinkedIn data export and keep the original CSV files unchanged. The cleaner recognizes these file names:

- `Shares.csv`
- `Comments.csv`
- `messages.csv`
- `Connections.csv`

Read [data formats](data-formats.md) when you want to process a renamed file, check required columns, or understand dropped rows.

## Use the web app

1. Start the app with `make web` after you complete [development setup](development.md).
2. Open the local URL that Vite prints.
3. Upload one or more supported CSV files on the Home screen.
4. Open **Clean** and download the workbook for each file type.
5. Open **Analytics**, **Connections**, **Messages**, or **Insights** after the corresponding files finish processing.

The app can restore uploaded files after a reload when IndexedDB is available. Use **Clear data** when you no longer want the browser to retain the files.

## Use the CLI

1. Install `linkedin-analyzer` from PyPI.
2. Create `data/input/` and `data/output/` if they do not exist.
3. Copy the CSV files into `data/input/`.
4. Run `linkedin-analyzer all`.
5. Open the generated workbooks in `data/output/`.

The `all` command fails when an input file is missing. Use `linkedin-analyzer all --skip-missing` when a partial export is expected. The flag skips only files that do not exist. Malformed files still fail the command.

## Process one file

Use a single-file command when you want to select an input and output path:

```bash
linkedin-analyzer shares --input raw/Shares.csv --output clean/Shares.xlsx
linkedin-analyzer comments --input raw/Comments.csv --output clean/Comments.xlsx
linkedin-analyzer messages --input raw/messages.csv --output clean/Messages.xlsx
linkedin-analyzer connections --input raw/Connections.csv --output clean/Connections.xlsx
```

Use the [CLI reference](cli.md) for global options, environment variables, and the Python API.

## Check the result

Open the workbook and check the header row, dates, long text fields, and row count. The cleaner writes an Excel file atomically, so a failed run does not replace an existing output with a partial workbook.

If the output contains unexpected text, rerun with `--log-level DEBUG` and an explicit `--encoding`. If the input is too large, adjust the CLI limits only after you understand the memory cost. The browser limits and the CLI limits are different.
