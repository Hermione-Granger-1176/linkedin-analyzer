# Web App Guide

The LinkedIn Analyzer web app runs entirely in your browser. File contents are not uploaded to an app server.

## Getting Started

1. Open the app in your browser.
2. Upload one or more LinkedIn CSV exports:
   - `Shares.csv`
   - `Comments.csv`
   - `messages.csv`
   - `Connections.csv`
3. Navigate to the screen you need: Clean, Analytics, Connections, Messages, or Insights.

## Routing (SPA)

The app is a single-page app (SPA) with hash routes.

- Home: `#home`
- Clean: `#clean`
- Analytics: `#analytics`
- Connections: `#connections`
- Messages: `#messages`
- Insights: `#insights`

Examples:

- `#analytics?range=3m`
- `#connections?range=12m`
- `#messages?range=6m`
- `#insights?range=all`

## Shared Time Range Behavior

Time range is shared across Analytics, Connections, Messages, and Insights.

- If you set `3 months` in Analytics, then move to Connections, Messages, or Insights, that same range is applied.
- Clean and Home do not use this shared range state.

Supported range values:

- `1m`, `3m`, `6m`, `12m`, `all`

## Delegated Click Safety

Delegated click handlers use `DomEvents.closest(event, selector)` from `web/src/shared/dom-events.js`.

- Prevents runtime errors when `event.target` is not an `Element` (for example text-node targets).
- Keeps delegated handler guards consistent across screens.

## Guided Tutorials

Each screen has its own guided tutorial with first-visit auto-start after a short delay (~1.5s):

- Home
- Clean
- Analytics
- Connections
- Messages
- Insights

Tutorial controls:

- `Back`, `Next` (or `Finish` on final step), and `Skip`
- Progress counter and step dots
- Keyboard shortcuts: `ArrowLeft`, `ArrowRight`, `Enter`, `Escape`, and `Tab`/`Shift+Tab` focus trapping

Special behavior:

- Only the **Home** tutorial includes the dark/light mode step (`#themeToggle`).
- **Home** and **Analytics** both introduce Save as PDF (`#pdfExportBtn`). The button is global, so both steps come from one `createPdfExportStep()` factory in `steps.js`: pass a route, its wording, and a route-scoped fallback target to add the step to another screen. Home explains that the button waits on an upload; Analytics explains the message-contents opt-in.
- Use the floating help button in the bottom-right corner to replay the tutorial for the current page. It shows Pip peeking out of the dashed circle with a small `?` held up beside his head.
- Completing or skipping marks that page tutorial as done; the floating help button resets and replays it.
- Tutorial auto-start waits until active loading overlays finish, then adds a brief visible pause before opening.
- Contextual mini-tip callouts appear only after the route tutorial is completed/skipped, then follow engagement-based pacing and cooldowns until dismissed.
- Tutorial completion, mini-tip dismissal, and mini-tip pacing metadata are stored in versioned `localStorage` keys (bump version to re-onboard after new tutorial features).
- Sketch-style arrow callouts point to the highlighted target; the arrow style varies per step unless a step specifies `arrowStyle`.
- Pip guides the tour from a top corner of the callout card. He takes the corner away from the target, so he never sits on the pointer arrow or the highlighted element, and mirrors to gesture across the card toward it. He presents through the tour and waves on the final step. He is decoration: aria-hidden, no pointer events, and positioned out of flow so the card measures the same size with or without him.

## Mascot

Pip is the hand-drawn character who turns up across the app: waving beside the hero title, scribbling in the loading overlays, peeking over the top of an empty box, panicking next to a clean error, cheering a finished export, leaning on the Insights and Messages tips, peeking out of the floating help button, guiding the tutorial, and reacting in the corner of every insight card. He is decoration everywhere: `aria-hidden`, `focusable="false"`, and no pointer events.

Four places hold the drawings, and each owns one thing:

