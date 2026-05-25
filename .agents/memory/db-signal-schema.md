---
name: DB signal pattern column
description: The DB stores a single pattern string, not an array; route maps patterns[0] with a descriptive fallback
---

## Schema

`lib/db/src/schema/signals.ts`: `pattern: text("pattern")` — singular.

The Zod response `ListSignalsResponseItem` has `pattern?: string | null`.

## Pattern Flow

1. `generateSignals()` returns `TradingSignal.patterns: string[]` (array)
2. Route inserts: `pattern: sig.patterns[0] ?? "analysis_engine"`
3. Frontend reads `signal.pattern` (singular) for the display label

## Rule

Always provide a descriptive fallback so `pattern` is never "analysis_engine". Use `buildTriggerName()` to generate a label from the scoring factors that fired (pullback, breakout, EMA alignment, etc.) when no candlestick pattern matched.

**Why**: "analysis_engine" is meaningless to users; "EMA20 Pullback" or "Breakout Candle" explains why the signal fired.
