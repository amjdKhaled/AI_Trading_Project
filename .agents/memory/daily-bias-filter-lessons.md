---
name: Daily bias filter — implementation lessons
description: What we learned from building and testing the daily macro trend filter on TSLA/NVDA.
---

# Daily Bias Filter — Implementation Lessons

## What was built
`buildDailyBiasLookup(dailyBars)` in `signals.ts` — mirrors `buildHtfBiasLookup`.
- Classifies each daily bar: `close > EMA20 > EMA50` → bull; `close < EMA20 < EMA50` → bear; else neutral.
- Binary search for latest bar with `time <= lookupTs`.
- `dailyBars` fetched via `fetchHistory(symbol, "1d")` in the regenerate route.
- `dayBiasI = dailyBias(bar.time)` computed per 5m bar in the main loop.

## The timestamp problem (critical)
yfinance daily bars are timestamped at **midnight ET = 04:00 UTC** (summer, EDT).
The 5m bars are timestamped at market hours (9:30am ET = 13:30 UTC to 4pm ET = 20:00 UTC).

**Wrong offset (4h = 14400s):**
- Intraday bar at 9:30am (13:30 UTC) → lookupTs = 9:30 UTC
- Binary search finds today's daily bar (04:00 UTC ≤ 09:30 UTC) → LOOKAHEAD
- "Today's" bar reflects today's full close, which isn't known at 9:30am.

**Correct offset (17h = 61200s):**
- Intraday bar at 9:30am (13:30 UTC) → lookupTs = 20:30 UTC previous day
- Finds previous day's bar ✓
- Latest intraday bar (4pm ET = 20:00 UTC) → lookupTs = 03:00 UTC → finds previous day ✓
- Holds for any bar from market open to close.

**Why:** midnight-ET timestamps (04:00 UTC) mean any subtraction < 9.5h will find the current day's bar
for morning signals, and < 16h will find it for afternoon signals. 17h clears both.

## Why the filter hurt performance anyway
Even with the correct 17h offset, the filter degraded results:

**TSLA in the current 180-day window (Dec 2025 – May 2026) is in a BULL daily phase.**
- `dayBiasI === "bull"` for most bars → short penalty (−30) fired constantly
- Shorts were the profitable signals (37.5% WR) → filter eliminated them
- Longs (already failing at 17.6% WR) were unaffected → no improvement

The previous session notes said "TSLA macro downtrend" — that was a DIFFERENT backtest window
(probably late 2024 or early 2025). The 180-day rolling window captures current market conditions,
not a fixed historical period.

## Deeper insight: symmetric penalties are wrong
Intraday shorts can work regardless of daily trend (mean-reversion, overbought pullbacks).
The evidence base for "shorts fail in bull daily" doesn't exist in this dataset.
Only "longs fail in bear daily" had prior evidence — and even that disappears when the window rolls
to a bull period.

**Rule:** Never apply a daily-bias penalty symmetrically without per-direction win-rate evidence
collected from the actual backtest window in use.

## What remains in the code
- `buildDailyBiasLookup` function in `signals.ts` — kept, correct 17h offset
- `dailyBias` lookup built in `generateSignals` when `dailyBars` provided
- `dayBiasI` computed per bar — can be stored in metadata for analysis
- **No score penalties applied** — both penalty blocks removed, commented with rationale
- `dailyBars` fetched in regenerate route (try/catch, gracefully disabled if unavailable)

## Next steps if daily filter is revisited
1. Collect `dayBiasI` in signal metadata over several regenerations
2. Query WR by dayBiasI × side (e.g., shorts in bull daily vs bear daily)
3. Only apply a penalty if there is a statistically significant WR difference (>8pp) with n>30
4. Consider WEEKLY bias instead of daily (less noisy, more robust)
5. Never penalize BOTH sides symmetrically — the two directions have different behaviour
