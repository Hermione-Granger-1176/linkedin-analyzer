# Web app

The web app reads LinkedIn CSV exports in your browser. It cleans files, computes local summaries, and creates downloads without sending CSV contents to an application server.

## Start the app

Run `make setup` once, then run:

```bash
make web
```

Open the local URL that Vite prints. The production app uses the same static files and can run on Vercel or another static host. See [operations](operations.md) for deployment and the CSP report endpoint.

## Upload files

Open the Home screen and upload any supported files:

- `Shares.csv`
- `Comments.csv`
- `messages.csv`
- `Connections.csv`

The app identifies each file from its header row. It decodes UTF-8 first and falls back to WHATWG Windows-1252 when UTF-8 decoding fails. A warning appears when the fallback is used.

The app reads files in Web Workers when a feature needs a long parse. It keeps the browser responsive, but the upload size and parser limits still apply. Read [data formats](data-formats.md) for the required columns and the shared cleaner rules.

## Open a screen

The app has six hash routes:

| Screen      | Route          | Requires                                            |
| ----------- | -------------- | --------------------------------------------------- |
| Home        | `#home`        | No file                                             |
| Clean       | `#clean`       | At least one uploaded file                          |
| Analytics   | `#analytics`   | Shares or Comments data                             |
| Connections | `#connections` | Connections data                                    |
| Messages    | `#messages`    | Messages data, with Connections data when available |
| Insights    | `#insights`    | Analytics data                                      |

The app opens `#home` when the URL has no hash. Unknown routes return to Home. Hash routing means a shared route works on a static host without a server rewrite.

Analytics, Connections, Messages, and Insights share a `range` query parameter. Valid values are `1m`, `3m`, `6m`, `12m`, and `all`. The default is `12m`. For example, `#analytics?range=3m` opens Analytics with a three-month range. Home and Clean do not use the shared range.

## Clean files

Open **Clean** to create an Excel workbook for each uploaded file type. The browser cleaner uses the same columns, row rules, field rules, and formula protection as the Python cleaner. The browser creates the workbook locally and starts a download.

Use the [data formats reference](data-formats.md) when you need to check a required column or explain why a row disappeared.

## Read analytics

Open **Analytics** for local activity summaries:

- A timeline of activity over the selected range.
- A topic view that groups normalized words and hashtags.
- A day and hour heatmap.

Hover over a chart and select its download control to save a PNG. The chart export uses the chart canvas and does not send data anywhere.

## Read connections

Open **Connections** for:

- Connection growth over time.
- Top companies.
- Top positions.
- Total connections, recent additions, top company, and network age.

The screen filters data on the selected range. Empty sections show an empty state instead of an empty chart.

## Read messages

Open **Messages** for relationship summaries derived from your message and connection exports:

- **Top Contacts** ranks people by message activity in the selected range.
- **Silent Connections** finds connections with no matching message activity.
- **Fading Conversations** finds conversations whose recent activity has slowed.

Each list can download a full Excel workbook. The app keeps message contents out of the in-memory relationship aggregates used by the screen.

## Read insights

Open **Insights** for rule-based summaries built from the analytics, connections, and message aggregates. The screen shows advice about activity, topics, network growth, and outreach when the input data supports it.

The **All-time** section includes lifetime network growth and message outreach totals when message data is available. Change the range to compare recent behavior with the full history.

## Save a PDF

Select **Save as PDF** on any screen to create `linkedin-insights-YYYY-MM-DD.pdf`. The report is an A4 document, not a screenshot. It includes the selected dashboards, insight cards, a closing tip, and all-time stats when the data supports them.

The export uses a light warm palette even when the app uses dark mode. The document reports the data window from the newest date in the files, so the date range remains meaningful after you share the file later.

The confirmation dialog has two independent options. Both are unchecked every time the dialog opens:

