---
name: Live candle memory injection
description: Key decisions and pitfalls for wiring AI memory into filterCandleWithAi
---

# Live candle memory injection

**Rule:** `filterCandleWithAi` must call `buildCandleMemoryContext` before the Ollama call, then pass `mem.text` as `memBlock` to `buildMarketContextPrompt`. Skipping this means every live decision runs with no memory context.

**Why:** The original code had `buildCandleMemoryContext` only in the replay path (`runCandlePassForReplay`). The live path (`filterCandleWithAi`) never called it — the `memBlock` param was always `undefined`.

**How to apply:** Any future refactor of `filterCandleWithAi` must preserve:
1. `buildCandleMemoryContext(ctx)` called before `ollamaGenerateWithFallback`
2. `mem.memoryUsed ? mem.text : undefined` passed as `memBlock`
3. Memory diagnostics spread onto every return path

## Prompt section labels (required)

The memory block text must use these exact section headers so the LLM recognises them:
- `SIMILAR PAST SETUPS (same symbol + regime):`
- `MEMORY LESSONS (all symbols, newest first):`
- `WINNER ANALYSIS:` and `LOSER ANALYSIS:` (separate — split from `getWinnerLoserSummary` output)
- `FAILURE CATEGORIES:`
- `MOST RECENT LOSS:`

`getWinnerLoserSummary` returns lines joined by `"\n  "`. Lines starting with "Winners" → WINNER ANALYSIS; starting with "Top loss" → LOSER ANALYSIS.

## Memory Impact Score with divergence

`computeMemoryImpactScore(mem, diverged?)`:
- Base score: lessons×10 (max 60) + winner (15) + failure (15) + loss (10) = max 100
- `diverged=true` adds +10 bonus: AI direction opposed the deterministic `computeTechnicalBias` (EMA200/MACD/RSI proxy)
- `computeTechnicalBias`: bullish if price > EMA200 && macdHist > 0 && rsi < 70; bearish if opposite
- Use `mkMemDiag(diverged)` helper inside `filterCandleWithAi` — divergence only known after Ollama response parsed

## Per-decision diagnostics UI

- `GET /api/signals/ai-recent-decisions?symbol=X&limit=N` — returns last N decisions with memory fields from `technicalContext`
- `AiDecisionStatsCard` (AiMemoryPage.tsx) fetches this endpoint when expanded, keyed on `activeSymbol`
- Row format: timestamp · verdict · side · regime · MEM✓/✗ · lessons count · W/F/L pills · impact score