| Where                                   | Owns                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| `<defs>` in `web/index.html`            | The shared `#pipWobble` ink filter, and one `<g id="pip-...">` per pose used more than once |
| `web/src/styles/components/mascot.css`  | The character: ink and fill classes, idle loops, one-shot moves, the reduced-motion guard   |
| Feature stylesheets                     | Where a pose sits on a surface: size, offset, mirroring                                     |
| `reactions.js` and `tutorial/mascot.js` | The two poses built in JavaScript, drawn with the same `pip-*` classes                      |

A pose drawn in more than one place is defined once in the `<defs>` block at the top of `index.html`, and each placement is a wrapper `<svg>` carrying its own class and `viewBox` around a `<use href="#pip-...">`. That covers the peeker (five empty states), the tipster (two tips), and the scribbler (two loading overlays). Poses drawn only once stay inline where they appear.

Two rules follow from how `<use>` works, and both are load-bearing:

- A `<use>` builds a shadow tree, and a selector written outside the placement cannot reach into it. Anything a pose needs must therefore be a class on the definition itself. The cheer and the help-button head are styled from an ancestor (`.is-cheering .pip-jump`, `.tutorial-help-pip .tutorial-help-mark`), so they have to stay inline.
- The definitions are groups rather than `<symbol>`s. A symbol renders through a nested viewport, which rounds an instance sitting on a fractional pixel differently from the inline drawing it replaced. A referenced group is placed by a plain translate and rasterises identically.

Every idle loop is infinite on purpose: the screenshot harness waits for finite animations to finish, so a loop that never settles must never claim to. One-shot moves (the splat, the cheer, the hub wiggle) are finite. Everything switches off under `prefers-reduced-motion: reduce`.

## Screens

### Home

Upload hub for all supported CSV types. Shows file readiness and processing status.

### Clean

Converts uploaded CSV data into formatted `.xlsx` files.

- Shares and comments escaping fixes
- Messages and connections cleaning parity with Python cleaner
- Excel export with column widths and wrapped text

### Analytics

Interactive activity dashboard:

- Timeline chart
- Top topics chart
- Day/hour heatmap

Charts support PNG export via download button on hover.

### Connections

Network analytics dashboard:

- Connection growth timeline
- Top companies in network (bar chart)
- Top positions/roles (bar chart)
- Stats: total connections, recent adds, top company, network age

Charts support PNG export via download button on hover.

### Messages

Relationship-focused view derived from messages and connections:

- Top Contacts
- Silent Connections
- Fading Conversations

Each panel includes a full-list Excel export button.

### Insights

Rule-based recommendations and summaries generated from analytics aggregates.

## Save as PDF

A **Save as PDF** button sits beside the theme toggle on every screen, and downloads an A4 document named `linkedin-insights-YYYY-MM-DD.pdf`.

The PDF is a document in its own right, not a screenshot. It is laid out and drawn by `features/export/pdf-document.js`: measured blocks placed onto A4 pages, with page breaks that do not split an insight card or strand a heading at the foot of a page unless the block is taller than a page on its own, and a `Page x of y` footer. Text colour is chosen by measured contrast against whatever it is drawn on rather than by the name of the accent, so a card title or a direction chip stays legible whatever the palette tokens are set to.

