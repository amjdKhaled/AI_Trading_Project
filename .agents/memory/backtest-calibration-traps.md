---
name: Backtest calibration traps
description: Changes that hurt signal quality and the lessons learned from the balanced-aggressive refactor.
---

# Backtest Calibration Traps

## ATR-relative pullback detection
**Problem:** Changed `bar.low <= e20i * 1.003` (within 0.3% of EMA20) to
`bar.low <= e20i + atrI * pullbackAtrTol` (within 0.45 ATR = ~0.9%).
This is 3× wider — catches bars that are NOT near EMA20, just within a
wider absolute range. Signal count exploded from 19 → 45, WR dropped to 24%.

**Fix:** Reverted to percentage-based with tiny profile additive:
`pbTol = 1.003 + profile.pullbackAtrTol * 0.002` → TSLA ~0.39%, NVDA ~0.42%.

**Why:** Percentage-based is the right model for "price is near EMA20."
ATR distance measures "price range" not "EMA proximity."

## ATR-relative EMA overextension
**Problem:** Changed `ema20Dist > 0.015` to `ema20AtrDist > 2.2`.
For TSLA (ATR ~2%): 2.2 ATR = 4.4% vs old 1.5% limit → 3× wider.
Many overextended bars stopped getting the −18 penalty.

**Fix:** Regime-aware fixed percentages:
`emaDistLim = strongUptrend ? 0.025 : 0.015`
Strong trends: 2.5% limit (wider but controlled). Chop: 1.5% (tight).

**Why:** EMA overextension is about % deviation from fair value (EMA), not ATR.
The two measures are independent. A 3% deviation in a low-ATR stock is very
extended; in a high-ATR stock it might still be close to EMA in ATR terms.

## 30-min dedup gap
**Problem:** Changed 120-min to 30-min dedup. Result: 4× more candidate windows
per session, each selecting a lower-quality "best" from a narrow window.
Signal count: 19 → 44–45, WR: 36.8% → 25%.

**Fix:** 60-min dedup. Halves the old restriction (2× more signals) while still
selecting the best signal per meaningful time window.

**Why:** Dedup functions as a "session segment" filter — pick the best signal in
each major market phase. 30 min is too short to have a meaningful "phase."

## Score threshold floor
**Problem:** Removing the hardcoded 97 floor and using adaptive threshold (84 in
trending) opened too many marginal setups. WR dropped to 20–23%.

**Fix:** Calibrate base to 93; trending = 90 (-3). This allows meaningful
relaxation from 97 while keeping quality high.

**Rule:** Every 3-point drop in threshold approximately doubles candidates;
WR drops ~4–5 points per 3-point threshold reduction in this backtest period.
Do not go below 88 in trending without n>100 forward-test data.

## The macro bias issue (most important)
Even perfect threshold calibration cannot overcome macro regime mismatch.
In a 6-month bearish period for TSLA/NVDA:
- Longs: 20% WR (losing)
- Shorts: 30% WR (winning)
The fix is a **daily bias filter**, not threshold tuning. See nvda-macro-conflict.md.
