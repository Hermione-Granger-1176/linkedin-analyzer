# Web App Guide

The LinkedIn Analyzer web app runs entirely in your browser. No data is uploaded anywhere.

## Getting Started

1. Open the app in your browser
2. Drag and drop your LinkedIn CSV exports (Shares.csv, Comments.csv)
3. Choose what to do: Clean, Analytics, or Insights

## Pages

### Home

Upload hub where you drop your CSV files. Shows upload status for each file type.

### Clean

Convert messy LinkedIn CSVs to formatted Excel files.

- Fixes quote escaping issues in Shares.csv
- Fixes backslash escaping in Comments.csv
- Downloads as `.xlsx` with proper column widths and text wrapping

### Analytics

Visual dashboards for your LinkedIn activity:

- **Timeline** — Posts and comments over time (line/area chart)
- **Topics** — Most common words in your posts (bar chart)
- **Heatmap** — Activity by day of week and hour

Time range options: 1 month, 3 months, 6 months, 1 year, All time

### Insights

AI-generated takeaways based on your activity patterns.

## Features

### Offline Support

After the first load, the app works offline. All processing happens locally.

### Theme Toggle

Click the sun/moon icon to switch between light and dark mode. Your preference is saved.

### Privacy

Your files never leave your browser:

- All processing uses JavaScript in the browser
- IndexedDB stores data locally
- Web Workers handle heavy computation
- No server, no uploads, no tracking

## Running Locally

```bash
# Using Python
python3 -m http.server 3000 --directory web

# Using npx
npx serve web -l 3000
```

Then open http://localhost:3000

## Deployment

Deploy to Vercel, Netlify, or any static hosting. The `web/` folder contains everything needed.

```bash
# Vercel
vercel --prod

# Or just push to GitHub and import in Vercel dashboard
```