- It contains the header with the window the data covers and the generation date, a dashboard per screen (see below), every insight card (the screen shows only the first six), the closing pro tip, and the all-time stats. Exporting from the Insights screen uses the range selected there; exporting from anywhere else uses the default last-12-months range. The header names the months rather than the range, `Feb 2024 to Jan 2025` and not `Last 12 months`: the window is anchored on the newest thing in the file rather than on today, which reads correctly on a screen and reads as a lie in a document that outlives the day it was made.
- It is **always light and warm-palette**, whichever theme the app is in. The colors are read back out of the stylesheet at export time (`features/export/palette.js` mounts a detached `.theme-light` probe), so the document cannot drift from the site palette.
- Fonts are the same handwritten faces the app uses on screen, shipped as TrueType next to the `.woff2` files and fetched only when an export runs. A fetch failure falls back to Helvetica and still produces a valid PDF.
- Those faces are Latin, and a PDF has no fallback font the way a browser does, so a character they cannot draw would simply vanish from the page: `Ňuňo` printed as `uo`, and a name written entirely in another script printed as nothing at all. `features/export/drawable-text.js` replaces each run of undrawable characters with a single `?` before the model is drawn, so the loss is visible and a reader can tell a name was damaged rather than reading a different name. The drawable set is read from each font's own `cmap` table at load time rather than assumed, text is composed to NFC first so a decomposed accent is not mistaken for an unsupported one, and the Helvetica fallback path is sanitized to WinAnsi, where one stray character used to turn the whole line into mojibake. Shipping a face with wider coverage was the alternative and was rejected: it would add megabytes to an app that fetches 225 KB of fonts only when someone exports.
- `jspdf` is loaded with a dynamic `import()`, so it never enters the initial bundle. So is the export's own machinery: collection, the three transports, the layout engine, the charts, the fonts and the palette all sit behind `features/export/pdf-runtime.js`, one boundary and one chunk, fetched the first time somebody exports and kept for the rest of the session. The button is on every screen, so `features/export/pdf.js` is initialized on every page load, and what that costs is now the dialog and the availability check alone: 43 KB of drawing and collection code left the entry chunk, which is 218 KB raw and 68 KB gzipped with the boundary in place against 261 KB and 81 KB without it. The check itself reads `features/export/availability.js`, which is deliberately small and knows nothing about the rest, since a dynamic import inside it would fetch the whole graph on load and merely do it asynchronously.
- Cancelling before or during that fetch is safe: there is no worker to terminate yet, the chunk is not pulled down in order to say so, and a run whose modules arrive after the user has walked away does not go on to build anything. A chunk that fails to arrive reports exactly as a failed generation does, a fixed message in the dialog and a fixed error in diagnostics, and the failure is not remembered, so the next attempt goes back to the network.
- The button ships marked unavailable with `aria-disabled` rather than the `disabled` attribute, so it keeps its place in the tab order and the reason in its accessible name stays reachable; it becomes available only once the availability check has resolved. Availability is asynchronous, so its resting state has to be the unavailable one.
- Escape closes the dialog at any point, including mid-generation, which cancels the export: the analytics, messages, connections and thread workers are all terminated, and a late result cannot download, reopen the dialog or take focus back. Every step that parses a file does it in a worker for the same reason: a connections export cleaned on the UI thread held it long enough that the Escape key could not reach its own handler.

### A dashboard per screen

Analytics, Connections and Messages each become a dashboard, laid out as the screen is: a strip of stat tiles first, then the screen's charts in the screen's order. The first dashboard follows the title on page one; every later one opens a page of its own through a `pageBreakBefore` block, so a reader leafing through the file finds the divisions they navigate on screen. A dashboard opens a page but is not confined to one: it runs onto a further page when it has the data for it, and that page opens with a running head naming the dashboard as continued, so a reader who lands mid-dashboard is never looking at an unlabeled chart. The charts were briefly sized to make the tallest dashboard fit exactly one page, which held together at 2 mm of slack and meant every plot was as short as the page demanded rather than as tall as it deserved. The screens' own calculations are reused rather than reimplemented, so a number on the page is the number on the screen: the analytics dashboard is drawn from the analytics worker's view (the run the insight cards already needed, now asked for at the range the header shows rather than always the default), the connections dashboard from `features/connections/view.js`, which the Connections screen and its worker share, and the messages dashboard from `features/messages/relationships.js`. Each of those two runs its screen's parsing worker through a transport of the export's own, `features/export/connections-transport.js` and `features/export/messages-transport.js`, rather than through the screen's: a screen keeps one worker, one watchdog and one request counter in module scope, so an export running alongside a screen load would have cleared the other's watchdog, and cancelling an export could not have ended a worker the screen might still be mid-request on. Both transports behave the same way when there is no worker to run: an export under 5 MB is parsed on the main thread, a larger one drops its dashboard rather than freezing the page, and a worker that answers with a definite failure drops it too, since re-running the same code over the same bytes would only arrive at the same answer. "Definite" means the worker attributed the failure to the request it was given: it answers under that request's id when the parse itself failed, and under id zero when it fell over before or outside of that, and only the first says anything about the file. That distinction is also what makes a crash deterministic, since a crash reaches the main thread both as the id-zero envelope and as an error event on the Worker object, and the two are unordered. They behave the same way because they are the same mechanism: `features/export/worker-transport.js` owns the worker, the watchdog and the settling for all three of the export's transports, and each transport supplies only what it asks for, how it reads the reply, and what it does when there is no worker.

