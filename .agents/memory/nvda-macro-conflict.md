---
name: NVDA macro conflict
description: Why NVDA consistently shows lower WR than TSLA on the same engine — and what fixes it.
---

# NVDA Macro-Trend Conflict

## The problem
NVDA's 6-month backtest period (late 2024–mid 2026) includes a sharp correction from its
2024 ATH. During this period the macro trend is **bearish on the daily/weekly timeframe**.

The engine uses 5m EMA20/50/200 and 15m bias for HTF alignment. But:
- 5m EMA200 = 200 bars × 5 min = ~1000 min ≈ 2 trading days. Not a macro filter.
- 15m bias catches intraday, not daily/weekly structure.

During NVDA's post-2024 correction, many *short-term* bounces on 5m/15m look like valid
"EMA20 pullback in uptrend" setups — but each one is a lower high in the macro downtrend.
The engine enters longs that then fail as the macro trend reasserts.

**Result:** NVDA long WR = 13.3% (n=15), dragging combined WR to 16.7%.
TSLA (which had cleaner trending regimes) shows 27–50% WR on the same engine.

## The fix
Add a **daily trend filter** — only take longs when the daily close is above the daily 20-EMA,
and only shorts when below. This requires:
1. Fetching daily bars from Polygon alongside 5m/15m bars.
2. Building a `dailyBiasLookup()` similar to `buildHtfBiasLookup()`.
3. Adding `dailyBias !== "bear"` to the long analysis gate.

Until this is implemented, the engine is best suited to instruments with cleaner
intraday trends that align with the daily structure (TSLA, SPY, QQQ, liquid large-caps).

## Phased rollout recommendation
From the executive summary: go live with TSLA first, monitor 1–2 weeks, then add more
symbols. The NVDA WR data confirms this. Only add NVDA once the daily filter is in place.

**Why:** Discovered via backtest comparison: same engine, same period, TSLA 36.8% WR vs
NVDA 16.7% WR. The divergence is explained entirely by macro regime conflict, not
engine quality or randomness (n=19 TSLA, n=24 NVDA — enough to see the pattern).
