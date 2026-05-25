---
name: Trading signals chart markers
description: SVG overlay approach, coordinate system, bounds checking, LuxAlgo-style design
---

## Rule
Use an SVG overlay (`absolute inset-0`, `zIndex:10`, `overflow: hidden`) rendered as React JSX on top of the LightweightCharts canvas. Never mutate the DOM directly or use chart marker APIs for custom shapes.

**Why:** LightweightCharts v4 `setMarkers()` only supports tiny built-in shapes. SVG overlay gives full control over arrow geometry, glow filters, confidence labels, and SL/TP dashed lines.

## Coordinate mapping
- `computeMarkers(signals)` converts signal barTime → nearest bar in current chart data → pixel coords
- Use `barsRef` (synced via `barsRef.current = bars` at render time) so `computeMarkers` stays a stable `useCallback` with no deps
- Nearest-bar lookup: `Math.abs(b.time - sigSec)` across all bars — critical for cross-timeframe signal display
- LONG anchor: `series.priceToCoordinate(nearestBar.low)` + 5px offset (below candle)
- SHORT anchor: `series.priceToCoordinate(nearestBar.high)` - 5px offset (above candle)

## Bounds checking (REQUIRED)
```
const maxX = container.offsetWidth - 68;   // exclude right price scale
const maxY = container.offsetHeight * 0.72; // exclude volume pane (bottom 28%)
```
Skip any marker where `x === null || x < 0 || x > maxX` or `y === null || y < 0 || y > maxY`.
Also set SVG `overflow: hidden` — never `overflow: visible`.

## LuxAlgo-style markers
- LONG (teal `#26a69a`): upward triangle, tip at `(x, y-13)`, base at `(x±9, y+2)`
- SHORT (red `#ef5350`): downward triangle, tip at `(x, y+13)`, base at `(x±9, y-2)`
- SVG `<filter>` with `feGaussianBlur + feColorMatrix` for color-matched glow
- Confidence % label below/above the triangle

## SL/TP lines — ONLY MOST RECENT
Track `activeSLRef` and `activeTPRef` (single pair). Compare `activeSignals[0].signalId` vs `lastSigIdRef` — only remove+recreate when the signal actually changes. Clear both refs in cleanup and on `bars` reload.

## computeMarkers call triggers
1. After `setData` + range set: `setTimeout(80ms)`
2. When `activeSignals` changes
3. From `subscribeVisibleLogicalRangeChange` — essential for pan/zoom correctness
