---
name: History blending rule
description: Never mix daily bars with intraday bars — it breaks the price axis
---

## Rule

For 5m and 15m chart views, fetch **intraday-only** data. Do not use `&blended=true` or any mechanism that merges daily OHLCV (which spans 1999–present at $2–$236) with intraday bars (which span 60 days at current prices).

## Why

LightweightCharts auto-scales the Y axis to ALL loaded bars. A single daily bar from 1999 at $2 forces the axis to span $2–$236, compressing all recent intraday bars into a tiny vertical slice that appears as "fake prices" / "incorrect scaling" to the user.

## How to apply

- `ChartPage.tsx` fetch URL: `?symbol=NVDA&interval=5m` — no `&blended=true`
- The `fetchBlended()` helper in `history.ts` may remain for potential future use (e.g., a separate "long-term" view) but must never be called for intraday timeframes
- Pure intraday 5m for NVDA yields ~4,680 bars (60 trading days)
