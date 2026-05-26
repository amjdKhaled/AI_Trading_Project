---
name: Engine scoring calibration
description: Current hard gates, bonus/penalty values, and calibrated thresholds in signals.ts — aggressive-smart v3.
---

# Engine Scoring Calibration (aggressive-smart v3, current state)

## Hard gates (cause `continue` before scoring)
- `atrPct < 0.0005` → skip bar (illiquid / blended daily artefact)
- `efI < 0.12` → skip bar (ER hard skip — extreme chop only)
- `vol.rvol < 0.55` → skip bar (hard reject — essentially no participation)
- `longRawRisk > atrI * 1.8 * profile.slAtrMult` → reject long (SL too wide)

## Regime-adaptive thresholds (scoreThreshold function)
| Regime | Score | Session adjustments |
|---|---|---|
| trending-up/down | 87 (base 91 − 4) | open −3, midday +4, power-hour −2 |
| vol-expansion | 83 (base 91 − 8) | same |
| ranging | 93 (base 91 + 2) | same |
| chop | 97 (base 91 + 6) | same |

## Adaptive confluence pillars (minConfluencePillars function)
| Regime | Min Pillars |
|---|---|
| trending-up/down | 4 |
| vol-expansion | 4 |
| ranging | 5 |
| chop | 6 |

## Deduplication gap
- 5m timeframe: 12 bars = 60 min
- 15m timeframe: 4 bars = 60 min

## RVOL handling
- Hard skip: < 0.55
- Soft penalty below 0.80: `score -= (0.80 - rvol) * 35`

## RSI handling (trend-aware, NO hard cap)
**Momentum mode** (strongUptrend + vol.accumulation/breakoutVol/rvol>1.5):
- RSI 40–72: +12, 30–40: +7, 72–82: +4, 82–90: −8, >90: −18, <30: −6

**Normal mode** (softened from original):
- RSI 38–56: +12, 30–38: +7, 56–63: +4, <30: −6
- RSI 63–70: −10 (was −14), 70–78: −20 (was −28), >78: −30

## Exhaustion flags (raised bar — less blocking)
- `isExhBull = rsiI > 85 && atrStr > 65` (was rsiI>80 && atrStr>55)
- `isExhBear = rsiI < 15 && atrStr > 65` (was rsiI<20 && atrStr>55)

## EMA overextension (ATR-relative)
```ts
const ema20AtrDist = Math.abs(bar.close - e20i) / atrI;
const extLimit     = (strongUptrend || strongDowntrend) ? 1.8 : 1.0;
const farAboveEma  = ema20AtrDist > extLimit && bar.close > e20i;
```
Strong trends: 1.8 ATR limit. Range/chop: 1.0 ATR limit.

## Pullback detection (ATR-relative)
```ts
// TSLA pullbackAtrTol=0.45: within 0.45 ATR above EMA20
const pullbackLong = strongUptrend
  && bar.low  <= e20i + atrI * profile.pullbackAtrTol
  && bar.close >= e20i - atrI * 0.2 && bar.close > bar.open;
```

## New continuation patterns (v3)
- **EMA Reclaim** (bull): `closePrev < e20i && bar.close > e20i*1.001 && bullish close` → +18 score
- **Higher Low** (bull): in uptrend, `bar.low > priorSwingLow(5) && bullish close` → +10 score
- **EMA Rejection** (bear): mirror of reclaim → +18
- **Lower High** (bear): mirror of higher low → +10
All four added to `hasLongStrategy` / `hasShortStrategy` gates.

## Vertical move penalty (volume-qualified)
- `if (isVertBull) bullScore -= (vol.rvol > 1.5 ? 8 : 22)`

## Symbol profiles
```ts
TSLA: { slAtrMult: 1.0, momentumBonus: 0, pullbackAtrTol: 0.45 }
NVDA: { slAtrMult: 1.1, momentumBonus: 5, pullbackAtrTol: 0.60 } // 0.60 ATR = ~1.3% at NVDA prices
SPY:  { slAtrMult: 0.9, momentumBonus: 0, pullbackAtrTol: 0.35 }
QQQ:  { slAtrMult: 0.9, momentumBonus: 0, pullbackAtrTol: 0.35 }
```

## Backtest results across engine versions
| Version | TSLA signals | TSLA WR | NVDA signals | NVDA WR | Notes |
|---|---|---|---|---|---|
| Strict (97/6/RSI-cap/RVOL-0.80/120min) | 19 | 36.8% | 24 | 25% | Positive EV |
| v1 balanced (90/5/RVOL-0.55/60min) | 44 | 25% | 54 | 24% | Negative EV |
| v3 aggressive-smart (87/4/ATR-rel/60min) | 35 | 28.6% | 46 | 20.5% | TSLA ≈ breakeven |
| v3 + dedup/session tuning (current) | 41 | 29.3% | 43 | 19.5% | TSLA +EV shorts, NVDA −EV |

## Key structural finding (confirmed across all versions)
- TSLA shorts: consistently 37–42% WR (above breakeven, positive EV)
- TSLA longs: consistently 6–23% WR (below breakeven) — persists regardless of intraday setup quality
- NVDA: consistently negative or barely-breakeven EV
- The current 180-day backtest window (approx Dec 2025 – May 2026) covers a TSLA bull phase
- NVDA htfBars=0 in most regenerations due to Polygon rate limit hitting after TSLA 15m fetch
  → when htfBars load for NVDA (53 signals, 24% WR), results are meaningfully better

## Daily bias filter — tested and reverted
See `daily-bias-filter-lessons.md` for full details.
Short summary: symmetric ±30 penalty tested with both 4h and 17h timestamp offsets.
4h offset = full lookahead (wrong). 17h offset = correct (previous day's close).
Even with correct offset, penalties hurt performance because TSLA daily is BULL in current window
→ short penalty eliminates profitable intraday mean-reversion shorts.
Infrastructure kept in code (`buildDailyBiasLookup`, `dayBiasI`) but no penalties applied.
