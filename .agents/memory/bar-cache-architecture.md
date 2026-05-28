---
name: Bar cache architecture
description: Root cause of Polygon 429 bursts and the full caching fix in history.ts + provider abstraction in polygon.ts
---

## The rule

In-flight deduplication is the most important fix — it collapses concurrent cold-cache requests for the same key into one Polygon call. Without it, /api/history and /api/signals both fire on page load and both start independent fetches before either populates the shared map.

**Why:** Polygon free tier = 5 req/min. /api/history, /api/signals auto-seed (5m + 15m), and /api/signals/regenerate (5m + 15m + 1d) all call fetchHistory. On a cold cache they each burn a quota slot. With dedup, all concurrent callers share the same Promise → 1 Polygon call total.

**How to apply:**
- `inflight` Map in history.ts: `Map<string, Promise<unknown[]>>`
- Check inflight before starting any fetch; set on start, delete in `.finally()`
- 24h memory TTL is safe for intraday historical bars (bars older than today are immutable; only today's tail updates, and signals are regenerated explicitly)
- Disk cache (`data/barcache/<key>.json`) survives server restarts → zero Polygon calls on warm restart
- Stale-on-error fallback: if Polygon throws and disk cache exists, serve stale data rather than empty array (signal generation still works offline)

## Provider abstraction

`BarProvider` interface + `PolygonBarProvider` class live in `artifacts/api-server/src/lib/polygon.ts`.
To add a new provider (Alpaca, TwelveData, Binance, CSV replay): implement `BarProvider`, export it, swap the call in `fetchHistory` inside history.ts.

## Chart visual rule

EMA/VWAP/RSI/ATR are computed inside the signal engine only — never rendered as chart series. The chart shows candles + volume + signal markers only. No indicator lines on the chart ever.
