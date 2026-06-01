---
name: First-tick spike filter gap
description: CSM spike filter must be bypassed entirely on first live tick — any gap size is legitimate when seeding from a stale historical close.
---

## Rule
CandleStateManager's spike filter MUST be **skipped entirely** for the very first live tick (when `this.liveBar === null`).

**Why:** `refPrice` falls back to `getLastHistoricalClose()` when no live bar exists. That close is yesterday's or end-of-extended-hours. A normal day gap (NVDA +5.06%, TSLA -3.7%) exceeds the ATR×5 or 2% intra-bar threshold, silently killing the entire live feed for the session. A 5% cap was tried and still blocked NVDA's 5.06% gap. Any hard percentage fails for earnings surprises (10–20%+ moves are real).

**How to apply:** In `ingestTick`, only apply the spike filter when a live bar already exists:
```typescript
const isFirstTick = this.liveBar === null;
if (!isFirstTick) {
  const maxDelta = atr > 0
    ? Math.max(atr * 5, refPrice * 0.02)
    : refPrice * 0.01;
  if (Math.abs(price - refPrice) > maxDelta) { this.reject("spike_filtered"); return; }
}
```

Do NOT apply any threshold on first tick — the very purpose is to seed the live bar, and the stale historical close is not a valid comparison point.
