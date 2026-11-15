# Web app

The web app reads LinkedIn CSV exports in your browser. It cleans files, computes local summaries, and creates downloads without sending CSV contents to an application server.

## Start the app

Complete [development setup](development.md), then run:

```bash
make web
```

Open the local URL that Vite prints. The production build is static and runs on Vercel or another static host. See [deployment](operations.md#deploy-the-web-app) for the release steps.

## Upload files

Upload any of these exports on the Home screen:

- `Shares.csv`
- `Comments.csv`
- `messages.csv`
- `Connections.csv`

The app identifies each file from its header row. [Data formats](data-formats.md#input-files) lists the required columns, and [encoding](data-formats.md#encoding) describes how the app decodes a file. Long parses run in Web Workers. The [browser limits](#check-browser-limits) still apply.

## Open a screen

| Screen      | Route          | Requires                                            |
| ----------- | -------------- | --------------------------------------------------- |
| Home        | `#home`        | No file                                             |
| Clean       | `#clean`       | At least one uploaded file                          |
| Analytics   | `#analytics`   | Shares or Comments data                             |
| Connections | `#connections` | Connections data                                    |
| Messages    | `#messages`    | Messages data, with Connections data when available |
| Insights    | `#insights`    | Shares or Comments data                             |

The app opens `#home` when the URL has no hash. Unknown routes also open Home. Hash routes work on a static host without server rewrites.

Analytics, Connections, Messages, and Insights share a `range` query parameter. Valid values are `1m`, `3m`, `6m`, `12m`, and `all`. The default is `12m`. For example, `#analytics?range=3m` opens Analytics with a three-month range. Home and Clean do not use the range.

## Clean files

Open **Clean** to download cleaned data from an uploaded file. **Download Clean Excel** saves a workbook named for the file type, such as `Shares.xlsx`. **Download Clean CSV** saves the same rows as UTF-8 CSV, such as `Shares_cleaned.csv`, which Excel also opens.

The browser applies the same cleaning rules as the CLI. See [data formats](data-formats.md) for the columns and rules.

Files over 10 MiB offer only the CSV download. The browser builds a workbook in memory, which can exhaust a phone's memory. See [browser limits](#check-browser-limits).

## Read analytics

The **Analytics** screen shows:

- A timeline of activity over the selected range.
- A topic view that groups normalized words and hashtags.
- A day and hour heatmap.

Hover over a chart and select its download control to save a PNG. The chart export uses the chart canvas and does not send data anywhere.

## Read connections

The **Connections** screen shows:

- Connection growth over time.
- Top companies.
- Top positions.
- Total connections, recent additions, top company, and network age.

The screen filters on the selected range. Empty sections show an empty state instead of an empty chart.

## Read messages

The **Messages** screen summarizes relationships from your message and connection exports:

- **Top Contacts** ranks people by message activity in the selected range.
- **Silent Connections** finds connections with no matching message activity.
- **Fading Conversations** finds conversations whose recent activity has slowed.

Each list can download a full Excel workbook. The app keeps message contents out of the in-memory relationship aggregates that the screen uses.

## Read insights

The **Insights** screen shows rule-based advice about activity, topics, network growth, and outreach. Advice appears when your data supports it.

The **All-time** section shows lifetime network growth and message outreach totals when message data is available. Change the range to compare recent behavior with the full history.

## Save a PDF

Select **Save as PDF** on any screen to download `linkedin-insights-YYYY-MM-DD.pdf`. The file is an A4 document, not a screenshot. It includes the selected dashboards, insight cards, a closing tip, and all-time stats when the data supports them.

The report always uses a light warm palette, even in dark mode. Its data window ends at the newest date in your files, so the report stays accurate after you share it.

The confirmation dialog has two options. Both are unchecked each time the dialog opens:

- **Name people in the dashboards** adds names to the message dashboards. Aggregate company and position charts do not need this option.
- **Include message contents** adds the last five messages from the ten most recently messaged contacts. The export includes each contact's name as a transcript heading. The export is refused for a `messages.csv` above 60 MiB. Untick it to export everything else.

Message contents remain in the file you download. The browser does not upload or log them. Canceling the dialog or pressing Escape cancels the export and stops its workers.

## Understand where the app keeps data

The app stores uploaded CSV files and computed analytics in IndexedDB when the browser supports it, so uploads survive a reload. If IndexedDB is unavailable or fails, the app keeps data in memory, and a reload clears it.

A session has a 24-hour inactivity limit. On startup, the app clears stored uploads and analytics when the last activity is older than that limit. Select **Clear data** to remove them at once. Clear data before you leave a shared or public computer.

The app keeps these values in `localStorage`. None holds CSV contents:

- The theme preference.
- Tutorial completion and mini-tip state.
- Diagnostics consent.
- The last activity time, for the 24-hour limit.
- A processing marker, described below.

While a file processes, the app writes a marker to `localStorage`. The next visit reads it to tell whether the run finished. The marker holds a random run ID, the tab ID, start and heartbeat times, a size bucket for the combined file size such as `30-60mb`, and whether the run had one file or several (`single` or `parallel`). It holds no file names or contents. The app removes the marker when the run ends.

If a run ends without recording success or an error, the next visit shows a notice. The browser may have stopped the tab after it ran out of memory. A reload, navigation, normal tab close, or a run still active in another tab does not trigger the notice.

If the notice keeps appearing, upload fewer files at once, or use the Python CLI on a computer. See [unfinished processing runs](troubleshooting.md#the-app-says-the-last-processing-run-did-not-finish).

The service worker caches the app shell and static assets, so the app opens offline after one successful visit. A new build is picked up on the next navigation. See [how the PWA cache works](web-architecture.md#how-the-pwa-cache-works).

## Understand diagnostics

Diagnostics stay off until both conditions hold. The build sets `VITE_SENTRY_DSN`, and you select the diagnostics consent control. To revoke consent, use the control in the footer. [Monitor diagnostics](operations.md#monitor-diagnostics) covers the deployment settings.

With consent, the app sends diagnostics through the same-origin `/api/sentry-tunnel` relay. The relay forwards them only to this deployment's Sentry project. Diagnostics can include reduced error events, numeric performance measurements, and the visual effects tier in use.

When the app detects an unfinished processing run, it may send one `processing-unfinished` event. The event holds the file-size bucket, the device memory bucket when the browser reports one, and whether the run processed one file or several.

Diagnostics exclude CSV text, file names, message bodies, contact names, URLs, DOM text, and arbitrary exception values. CSP violation reports have their own endpoint, described in [CSP reports](operations.md#csp-reports).

## Check browser limits

The browser enforces these limits:

| Limit                     | Value                 |
| ------------------------- | --------------------: |
| File size before decoding | 128 MiB               |
| Decoded text per file     | 128 MiB of characters |
| Parsed rows per file      | 1,000,000             |
| Columns per row           | 256                   |
| Characters per field      | 200,000               |

Decoded text counts characters, and a file never decodes to more characters than it has bytes.

The app also changes its behavior at these sizes:

- Files above 25 MiB show a large-file warning before processing. Processing can take up to a minute and may not finish on a phone with little memory.
- The Clean screen builds an Excel workbook only for files up to 10 MiB. Larger files offer the CSV download.
- When the background worker cannot start, the Clean screen cleans on the page and refuses files above 80 MiB. A larger clean there can freeze the tab.
- The PDF export takes message contents only from a `messages.csv` up to 60 MiB.

The CLI sets its own limits. See [global options](cli.md#set-global-options).

## Visual effects

The app picks an effects tier from the device's CPU cores, reported memory, data-saver setting, and hardware-accelerated WebGL support:

- **Lite** applies when the device reports 2 or fewer CPU cores, or 2 GB or less of memory, or when data saver is on. Lite uses static drawings and simple animations without blur or filters.
- **Rich** applies when the device reports 8 or more CPU cores, 8 GB or more of memory (when memory is reported), and hardware-accelerated WebGL.
- **Standard** applies to all other devices.

If animation makes the idle page stutter, the app lowers the tier for the rest of the session. The system reduced-motion setting takes precedence over the tier. The tier does not affect file processing. Every number, chart, list, export, and control works the same in every tier. [How the effects tier is chosen](web-architecture.md#how-the-effects-tier-is-chosen) describes the detection.

## Use tutorials and themes

Each screen has a guided tutorial. The first visit starts the tutorial after loading finishes. Use the floating help button to replay the current screen's tutorial. Completing or skipping a tutorial turns on that screen's contextual tips.

Tutorials work with the Back, Next, Finish, and Skip buttons, the progress dots, and the `ArrowLeft`, `ArrowRight`, `Enter`, and `Escape` keys. Focus stays inside the tutorial while you use `Tab` and `Shift+Tab`. Home includes the theme step. Home and Analytics introduce PDF export. Tutorial completion and mini-tip pacing live in versioned `localStorage` keys.

The theme toggle switches between light and dark palettes. The PDF export always uses the light warm palette. The mascot and other decorative drawings carry no application data and are hidden from assistive technology.

## Browser support

The Vite build targets ES2022. The automated browser suite runs on Chromium, Firefox, and WebKit. The app needs `FileReader`, `TextDecoder`, the Performance API, Web Workers, and IndexedDB for full storage and processing. Without IndexedDB, the app keeps working with in-memory state.