The charts are **redrawn as vectors**, not captured. `features/export/pdf-charts.js` re-plots the timeline, the bar charts and the heatmap out of lines, rectangles and circles, so they stay sharp at any zoom and any paper size; a canvas snapshot would be fixed at the resolution it was taken at. Fills that the screen draws with alpha are pre-blended against the paper by `mixColors`, since PDF fills are opaque. A chart with nothing to plot is left out rather than drawn as empty axes: the line, bar and list charts count as empty when they carry no points or items, and the heatmap when every one of its cells is zero, since the analytics worker always hands over a full week of hours whether or not anything happened in it. A dashboard left with neither stats nor charts does not open a page at all.

### Naming people in the dashboards is opt-in

The messages dashboard always carries its counts: messages and people in range, total connections, and how many conversations are fading. It also carries one chart of its own, messages per month, which counts nobody by name. That chart exists because the page had none: every other element on it was name-gated, so at the default settings the dashboard was four numbers on an otherwise blank sheet, which is what most people exporting would have got. The lists that **name** somebody (top contacts, silent connections, fading conversations) appear only when **Name people in the dashboards** is ticked, unchecked by default. Company and job-title charts count as aggregate and are always included.

The two opt-ins are independent, and both reset every time the dialog is opened: an export is a fresh decision about what leaves the browser, not a remembered setting. They are not, however, a single guarantee about names. A message transcript is headed by the person it is with, so ticking **Include message contents** puts those contacts' names in the file whatever this box says, which is why its own hint says so. This one governs the dashboards; nothing can promise a transcript without a correspondent.

### Message contents are opt-in

The confirmation dialog offers one extra section, **unchecked by default**: the last 5 messages of your 10 most recently messaged contacts, in full.

The hydrated message state the app keeps in memory deliberately discards message text, so this section re-reads the stored CSV and selects the threads in a dedicated worker (`features/export/threads-worker.js`). That re-read uses `features/export/messages-parse.js`, not the spreadsheet cleaner: formula-injection escaping and cell trimming are what a workbook needs, and they would turn "+1, that works for me" into "'+1, that works for me" on the page. Dates, names and URLs are still normalized the same way.

When the browser has no Web Worker at all, an export under 5 MB is selected on the main thread instead, and a larger one drops the section rather than freezing the page. A worker that answers with a definite failure also drops the section: it has already parsed that exact file with that exact code, so re-running it on the main thread would only arrive at the same answer. A failure the worker could not attribute to the request it was given is a different thing, answered under id zero, and falls back like any other non-answer.

Threads are grouped by `CONVERSATION ID` first, and each conversation's correspondents are resolved across all of its rows rather than per row, so a contact who is renamed halfway through, or whose profile URL appears on only some rows, never splits the conversation in two, and a row that names nobody joins its conversation whichever order it arrives in. Rows with a blank id group by their correspondents instead. A conversation with more than one correspondent stays its own thread, titled with all of them, rather than merging into anyone's one-to-one thread.

Message direction comes from the account owner, who is identified in two steps. The connections file goes first, because it is a fact about the export rather than a heuristic over it: you are never in your own connections, so anybody it names is not the owner. A profile URL settles that outright. A display name only counts when the identity carries no URL to check instead, because sharing a display name with one of your own connections is common, and trusting a name hit over a profile URL would hand the owner's side of the conversation to the other person.

