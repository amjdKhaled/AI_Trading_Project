---
name: Live bar corruption root causes
description: Two server-side bugs that inject daily-scale OHLC into intraday 5m charts, causing giant candles and autoscale collapse.
---

## The two root causes

### Bug A — `pollSnapshots()` open price (websocket.ts)
`snap.open` from `fetchAlpacaSnapshot()` is the **daily market-open price** (e.g. $218.50 at 9:30 AM), not the price at the start of the current 5m bar.  When a new 5m boundary ticks over and `prev?.time !== barTs`, using `snap.open` as the bar open creates a candle spanning from $218.50 → $215.34 (current price) = $3 range on a chart where normal 5m bars are $0.50.  This re-fires every 5 minutes during market hours.

**Fix:** `open: isNewBar ? snap.price : prev!.open` — always seed new bars at the current price.

### Bug B — Initial on-connect partial bar (websocket.ts)
The on-connect snapshot also used `snap.open / snap.high / snap.low` (daily values).  
**Fix:** seed all four OHLC at `snap.price`.

## Client-side defences added (TradingChart.tsx)

1. **Symbol guard** — reject `lastBar` where `lastBar.symbol !== symbol` (symbol-switch race)
2. **Market-open guard** — skip all live ticks when `!isMarketOpen`
3. **OHLC integrity** — `isValidOhlc()` rejects any bar with impossible H/L/O/C
4. **ATR spike filter** — rolling avg bar range × 5 (or 2% of price, whichever larger); rejects daily-range contamination
5. **Historical guard** — `lastHistTimeRef` records last loaded historical bar time; live tick never applies to `t < lastHistTime`
6. **Live-bar tracking** — `liveBarTimeRef` discards stale updates for past 5m boundaries
7. **setData validation** — historical bars filtered through `isValidOhlc()` before `setData()`

## Why snap.open ≠ current 5m open
`fetchAlpacaSnapshot` returns `data.dailyBar.o` as `open`.  The Alpaca snapshot API's `dailyBar` is the **session bar** (full day), not a per-minute bar.  Never use `snap.open/high/low` for intraday partial bar construction.
