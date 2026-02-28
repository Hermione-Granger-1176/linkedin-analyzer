# Web App Guide

The LinkedIn Analyzer web app runs entirely in your browser. No data is uploaded to a server.

## Getting Started

1. Open the app in your browser.
2. Upload one or more LinkedIn CSV exports:
   - `Shares.csv`
   - `Comments.csv`
   - `messages.csv`
   - `Connections.csv`
3. Navigate to the screen you need: Clean, Analytics, Messages, or Insights.

## Routing (SPA)

The app is a single-page app (SPA) with hash routes.

- Home: `#home`
- Clean: `#clean`
- Analytics: `#analytics`
- Messages: `#messages`
- Insights: `#insights`

Examples:

- `#analytics?range=3m`
- `#messages?range=6m`
- `#insights?range=all`

Legacy HTML pages (`clean.html`, `analytics.html`, `messages.html`, `insights.html`) now redirect to these routes.

## Shared Time Range Behavior

Time range is shared across Analytics, Messages, and Insights.

- If you set `3 months` in Analytics, then move to Messages or Insights, that same range is applied.
- Clean and Home do not use this shared range state.

Supported range values:

- `1m`, `3m`, `6m`, `12m`, `all`

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

### Messages

Relationship-focused view derived from messages and connections:

- Top Contacts
- Silent Connections
- Fading Conversations

Each panel includes a full-list Excel export button.

### Insights

Rule-based recommendations and summaries generated from analytics aggregates.

## Loading and Performance

- A shared loading overlay (gear animation) is used for analytics/messages/insights data loading.
- Active content is blurred while loading to keep the loading state clear.
- Analytics computation runs in `analytics-worker.js`.
- Messages/connections parsing runs in `messages-worker.js` with safe fallback.
- IndexedDB stores raw files and analytics base; in-memory cache avoids repeated parsing across route switches.

## Privacy

Your files never leave your browser.

- Processing is local JavaScript only.
- Data persistence uses browser IndexedDB.
- No backend API calls for file content.

## Running Locally

```bash
# Using Python
python3 -m http.server 3000 --directory web

# Using npx
npx serve web -l 3000
```

Then open `http://localhost:3000`.

## Deployment

Deploy `web/` to any static host (Vercel, Netlify, GitHub Pages).

## Icons and Meta

The app ships with a hand-drawn favicon set and production meta tags.

### Favicon

Browsers pick the best format automatically:

| File                          | Size  | Used by                         |
| ----------------------------- | ----- | ------------------------------- |
| `assets/icon.svg`             | any   | Modern browsers (Chrome, FF)    |
| `assets/favicon.ico`          | 32px  | Legacy browsers (older IE/Edge) |
| `assets/apple-touch-icon.png` | 180px | iOS home screen bookmark        |
| `assets/icon-192.png`         | 192px | Android home screen, PWA        |
| `assets/icon-512.png`         | 512px | PWA splash screen, OG cards     |

### PWA Manifest

`assets/manifest.webmanifest` declares the app name, icons, theme color, and standalone display mode. All paths use relative URLs so the app works under any base path. This enables "Add to Home Screen" on mobile devices.

### Open Graph and Twitter Cards

`index.html` includes `og:*` and `twitter:*` meta tags so that link previews show the app title, description, and icon when shared on social platforms. Image URLs are relative so they resolve correctly on any deploy target.

### Theme Color

Two `<meta name="theme-color">` tags (one per `prefers-color-scheme`) tint the browser chrome to match the light (`#FDF6E3`) or dark (`#1A1A2E`) theme.

### robots.txt

`web/robots.txt` allows all crawlers.
