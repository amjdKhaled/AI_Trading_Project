---
name: WR measurement limits
description: Why WR comparisons below n=100 signals are statistical noise.
---

# WR Measurement Limits

## The problem
With the sequential one-trade filter and ~9,000 5m bars (≈6 months), the engine generates
only 20–30 signals per symbol. The 95% Wilson confidence interval for these sample sizes is:

| n | WR | CI lower | CI upper |
|---|---|---|---|
| 27 | 25.9% | ~12% | ~45% |
| 30 | 30.0% | ~14% | ~50% |
| 90 | 33.3% | ~24% | ~44% |

A measured difference of 33% → 26% with n=27 vs n=90 gives Z≈0.35, p≈0.73.
**Not statistically significant.**

## Practical implications
- Never make engine decisions based on WR changes of <10 percentage points when n<50
- A "WR drop" from 33% to 26% across different engine versions is likely noise
- Need n≥100 signals for 10-point differences to be significant (Z>2, p<0.05)

## How to get n≥100
- Run more symbols (add SPY, AAPL, META, AMZN)
- Use 2+ years of history instead of 6 months
- Slightly relax the sequential filter (allow overlapping trades for backtesting only)

**Why:** This session wasted several iterations tuning score modifiers by ±2 points based on
WR comparisons that were entirely within noise. The engine appeared to move between 25–30%
WR but this was random variation, not engine improvement.