Whoever is left is then judged on conversation coverage, which decides alone: the owner is in every conversation and everybody else is in their own, so the widest coverage is the owner. Requiring the owner to have both sent and received cannot be a filter, since an inbox nobody has replied to has an owner who never sends, and as a preference it could only ever agree with coverage or overrule a tie the export has no business overruling.

Where that still does not produce a unique winner (a single message, or one conversation on its own, where the two people are indistinguishable) the export says so: the messages carry a neutral **Message** chip instead of **Sent** or **Received**, and both people are listed as correspondents.

Message bodies leave the app only inside the file you download, to the location you choose. Nothing is uploaded, and nothing about the threads (bodies, contact names or the file name) is ever attached to diagnostics. Leaving the box unchecked means no message text appears in the output at all.

## Loading and Performance

- A shared loading overlay (Pip, the mascot, scribbling on a pad) is used for analytics/connections/messages/insights data loading.
- Active content is blurred while loading to keep the loading state clear.
- Tutorial auto-start and mini-tip rendering are gated by loading state, so onboarding UI does not appear while loading overlays are active.
- Analytics computation runs in `features/analytics/analytics-worker.js`.
- Connections parsing runs in `features/connections/connections-worker.js` with client-side filtering.
- Messages/connections parsing runs in `features/messages/messages-worker.js` with safe fallback.
- PDF export thread selection runs in `features/export/threads-worker.js`, created on demand and terminated as soon as the export has its threads, with a main-thread fallback for exports under 5 MB when no worker is available. That worker is also handed the raw connections file, and derives the contact keys itself: an export holding one conversation cannot say which of its two people is the account owner, but nobody is in their own connections list. The keys come off the parsed rows rather than the cleaned ones, because cleaning drops a connection whose export recorded no date, and somebody you are connected to is still not you whether or not the date survived.
- The PDF export's connections and messages dashboards run the two screens' own parsing workers the same way, each through its own transport, so nothing an export parses is parsed on the UI thread.
- Cleaning resolves each file type's column cleaners once, then reuses that plan for every row instead of repeating configuration lookups for every cell.
- Analytics topic extraction preserves hashtag-first ordering while inserting normalized tokens directly into one deduplicating set.
- IndexedDB stores raw CSV text and analytics base when available so uploads can be restored after reloads; an in-memory fallback keeps the app functional but does not persist data across reloads.
- On startup, a non-blocking session TTL sweep clears stale uploads and cached analytics from IndexedDB and in-memory cache. Screens wait for cleanup to finish before loading stored data.
- Upload restore warms the storage-backed file cache only. Analytics priming is deferred until fresh uploads because dashboards read persisted analytics directly.
- Service worker caches navigation with NetworkFirst, scripts/styles with StaleWhileRevalidate, and fonts/images with CacheFirst (30-day TTL). New builds are picked up on the next navigation (the worker is registered with `updateViaCache: "none"` and calls `update()` on load), not mid-session.
- **Clear data** removes stored uploads/analytics from IndexedDB and clears in-memory cache.
- Fonts are self-hosted (no external Google Fonts dependency).

## Limits

The web app enforces upload and parser caps to keep processing responsive and bounded:

- 80 MB maximum per uploaded file (files above this are rejected before decoding).
- 60 MB of decoded text per file (`MAX_CSV_CHARS`); multi-byte files between 60 MB and 80 MB on disk may still decode under this cap, so the byte gate stays at 80 MB.
- 500000 parsed rows per file (`web/src/features/cleaning/csv-parser.js`).
- 256 columns per row and 200000 characters per field.

