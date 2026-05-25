---
name: Signal engine design
description: Regime filter, pullback bonus, confirmation gate, and the loop-body continue bug
---

## Rules

**Regime filter**: never use `continue` to skip an entire bar — it also blocks the opposite side.
Use independent conditional blocks:
```ts
if (!strongDowntrend) { /* LONG analysis */ }
if (!strongUptrend)   { /* SHORT analysis */ }
```

**Pullback entry bonus (+24)**: best long = price touches EMA20 from above in uptrend.
`pullbackLong = strongUptrend && bar.low <= e20i*1.003 && bar.close >= e20i*0.996 && bar.close > bar.open`

**Minimum 3 of 8 confirmations**: structure, EMA align, volume, RSI zone, candle direction, MACD, pullback/breakout, candle pattern.

**Threshold**: 82 for A grade, 100 for A+ (score can exceed 100 when many factors align).

**Deduplication**: separate sets per side (long/short); min gap = 12 bars (5m) or 8 bars (15m).

**Descriptive trigger names**: when no candlestick pattern fires, `buildTriggerName()` returns a readable label (e.g. "EMA20 Pullback", "Breakout Candle", "Momentum Short") so the DB `pattern` column is never "analysis_engine".

**Why**: regime-unaware engines generate alternating LONG/SHORT noise in trending markets; users interpret this as random entries even though each signal scored high independently.

**How to apply**: always check `strongDowntrend`/`strongUptrend` using per-bar EMA arrays (not global trend state), and keep the two scoring blocks completely independent so a downtrend bar can still generate a SHORT signal.
