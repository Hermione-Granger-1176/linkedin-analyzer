# Clean an export

In this walkthrough, we'll clean `Shares.csv` and create `Shares.xlsx`. Choose either the browser app or the Python CLI.

## Prepare an export

First, download your LinkedIn data export and keep the original CSV files unchanged. Find `Shares.csv`. For this walkthrough, use a file no larger than 10 MiB so the browser can create an Excel workbook.

The [data formats reference](data-formats.md) lists the other supported exports and required columns.

## Use the web app

After completing [development setup](development.md), follow these steps:

1. Start the app with `make web`. Vite prints a local URL in the terminal.
2. Open that URL. The Home screen shows the upload control.
3. Upload `Shares.csv`. Wait for processing to finish.
4. Open **Clean**. The screen shows a preview of the cleaned rows.
5. Download the Excel workbook. Your browser saves `Shares.xlsx`.

The app can restore uploaded files after a reload when IndexedDB is available. Use **Clear data** when you no longer want the browser to retain the files.

## Use the CLI

To create the same workbook with the CLI, follow these steps:

1. Install the package with `pip install linkedin-analyzer`.
2. Create `data/input/` and `data/output/` if they do not exist.
3. Copy `Shares.csv` into `data/input/`.
4. Run `linkedin-analyzer shares`. A successful run logs the processed row count and the output path.
5. Open `data/output/Shares.xlsx`.

The [CLI reference](cli.md#commands) describes `all`, which processes every supported file type, and `--skip-missing` for partial exports.

## Check the result

Open `Shares.xlsx`. The workbook contains `Date`, `ShareLink`, `ShareCommentary`, `SharedUrl`, `MediaUrl`, and `Visibility` columns. Check a date and a commentary cell against the original CSV. Blank rows and rows without required values do not appear in the workbook.

For unexpected text or missing rows, follow [troubleshooting](troubleshooting.md#a-csv-is-rejected). The [CLI reference](cli.md) covers custom paths, global options, environment variables, and the Python API.
