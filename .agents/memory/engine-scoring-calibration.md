---
name: Engine scoring calibration
description: Current bonus/penalty values in signals.ts and the reasoning behind them.
---

# Engine Scoring Calibration

## Hard gates (cause `continue` or signal rejection)
- `efI < 0.12` → skip bar (extreme chop only; 5m bars normally sit 0.15–0.35)
- `atrPct < 0.0005` → skip bar (illiquid / blended artefact)
- `bullScore < 97` → no signal
- `longConfirms < 6` → no signal (out of 10 possible pillars)
- `!hasLongStrategy` → no signal (must have at least one identifiable trigger)
- `longBadRR` → no signal (raw risk > 1.8 ATR)

## Score bonuses (long side; short is symmetric)
| Condition | Points |
|---|---|
| pullbackLong | +24 |
| pullbackLong + EMA20 distance < 0.5% | +8 |
| sweepBull | +8 (supplemental — enhances, doesn't gate) |
| cleanER (efI > 0.50) | +8 |
| pullbackLong + pullbackVolOk | +7 |
| HTF aligned (htfI === "bull") | +12 (via confirmations count) |

## Score penalties (long side)
| Condition | Points |
|---|---|
| weakER (efI < 0.17) | −6 |
| pullbackLong + !pullbackVolOk | −5 |
| RSI ≥ 70 on long | large negative (RSI gate) |

## What NOT to do
- Do not tune bonus/penalty values based on WR from n<100 samples — the CI is ±15–20%
- Do not raise the sweep bonus above +8 without validating on 100+ swept signals; the +22 value caused 12.5% WR sweeps to pass the threshold
- Do not remove the ER hard skip (0.12) — it raises signal count to 70+ without improving WR

**Why:** These values were arrived at through multiple calibration iterations on TSLA/NVDA free-tier Polygon data. The score threshold of 97 was raised from 95 in a prior session to improve selectivity.
