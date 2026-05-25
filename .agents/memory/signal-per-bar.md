---
name: Signal engine per-bar analysis
description: Critical pattern for correct per-bar signal scoring in signals.ts
---

analyzeTrendMomentumVolatility returns arrays (ema20, ema50, ema200, atrValues, rsiValues).
In the signal loop, always destructure and index with `i`:

```ts
const { ema20, ema50, ema200, atrValues, rsiValues } = analyzeTrendMomentumVolatility(bars);
for (let i = startIdx; i < bars.length - 1; i++) {
  const e20i = ema20[i];
  const rsiI = rsiValues[i] ?? 50;
  // trend direction = bar.close > e20i && e20i > e50i  (NOT trend.direction which is last-bar only)
}
```

**Why:** The old code used `trend.direction` and `momentum.rsi` (last-bar scalars), causing every historical bar to be scored against today's indicator values — completely wrong signal placement.

**How to apply:** Any time you add indicator-based scoring in the signal loop, always reach for the array and index `[i]`, never the top-level scalar from the trend analysis return value.
