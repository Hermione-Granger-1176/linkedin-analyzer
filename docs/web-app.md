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

Delegated click handlers use `DomEvents.closest(event, selector)` from `web/src/dom-events.js`.

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
- Use the floating `?` help button in the bottom-right corner to replay the tutorial for the current page.
- Completing or skipping marks that page tutorial as done; the floating help button resets and replays it.
- Tutorial auto-start waits until active loading overlays finish, then adds a brief visible pause before opening.
- Contextual mini-tip callouts appear only after the route tutorial is completed/skipped, then follow engagement-based pacing and cooldowns until dismissed.
- Tutorial completion, mini-tip dismissal, and mini-tip pacing metadata are stored in versioned `localStorage` keys (bump version to re-onboard after new tutorial features).
- Sketch-style arrow callouts point to the highlighted target; the arrow style varies per step unless a step specifies `arrowStyle`.

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

## Loading and Performance

- A shared loading overlay (gear animation) is used for analytics/connections/messages/insights data loading.
- Active content is blurred while loading to keep the loading state clear.
- Tutorial auto-start and mini-tip rendering are gated by loading state, so onboarding UI does not appear while loading overlays are active.
- Analytics computation runs in `analytics-worker.js`.
- Connections parsing runs in `connections-worker.js` with client-side filtering.
- Messages/connections parsing runs in `messages-worker.js` with safe fallback.
- IndexedDB stores raw files and analytics base when available; an in-memory fallback keeps the app functional but does not persist data across reloads.
- On startup, a non-blocking session TTL sweep clears stale uploads and cached analytics from IndexedDB and in-memory cache. Screens wait for cleanup to finish before loading stored data.
- Upload restore warms cache first, then schedules analytics priming to avoid blocking first paint.
- Service worker caches navigation with NetworkFirst, scripts/styles with StaleWhileRevalidate, and fonts/images with CacheFirst (30-day TTL) to auto-refresh users onto newer builds.
- **Clear All** removes stored uploads/analytics from IndexedDB and clears in-memory cache.
- Fonts are self-hosted (no external Google Fonts dependency).

## Privacy

Your file contents stay in your browser unless you explicitly enable diagnostics.

- Processing is local JavaScript only.
- Data persistence uses browser IndexedDB when available, with an in-memory fallback when IndexedDB is unavailable.
- Theme preference is persisted across sessions.
- Tutorial and mini-tip onboarding state is preserved in `localStorage` (versioned keys).
- No backend API calls for file content.
- If `VITE_SENTRY_DSN` is configured, diagnostics remain disabled until the user opts in.

## Running Locally

```bash
npm run dev
```

Then open the Vite URL printed in the terminal.

## Deployment

Deploy `web/dist/` to any static host (Vercel, Netlify, GitHub Pages).

Recommended production setup:

1. Build with `npm run build`
2. Publish the `web/dist/` output
3. Set environment variables:
   - `VITE_SENTRY_DSN` (optional; only used after user opt-in)
   - `VITE_APP_RELEASE` (recommended for release-level error tracking)
4. Verify security headers from `vercel.json` in deployed responses

## Browser Compatibility

- Vite production builds target `es2022`
- Playwright E2E coverage currently runs on Chromium, Firefox, and WebKit
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

`assets/manifest.webmanifest` declares the app name, icons, theme color, and standalone display mode. All paths use relative URLs so the app works under any base path. This enables "Add to Home Screen" on mobile devices.

### Open Graph and Twitter Cards

`index.html` includes `og:*` and `twitter:*` meta tags so that link previews show the app title, description, and icon when shared on social platforms. Image URLs are relative so they resolve correctly on any deploy target.

### Theme Color

Two `<meta name="theme-color">` tags (one per `prefers-color-scheme`) tint the browser chrome to match the light (`rgba(255, 253, 247, 1)`) or dark (`rgba(28, 25, 23, 1)`) theme.

### robots.txt

`web/public/robots.txt` allows all crawlers.
