---
name: Sequential trade filter + engine calibration
description: One-active-trade rule implementation, Polygon constraints, and current engine threshold calibration.
---

## Sequential One-Trade Rule
After deduplication, signals.ts walks all candidates chronologically. Once a trade fires, `simulateLifecycle` finds the exit bar; no new entry is accepted until one bar after that exit. This is the `sequential` array pass.

**Why:** Prevents stacked entries on the same move — a realistic single-position constraint.

**How to apply:** Filter runs in `generateSignals()` after the 2-hour per-side dedup gap. Order matters: dedup → sequential → map to TradingSignal. Imports `simulateLifecycle` and `MAX_HOLD_BARS` from `./lifecycle`.

## Polygon fetch timeout
Set to **55 s** (`AbortSignal.timeout(55_000)`) in `polygon.ts`. On the free tier, a 9 k-bar 5m history fetch for 180 days can take 30–50 s.

**How to apply:** Always curl regenerate with `--max-time 300` from the shell. Run TSLA then NVDA with a 15 s gap to avoid 429s on cold cache.

## Engine thresholds (current calibration)
- Score floor: **95** (was 92)
- Confluence pillars: **6 of 10** (was 5)
- SL lookback: **20 bars** (was 14), clamped to 0.8–2.2 ATR
- RVOL hard skip: **< 0.75** (below-average volume = no signal)
- RSI for longs: max score at 38–56, hard penalty -28 at RSI ≥ 70
- RSI for shorts: max score at 44–62, hard penalty -28 at RSI < 30
- Vertical move penalty: **-30** if 5-bar move > 2.5 ATR (chasing)
- EMA20 overextension penalty: **-18** if entry >1.8% from EMA20

## Signal counts + WR at current calibration
- TSLA 5m: ~90 signals / 180 days, **33.3% WR** (above 2.5R breakeven of ~29%)
- NVDA 5m: ~59 signals / 180 days, **20.8% WR** (HTF bars not loaded → HTF filter inactive)
- NVDA WR is lower partly because 15m HTF bars fail to load on cold-cache regenerate (429 rate limit); HTF alignment is a key quality filter.

## Win rate breakeven at 2.5R
At 2.5R reward:risk, breakeven WR = 1/(1+2.5) = **28.6%**. TSLA is above; NVDA needs either better HTF loading or further tightening.
