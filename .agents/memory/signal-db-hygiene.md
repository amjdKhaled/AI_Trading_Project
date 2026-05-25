---
name: Signal DB data hygiene
description: riskTag enum values, duplicate prevention, and WebSocket signal generation rules
---

## riskTag enum values
Valid values: `"Safe"` | `"Medium"` | `"Danger"`. The old analyzer emitted `"Dangerous"` — that value is invalid and will cause Zod 500 errors on the `/api/signals` route. If stale rows appear, run: `UPDATE signals SET risk_tag = 'Danger' WHERE risk_tag = 'Dangerous';`

**Why:** The Zod schema in `lib/api-zod` strictly validates the enum, so any unrecognized value throws at parse time and returns a 500 to the client.

## Duplicate signal prevention
The WebSocket bar-simulation loop must emit only `bar.partial` ticks — never call `analyzeAndEmit` inside the interval. Running the analysis engine on every 3-second tick against the same historical bars generates thousands of duplicate signals.

**How to apply:**
- Only seed signals from REST route (`/api/signals`) on first load (check `COUNT(*) = 0` before seeding).
- The WS handler in `websocket.ts` must contain no imports from the analyzer or DB — pure price simulation only.
- If the signals table accumulates duplicates, deduplicate with: `DELETE FROM signals WHERE id NOT IN (SELECT MIN(id) FROM signals GROUP BY symbol, timeframe, bar_time, side, entry_price);`
