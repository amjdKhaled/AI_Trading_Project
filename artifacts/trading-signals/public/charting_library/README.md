# TradingView Charting Library

This folder is where the **official TradingView Charting Library** must live.
The library is licensed (free for use, but not redistributable on npm or a public
CDN), so it cannot be checked into this repo.

## How to install it

1. Apply for access at <https://www.tradingview.com/charting-library/>.
   It's free; approval usually takes a day or two. You'll need a GitHub
   username so they can grant access to the private repo.
2. Clone the private repo they invite you to:
   ```bash
   git clone git@github.com:tradingview/charting_library.git
   ```
3. Copy the contents of that repo's `charting_library/` folder into **this**
   folder, so the layout looks like:
   ```
   artifacts/trading-signals/public/charting_library/
     ├── charting_library.standalone.js
     ├── charting_library.esm.js
     ├── bundles/
     ├── datafeeds/        (optional — we ship our own custom datafeed)
     └── …
   ```
4. Refresh the app. The chart will auto-load.

## What's already wired up for you

- **UDF backend** at `/api/udf/*` (config, time, symbols, search, history) —
  backed by Polygon SIP for intraday and yfinance for daily+.
- **Custom datafeed** at `src/lib/tvDatafeed.ts` — uses UDF for history and the
  existing `/ws` WebSocket for live `subscribeBars` (no polling).
- **TVChartContainer** at `src/components/TVChartContainer.tsx` — handles
  mounting the widget, signal arrow markers, and SL/TP horizontal lines.

If the library files aren't here, the chart panel shows an in-app notice with
these same instructions instead of breaking the app.
