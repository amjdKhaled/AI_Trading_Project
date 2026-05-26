---
name: Sequential trade filter
description: How the one-active-trade rule is implemented and key operational constraints around it.
---

## Rule
After deduplication, signals.ts walks all candidates chronologically. Once a trade fires, `simulateLifecycle` finds the exit bar; no new entry is accepted until one bar after that exit. This is the `sequential` array pass.

**Why:** Prevents stacked entries on the same move — a realistic single-position constraint the user explicitly requested.

**How to apply:** The filter runs in `generateSignals()` after the 2-hour per-side dedup gap. It imports `simulateLifecycle` and `MAX_HOLD_BARS` from `./lifecycle`. Order matters: dedup → sequential → map to TradingSignal.

## Polygon fetch timeout
Set to **55 s** (`AbortSignal.timeout(55_000)`) in `polygon.ts`. On the free tier, a 9 k-bar 5m history fetch for 180 days can take 30–50 s. The previous 25 s timeout caused cold-cache regenerate to fail immediately after a server restart.

**How to apply:** Always curl regenerate with `--max-time 300` from the shell. Run both TSLA and NVDA sequentially with a 15 s gap between them to avoid 429s when the cache is cold (both need 5m + 15m = 4 Polygon calls total).

## Signal counts with all filters active
TSLA 5m: ~220, NVDA 5m: ~224 (down from ~500 before sequential filter). This is correct — the sequential filter cuts ~55% of candidates that would have overlapped open trades.
