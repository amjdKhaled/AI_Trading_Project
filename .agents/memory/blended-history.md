---
name: Blended history architecture
description: How the history route merges daily + intraday data for chart display
---

`GET /api/history?symbol=X&interval=5m&blended=true` triggers fetchBlended():
- Runs two yfinance fetches in parallel: daily "max" (up to 50 years) + intraday 60d
- Cuts daily bars where `time >= firstIntradayTime - 86400*2` to avoid overlap
- Returns [...filteredDaily, ...intraday] — seamless long-history chart

**Key rules:**
- Blended is ONLY for display (ChartPage.tsx adds `&blended=true`)
- Signal seeding uses `fetchHistory()` (intraday-only) — blended bars would break signal timestamps
- Only active for 5m and 15m intervals (other intervals already have max history)
- Cache TTL for blended = 300_000ms (5 min) regardless of interval config

**Result:** 11,495 bars for NVDA 5m (1999→2026) vs 864 bars intraday-only.

**Why:** Intraday 5m is capped at 60 days by yfinance. Daily bars give historical context for structure analysis in the UI. Signal engine still only sees clean intraday data.
