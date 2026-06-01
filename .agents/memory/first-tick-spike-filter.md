---
name: First-tick spike filter gap
description: CSM spike filter rejects first live tick when price gaps from stale historical close — fix is 5% threshold for first tick only.
---

## Rule
CandleStateManager's spike filter MUST use a looser threshold for the very first live tick (when `this.liveBar === null`).

**Why:** `refPrice` falls back to `getLastHistoricalClose()` when no live bar exists. That close is the last historical bar — often yesterday's close or end-of-extended-hours. A normal day gap (e.g. NVDA +5%, TSLA -3.7%) exceeds the ATR×5 or 2% intra-bar threshold, silently killing the entire live feed for the session.

**How to apply:** In `ingestTick`, branch on `isFirstTick = this.liveBar === null`:
```typescript
const isFirstTick = this.liveBar === null;
const maxDelta = isFirstTick
  ? refPrice * 0.05          // 5% — handles day gaps, AH opens
  : (atr > 0 ? Math.max(atr * 5, refPrice * 0.02) : refPrice * 0.01);
```

5% is the empirically observed worst-case (NVDA gap was 5.02%). If gaps wider than 5% appear (e.g. earnings surprises, halts), raise to 8–10%. Do NOT raise subsequent-tick threshold — that would admit genuine spikes.
