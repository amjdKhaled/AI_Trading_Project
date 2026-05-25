---
name: Structure engine HH/HL/LH/LL bug
description: The alternating filter makes same-type comparisons impossible; fix with separate prevHigh/prevLow tracking
---

## The Bug

After building an alternating `[H, L, H, L, ...]` chain, the classifier loop checked `prev.type === curr.type`. In a properly alternating chain this is **never true**, so HH/HL/LH/LL are never emitted and `bosCount` stays 0.

## The Fix

Track `prevHigh` and `prevLow` separately:
```ts
let prevHigh: StructurePoint | null = null;
let prevLow:  StructurePoint | null = null;

for (const curr of filtered) {
  if (curr.type === "swing-high") {
    if (prevHigh) {
      curr.price > prevHigh.price → push HH, regime=uptrend, bosCount++
      curr.price <= prevHigh.price → push LH, regime=downtrend, chochCount++
    }
    prevHigh = curr;
  } else {
    if (prevLow) {
      curr.price > prevLow.price → push HL, regime=uptrend
      curr.price <= prevLow.price → push LL, regime=downtrend, bosCount++
    }
    prevLow = curr;
  }
}
```

**Why**: comparing a swing-high to the previous swing-low (adjacent in the alternating list) is meaningless; you must compare highs to highs and lows to lows.

**How to apply**: any time you refactor the structure engine, ensure the comparisons use `prevHigh`/`prevLow` trackers, not adjacent list elements.
