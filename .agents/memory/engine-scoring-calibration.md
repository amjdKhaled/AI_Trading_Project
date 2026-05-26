---
name: Engine scoring calibration
description: Current hard gates, bonus/penalty values, and calibrated thresholds in signals.ts — balanced-aggressive version.
---

# Engine Scoring Calibration (balanced-aggressive, current state)

## Hard gates (cause `continue` before scoring)
- `atrPct < 0.0005` → skip bar (illiquid / blended daily artefact)
- `efI < 0.12` → skip bar (ER hard skip — extreme chop only)
- `vol.rvol < 0.55` → skip bar (hard reject — essentially no participation)
- `longRawRisk > atrI * 1.8 * profile.slAtrMult` → reject long (SL too wide)

## Long analysis entry gate (all must be true)
- `!strongDowntrend && htfI !== "bear"` (RSI cap removed — handled via adaptive scoring)

## Signal acceptance gate (inside long block)
- `bullScore >= threshold` (regime-/session-adjusted, no separate hardcoded floor)
- `longConfirms >= minPillars` (regime-adaptive: 5 trending, 6 chop)
- `hasLongStrategy` (at least one identifiable entry trigger)
- `!longBadRR` (raw risk ≤ 1.8 ATR × profile.slAtrMult)

## Regime-adaptive thresholds (scoreThreshold function)
| Regime | Base | Session adjustments |
|---|---|---|
| trending-up/down | 90 | open -3, midday +5, power-hour -2 |
| vol-expansion | 86 | same |
| ranging | 93 | same |
| chop | 97 | same |

## Adaptive confluence pillars (minConfluencePillars function)
| Regime | Min Pillars |
|---|---|
| trending-up/down | 5 |
| vol-expansion | 4 |
| ranging | 5 |
| chop | 6 |

## Deduplication gap
- 5m timeframe: 12 bars = 60 min (was 24 bars = 120 min)
- 15m timeframe: 4 bars = 60 min
- 60 min allows ~2× more signals vs old strict settings; re-entry after TP enabled via sequential filter

## RVOL handling
- Hard skip: < 0.55 (was 0.80)
- Soft penalty: below 0.80: `score -= (0.80 - rvol) * 35` (proportional)

## RSI handling (trend-aware, NO hard cap)
- `momentumLong = strongUptrend && (accumulation || breakoutVol || rvol > 1.5)`
- If momentumLong: RSI 40-72 = +12, 72-82 = +4, 82-90 = -8, >90 = -18 (continuation mode)
- Normal: RSI 38-56 = +12, 63-70 = -14, ≥70 = -28 (original discipline)

## EMA distance (regime-aware, not ATR-relative)
- `emaDistLim = (strongUptrend || strongDowntrend) ? 0.025 : 0.015`
- 2.5% in strong trends (was fixed 1.5%) — allows wider momentum extension

## Vertical move penalty (volume-qualified)
- `if (isVertBull) bullScore -= (vol.rvol > 1.5 ? 8 : 22)`
- High-volume verticals = institutional continuation (small penalty only)

## Pullback detection
- `pbTol = 1.003 + profile.pullbackAtrTol * 0.002`
- TSLA: ~0.39% above EMA20, NVDA: ~0.42% (slightly wider for higher-vol)

## Symbol profiles
```ts
TSLA: { slAtrMult: 1.0, momentumBonus: 0, pullbackAtrTol: 0.45 }
NVDA: { slAtrMult: 1.1, momentumBonus: 5, pullbackAtrTol: 0.60 }
SPY:  { slAtrMult: 0.9, momentumBonus: 0, pullbackAtrTol: 0.35 }
QQQ:  { slAtrMult: 0.9, momentumBonus: 0, pullbackAtrTol: 0.35 }
```

## Backtest results (balanced-aggressive settings, 6-month period)
| Symbol | Signals | WR | Notes |
|---|---|---|---|
| TSLA | 44 | 25% | shorts 30% A+ WR, longs 20% |
| NVDA | 54 | 24% | macro downtrend conflict |

## Critical calibration finding
Both TSLA and NVDA spent much of the backtest period in macro downtrends.
- Shorts (A+): 30% WR → ABOVE breakeven at 2.5R
- Longs (A+): 20% WR → BELOW breakeven
- Long A+ in trending-up/regular session: 0% WR (n=6) — bear rallies, not uptrends

**Root cause**: No daily/weekly trend filter. The daily trend filter is the single most
impactful improvement remaining (see nvda-macro-conflict.md).

**Recommendation**: Forward-test at these settings. Backtest n<50 has ±15% WR CI;
cannot meaningfully differentiate settings within that range. Add SPY/QQQ (less
directional bias) to see higher signal quality.
