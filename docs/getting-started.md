# Clean an export

In this tutorial, you clean `Shares.csv` and save the result as `Shares.xlsx`. You can use the browser app or the Python CLI. Both apply the same cleaning rules.

## Prepare an export

Download your LinkedIn data export, and keep the original CSV files unchanged. Find `Shares.csv`. Use a file of 10 MiB or less, so the browser can create an Excel workbook.

The [data formats reference](data-formats.md#input-files) lists the other export types and their required columns.

## Use the web app

Complete [development setup](development.md) first. Then follow these steps:

1. Run `make web`. Vite prints a local URL in the terminal.
2. Open that URL in your browser. The Home screen shows the upload control.
3. Upload `Shares.csv`. Wait for processing to finish.
4. Open **Clean**. The screen shows a preview of the cleaned rows.
5. Select **Download Clean Excel**. Your browser saves `Shares.xlsx`.

The app keeps uploaded files after a reload. Select **Clear data** when you want the browser to forget them. See [where the app keeps data](web-app.md#understand-where-the-app-keeps-data).

## Use the CLI

1. Run `pip install linkedin-analyzer`.
2. Create the `data/input/` directory.
3. Copy `Shares.csv` into `data/input/`.
4. Run `linkedin-analyzer shares`. The log ends with `Successfully processed N rows`, followed by the input and output paths.
5. Open `data/output/Shares.xlsx`. The CLI creates `data/output/` when it writes the file.

The [CLI commands](cli.md#commands) cover `all` and `--skip-missing` for partial exports.

## Check the result

Open `Shares.xlsx`. The header row lists the [Shares workbook columns](data-formats.md#shares-workbook).

Compare a `Date` value with the CSV. The cleaner reads the CSV time as UTC and writes it in your local time zone, so the workbook value can differ from the CSV by your UTC offset. See [field cleaning](data-formats.md#field-cleaning). Check a `ShareCommentary` cell against the original CSV.

If rows are missing or the text looks wrong, read [row rules](data-formats.md#row-rules) and [a CSV is rejected](troubleshooting.md#a-csv-is-rejected). The [CLI reference](cli.md) covers custom paths and global options.
