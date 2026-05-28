---
name: Chart analysis pipeline architecture
description: How analyzeChart, persistChartAnalysis, and makeChartDecision are composed in the route.
---

## Rule
`analyzeChart()` is a pure vision call — no DB side-effects. `persistChartAnalysis()` does the single DB insert with all fields (analysis + decision + thumbnail). The route in `ai.ts` orchestrates all three phases:

1. `analyzeChart()` + `findSimilarPatterns()` in parallel (vision + similarity)
2. `makeChartDecision()` if Ollama is available (decision engine)
3. `persistChartAnalysis()` once with all data (single insert)

**Why:** An earlier version called `analyzeChart` twice (once for vision, once to "re-persist" with decision=NOOP). The second call re-ran the vision model on a dummy string, causing failures. Separating persist from vision eliminates this.

**How to apply:** Never auto-persist inside `analyzeChart`. If you add new fields to the chart analysis record, add them to `persistChartAnalysis` params and pass them from the route after all models have returned.