- **Name people in the dashboards** adds names to the message dashboards. Aggregate company and position charts do not need this option.
- **Include message contents** adds the last five messages from the ten most recently messaged contacts. The export includes the contacts' names so each transcript has a heading.

Message contents remain in the file you download. The browser does not upload or log them. Canceling the dialog or pressing Escape cancels the export and stops its workers.

## Understand where the app keeps data

The app keeps uploaded CSV text and computed analytics in browser storage when IndexedDB is available. That storage lets the app restore uploads after a reload. If IndexedDB is unavailable or fails, the app uses memory and the data does not survive a reload.

A session has a 24-hour inactivity limit. On startup, the app clears stored uploads and analytics when the last activity is older than that limit. Select **Clear data** to remove the stored files and analytics immediately. Clear data before you leave a shared or public computer.

The app stores the theme preference, tutorial completion, and mini-tip state in `localStorage`. Those values do not contain CSV contents.

The production service worker caches the app shell, scripts, styles, fonts, and images. It uses a network-first strategy for navigation, stale-while-revalidate for scripts and styles, and cache-first for fonts and images. A new build is picked up on the next navigation.

## Understand diagnostics

Diagnostics are disabled until both conditions hold:

1. The build contains `VITE_SENTRY_DSN`.
2. You select the diagnostics consent control.

You can revoke consent from the footer. After consent, the app may send reduced error events and numeric performance measurements. It does not attach CSV text, file names, message bodies, contact names, URLs, DOM text, or arbitrary exception values.

CSP violation reports use the same-origin `/api/csp-report` endpoint when the deployment provides it. The endpoint accepts only POST requests, limits the body to 64 KiB, keeps a bounded set of violation metadata, strips URL queries and fragments, and returns `204` when forwarding is disabled. Configure server-side forwarding with `CSP_REPORT_URI` or `SENTRY_DSN`. These variables must not be exposed to the client.

## Check browser limits

The browser enforces these independent limits:

| Limit                     | Value   |
| ------------------------- | ------: |
| File size before decoding | 80 MiB  |
| Decoded text per file     | 60 MiB  |
| Parsed rows per file      | 500,000 |
| Columns per row           | 256     |
| Characters per field      | 200,000 |

A file above 25 MiB also receives a large-file warning before processing. The warning does not reject the file when it remains under the hard limits.

The CLI uses a 100 MiB input limit and 1,000,000 row limit by default. See [CLI resource limits](cli.md#set-global-options) for the CLI options.

## Use tutorials and themes

Each screen has a guided tutorial. The first visit starts the tutorial after loading finishes. Use the floating help button to replay the current screen's tutorial. Completing or skipping a tutorial enables that screen's contextual tips.

Tutorials support Back, Next, Finish, Skip, progress dots, `ArrowLeft`, `ArrowRight`, `Enter`, `Escape`, and focus trapping with `Tab` and `Shift+Tab`. Home includes the theme step. Home and Analytics introduce PDF export. Tutorial completion and mini-tip pacing are stored in versioned `localStorage` keys.

The theme toggle changes between light and dark palettes. The PDF export always uses the light warm palette. The mascot and other decorative drawings do not carry application data and are hidden from assistive technology.

## Understand the PWA and share metadata

The production build generates a relative-path PWA manifest from `web/vite.config.mjs`. It uses standalone display mode, self-hosted fonts, and the 192px and 512px PNG icons plus the SVG icon. The service worker precaches the build assets, so the app can work offline after a successful visit.

`web/index.html` supplies the favicon links, light and dark theme colors, Open Graph metadata, and Twitter card metadata. `web/public/robots.txt` allows crawlers. Keep asset URLs relative because the app can deploy below a domain root.

## Browser support

The Vite build targets ES2022. The automated browser suite runs on Chromium, Firefox, and WebKit. The app needs a browser with `FileReader`, `TextDecoder`, Web Workers, and IndexedDB support for its full persistence and processing behavior. Without IndexedDB, the app keeps working with in-memory state.
