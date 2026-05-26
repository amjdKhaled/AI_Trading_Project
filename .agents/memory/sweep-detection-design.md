---
name: Sweep detection design
description: Why liquidity sweep detection is hard and what the current implementation actually detects.
---

# Sweep Detection Design

## What a genuine liquidity sweep is
Smart money (institutions) deliberately spikes price below a significant swing low to trigger
retail stop-losses, then reverses sharply. The key word is **significant** — the level must
be one where many traders have stops (prior session low, daily swing low, weekly range extreme).

## What the current implementation detects
```
sweepBull = bar.low < swingLow15 - atrI * 0.25
         && bar.close > swingLow15
         && bar.close > bar.open
         && closeInRange > 0.60
         && vol.rvol > 1.2
```
`swingLow15` = minimum low over the last **15 bars** = 75 minutes.

**This is NOT a significant level.** A 75-minute swing low has almost no stops clustered
at it. The engine is detecting ordinary wick rejections at recent intraday lows.

## Why the old +22 bonus was harmful
The +22 bonus pushed these false sweeps above the 97-score threshold. Result: 8 "sweep"
signals with 12.5% WR in backtesting — the bonus was rewarding ordinary wicks as if they
were institutional stop hunts.

## Current design (after calibration)
- Sweep bonus reduced to +8 (supplemental enhancement, not a trigger)
- Sweep NOT in `hasLongStrategy` gate (a sweep alone cannot trigger a signal)
- ATR-scaled breach required (0.25 ATR, not 0.02%) + volume > 1.2× average
- Sweep still appears in `metadata.strategy` tag for future analysis

## What proper sweep detection would need
- **Daily swing lows** (not 15-bar lookback) — the prior day's low, week's low
- **Significant test count** — levels hit 2–3+ times previously carry more stops
- **Time context** — sweeps near market open or key session times are more meaningful
- **Engulfing confirmation** — the sweep bar should engulf prior bars, not just have a wick

**Why:** Until proper level identification is implemented, sweeps should be logged in
metadata but should NOT score above pullback setups. The +8 bonus is a placeholder.
