---
name: Trade Intelligence Engine architecture
description: Two-engine candle-close AI pipeline — deterministic market context + Ollama decision; key API signatures and hard rule enforcement.
---

## Architecture

**Market Analysis Engine** (`lib/ai/market-context.ts`) — pure deterministic math, synchronous:
- `buildMarketContext(bars, htfBars, htfTF, symbol, tf, candleTime, news)` → `MarketContext`
- `findSimilarHistoricalSetups(symbol, regime, rsi14, patterns)` → `Promise<HistoricalSetupStats>`

**Trade Intelligence Engine** (`lib/ai/filter.ts`) — Ollama reads full context, decides:
- `filterCandleWithAi(ctx: MarketContext, stats: HistoricalSetupStats)` → `Promise<AiCandleDecision>`

Route (`routes/signals.ts`): `buildMarketContext` → `findSimilarHistoricalSetups` → `filterCandleWithAi`.
No `generateSignals` call in the candle-decision endpoint.

## Hard rules (enforced after Ollama response)
1. R:R < 2.0 → WAIT
2. LONG within 0.5% of nearest resistance → WAIT
3. SHORT within 0.5% of nearest support → WAIT
4. confidence ≥ 80 → APPROVE | 65–79 → WAIT | < 65 → REJECT
5. Ollama offline or parse error → WAIT

## AiCandleDecision fields added
- `strengths: string[]`
- `weaknesses: string[]`
- `marketBias: "bullish" | "bearish" | "neutral"`
Stored inside `technicalContext` JSONB (no schema migration needed).

## Chart display
- WAIT markers are **hidden** from the chart (filtered in `computeDecisionMarkers`)
- Only APPROVE (▲/▼) and REJECT (×) markers are shown
- Popup shows: marketBias, strengths (green), weaknesses (red), patterns, news, AI reasoning

## Analyzer API signatures (critical)
- `detectAllPatterns(bars: OhlcvBar[])` — 1 arg only (no index). Filter by `p.index >= n - 3` for recent patterns.
- `detectOrderBlocks(bars, i)` → `OBResult { bullishOB, bearishOB, inBullishOB, inBearishOB }`
- `detectFVGs(bars, i)` → `FVGResult { bullishFVG, bearishFVG, inBullishFVG, inBearishFVG }`
- `classifyRegimes(bars, ema20[], ema50[], ema200[], atrValues[])` → requires full arrays, not last value

**Why:** Architectural separation keeps the scoring model clean. Ollama is the *only* LONG/SHORT/WAIT decision-maker; hard rules are server-side safety rails, not AI inputs.
