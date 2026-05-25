---
name: Trading signals chart markers
description: How signal arrows are rendered on LightweightCharts — SVG overlay approach and coordinate timing quirks
---

## Rule
Use an SVG overlay (absolute-positioned, `zIndex:10`) rendered as React JSX on top of the LightweightCharts canvas. Never mutate the DOM directly or use `chart.addCustomSeries()` for this.

**Why:** LightweightCharts v4 does not expose a public API to render arbitrary SVG shapes on the canvas. The `setMarkers()` API only supports built-in tiny shapes. Custom SVG overlays give full control over arrow geometry, confidence labels, and dashed SL lines.

**How to apply:**
- `computeMarkers()` converts signal bar timestamps → pixel coords via `chart.timeScale().timeToCoordinate(t)` + `series.priceToCoordinate(price)`.
- Call `computeMarkers` on three triggers: (1) after `series.setData()` + `setVisibleLogicalRange` via `setTimeout(60ms)`, (2) when `activeSignals` changes, (3) from `subscribeVisibleLogicalRangeChange` — essential for pan/zoom.
- The first call (before range is set) returns `y=0` for all signals; the second call (after range-change fires) has correct coordinates — this is expected.
- SL lines use `LineSeries` with `lineStyle: 2` (dashed), `priceScaleId: "right"`, tracked by `renderedSignalsRef` to avoid re-adding on every render.
- Yahoo Finance 1d bars use `04:00:00 UTC` timestamp offset — signal `barTime` must match exactly for `timeToCoordinate` to resolve.