These are independent of the CLI, which applies its own defaults (104857600 bytes and 1000000 rows, both configurable). See [Resource limits](cli.md#resource-limits) for the CLI caps.

## Privacy

Your file contents stay in your browser unless you explicitly enable diagnostics.

- Processing is local JavaScript only.
- Raw CSV data may be saved in this browser's IndexedDB for upload restore and analytics views.
- Data persistence uses browser IndexedDB when available, with an in-memory fallback when IndexedDB is unavailable.
- On a shared or public computer, remember that IndexedDB persistence keeps your uploads and analytics on that device until the session TTL sweep runs or you use **Clear data**. Clear your data before leaving.
- **Clear data** removes saved uploads and cached analytics from this device.
- Stale uploads are cleared by the session TTL sweep when the app next runs cleanup.
- Theme preference is persisted across sessions.
- Tutorial and mini-tip onboarding state is preserved in `localStorage` (versioned keys).
- No backend API calls for file content.
- **Save as PDF** writes your dashboards and insights, and optionally the names of your contacts and your message bodies, into a file you download. Each of those two is its own opt-in, unchecked every time the dialog opens. That file never leaves your device unless you send it somewhere, and no part of it is logged or reported.
- If `VITE_SENTRY_DSN` is configured, diagnostics remain disabled until the user opts in.
- After opt-in, outbound error events are reduced to fixed module/operation identifiers, allowlisted enum tags, normalized same-origin JavaScript or service-worker pathnames with nonnegative integer line/column data, sourcemap debug IDs, and build environment/release metadata. Raw user-controlled strings are not attached.
- Performance telemetry contains only allowlisted nonnegative numeric web-vital and internal timing values, plus positive integer sample counts, sent as a numeric-only `session-metrics` batch each time a nonempty buffer is flushed on page hide.

## Running Locally

```bash
make web
```

Then open the Vite URL printed in the terminal.

## Deployment

Deploy `web/dist/` to any static host (Vercel, Netlify, GitHub Pages). The first-party CSP report collector lives in `api/csp-report.mjs`; Vercel deploys it automatically, while static-only hosts need an equivalent endpoint or should omit the CSP reporting directives.

Recommended production setup:

1. Build locally with `make web-build`
2. Publish the `web/dist/` output
3. Set environment variables:
   - `VITE_SENTRY_DSN` (optional; only used after user opt-in)
   - `VITE_APP_RELEASE` (recommended for release-level error tracking)
   - `CSP_REPORT_URI` or `SENTRY_DSN` (optional, server-side only; enables forwarding of CSP violation reports collected at `/api/csp-report`)
4. Verify security headers from `vercel.json` in deployed responses (the CSP reports violations to the first-party `/api/csp-report` endpoint)

## Browser Compatibility

- Vite production builds target `es2022`
- Playwright E2E coverage currently runs on Chromium, Firefox, and WebKit with four workers
- Hash routing (`#...`) avoids server-side rewrite requirements

## Icons and Meta

The app ships with a hand-drawn favicon set and production meta tags.

### Favicon

Browsers pick the best format automatically:

| Repo path                                | Size  | Used by                         |
| ---------------------------------------- | ----- | ------------------------------- |
| `web/public/assets/icon.svg`             | any   | Modern browsers (Chrome, FF)    |
| `web/public/assets/favicon.ico`          | 32px  | Legacy browsers (older IE/Edge) |
| `web/public/assets/apple-touch-icon.png` | 180px | iOS home screen bookmark        |
| `web/public/assets/icon-192.png`         | 192px | Android home screen, PWA        |
| `web/public/assets/icon-512.png`         | 512px | PWA splash screen, OG cards     |

### PWA Manifest

`web/vite.config.js` is the single source for the PWA manifest metadata, including the app name, description, icons, theme color, and standalone display mode. `vite-plugin-pwa` generates `manifest.webmanifest` and injects its link during the production build. Relative URLs keep the app installable under any base path.

### Open Graph and Twitter Cards

`index.html` includes `og:*` and `twitter:*` meta tags so that link previews show the app title, description, and icon when shared on social platforms. Image URLs are relative so they resolve correctly on any deploy target.

### Theme Color

Two `<meta name="theme-color">` tags (one per `prefers-color-scheme`) tint the browser chrome to match the light (`rgba(255, 253, 247, 1)`) or dark (`rgba(32, 26, 21, 1)`) theme.

### robots.txt

`web/public/robots.txt` allows all crawlers.
