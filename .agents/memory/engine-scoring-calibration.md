---
name: Engine scoring calibration
description: Current hard gates, bonus/penalty values, and calibrated thresholds in signals.ts.
---

# Engine Scoring Calibration (current state)

## Hard gates (cause `continue` or signal rejection before scoring)
- `atrPct < 0.0005` → skip bar (illiquid / blended daily artefact)
- `efI < 0.12` → skip bar (ER hard skip — extreme chop only)
- `vol.rvol < 0.80` → skip bar (below 80% of 20-bar average volume = no conviction)
- `rsiI > 75` → skip **LONG** analysis (overbought; hard cap — −28 penalty alone insufficient on high-scoring bars)
- `rsiI < 25` → skip **SHORT** analysis (oversold; hard cap — same reason)
- `longRawRisk > atrI * 1.8` → reject long (SL too wide → TP too far → low probability)

## Long analysis entry gate (all must be true)
- `!strongDowntrend && htfI !== "bear" && rsiI <= 75`

## Signal acceptance gate (inside long block)
- `bullScore >= threshold` (regime-/session-adjusted floor)
- `longConfirms >= 6` (6 of 10 independent pillar confirmations)
- `bullScore >= 97` (hard score floor)
- `hasLongStrategy` (at least one identifiable institutional trigger)
- `!longBadRR` (raw risk ≤ 1.8 ATR)

## Score bonuses (long side; short is symmetric)
| Condition | Points |
|---|---|
| strongUptrend + atrStr > 40 | +26 |
| pullbackLong | +24 |
| pullbackLong + EMA20 distance < 0.5% | +8 (precision bonus) |
| vol.accumulation | +14 |
| pa.bullish | +14 |
| vwapReclaim | +14 |
| structBull | +10 |
| macdAccBull | +10 |
| htfI === "bull" | +12 (via pillar count + reasons) |
| sweepBull | +8 (supplemental only — not a gate trigger) |
| cleanER (efI > 0.50) | +8 |
| pullbackLong + pullbackVolOk | +7 |
| RSI 38–56 | +12 |
| regimeI === "trending-up" | +8 |

## Key score penalties (long side)
| Condition | Points |
|---|---|
| isExhBull | −28 |
| RSI ≥ 70 | −28 |
| RSI 63–70 | −14 |
| isVertBull (5-bar spike >2.5 ATR) | −30 |
| farAboveEma (>1.5% above EMA20) | −18 (tightened from 1.8%) |
| bearEmaAlign | −15 |
| fakeBreakoutBull | −20 |
| isDoji | −12 |
| belowVwap | −6 |
| weakER (efI < 0.17) | −6 |
| pullbackLong + !pullbackVolOk | −5 |

## Calibrated thresholds (do not tune without n ≥ 100 samples)
- RVOL floor: 0.80 (raised from 0.75)
- EMA20 distance max: 1.5% (tightened from 1.8%)
- RSI long cap: 75 (hard gate — not just penalty)
- RSI short floor: 25 (hard gate)
- ER hard skip: 0.12
- SL ATR buffer: 0.25 ATR below swing low
- SL max width: 1.8 ATR
- Score floor: 97
- Pillars required: 6 of 10
- Dedup gap: 7200 sec (120 min) per side — do NOT reduce; sequential filter is the real enforcer

**Why:** TSLA backtest 36.8% WR with n=19 at these thresholds. NVDA 16.7% WR is a macro-trend conflict issue (see nvda-macro-conflict.md), not a threshold issue.
