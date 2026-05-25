---
name: Signal DB data hygiene
description: riskTag enum values, duplicate prevention, WebSocket rules, and timeframe-aware seeding
---

## riskTag enum values
Valid: `"Safe"` | `"Medium"` | `"Danger"`. Old code emitted `"Dangerous"` — invalid and causes Zod 500.
Fix: `UPDATE signals SET risk_tag = 'Danger' WHERE risk_tag = 'Dangerous';`

## Timeframe-aware seeding
Signals MUST be seeded from the same timeframe the chart is viewing. Cross-timeframe barTimes cause `timeToCoordinate()` to return `null` (e.g., 1d timestamps don't exist on a 5m chart).

**How to apply:**
- `/api/signals` must accept `timeframe` query param and filter by `signals.timeframe`
- Seeding runs `fetchHistory(symbol, timeframe)` + `generateSignals(bars, symbol, timeframe)`
- This ensures generated signal `barTime` values are actual timestamps in the chart's visible data

## Price validity check
After seeding, always verify signal `entry_price` range matches yfinance output for that timeframe. 
If prices seem off (e.g., 10× higher), check yfinance `auto_adjust=True` vs non-adjusted conflict.
Current NVDA split-adjusted 5m prices are ~$210–230 (May 2026).

## Duplicate signal prevention
WS loop must emit only `bar.partial` ticks — never call `analyzeAndEmit` in the interval.
If table has duplicates: `DELETE FROM signals WHERE id NOT IN (SELECT MIN(id) FROM signals GROUP BY symbol, timeframe, bar_time, side, entry_price);`

## yfinance intraday limits
- 5m: max 60 days history (free tier hard limit)
- 15m: max 60 days history
- 1h+: max history available
