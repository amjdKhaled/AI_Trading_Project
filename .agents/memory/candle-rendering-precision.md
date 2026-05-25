---
name: Candle rendering precision (lightweight-charts)
description: Settings that prevent low-volatility/consolidation candles from rendering as horizontal dashes in lightweight-charts.
---

## The rule
On the candle series, always set:
- `priceFormat: { type: "price", precision: 2, minMove: 0.01 }` for equities
- `borderVisible: true`, `wickVisible: true` explicitly
- An `autoscaleInfoProvider` that floors the visible price span at ~0.25% of mid-price (or an asset-appropriate minimum)

## Why
Without explicit `priceFormat.minMove`, lightweight-charts auto-detects precision and can quantize tiny intraday moves (a few cents on a $200 stock) so that open/close land on the same pixel row — the body collapses to a horizontal line that looks like a broken/giant-but-thin candle.

The autoscale provider is needed because when the visible window contains *both* wide-range bars and a tight consolidation, the global autoscale fits the wide bars and the consolidation gets ~3 vertical pixels of total range — bodies and wicks both collapse.

## How to apply
- Define on the candle series at construction; do not mutate later
- `autoscaleInfoProvider` receives `original: () => AutoscaleInfo | null` — call it, then widen `priceRange` if `(maxValue - minValue) < minSpan`. Distribute padding symmetrically.
- For equities use `minSpan = max(mid * 0.0025, 0.1)`. For crypto with much higher prices or different volatility, recalibrate.
- Type the callback parameter explicitly (`AutoscaleInfo | null`) — implicit `any` will fail strict TS.
