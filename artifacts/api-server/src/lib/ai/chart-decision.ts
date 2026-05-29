// ============================================================
// Chart Decision — qwen2.5:14b decision engine
// Takes structured ChartAnalysis output from the vision model
// and produces a concrete, hedge-fund-grade trade plan.
// Always returns LONG, SHORT, or NO_TRADE with full details.
// ============================================================

import { ollamaGenerate, parseJsonFromResponse } from "./ollama.js";
import type { ChartAnalysis } from "./analyze-chart.js";
import type { SimilarityMatch } from "./similarity.js";
import { logger } from "../logger.js";

export interface ChartDecision {
  direction: "LONG" | "SHORT" | "NO_TRADE";
  confidence: number;
  entry: number;
  stopLoss: number;
  /** Primary target — 1:1 RR minimum */
  takeProfit1: number;
  /** Extended target — 2:1 RR minimum */
  takeProfit2: number;
  /** Runner target — 3:1+ RR */
  takeProfit3: number;
  riskReward: number;
  technicalReasoning: string;
  marketStructureReasoning: string;
  historicalReasoning: string;
  successProbability: number;
  // ── NO_TRADE fields (populated when direction === "NO_TRADE") ──
  noTradeReason?: string;
  noTradeMissingCondition?: string;
  noTradeBreakoutLevel?: number;
  noTradeBreakdownLevel?: number;
  noTradeConfirmationCandle?: string;
  noTradeVolumeCondition?: string;
}

const SYSTEM = `You are a senior analyst at a quantitative hedge fund. You have traded equity markets for 20+ years. Your job is to read technical chart data and produce a definitive, institutional-grade trade decision. You NEVER sit on the fence. You always commit to LONG, SHORT, or NO_TRADE — and you explain precisely why with exact price levels. You respond ONLY with valid JSON. No preamble. No markdown outside the JSON block.`;

function buildDecisionPrompt(
  analysis: ChartAnalysis,
  symbol: string | undefined,
  timeframe: string | undefined,
  similarSetups: SimilarityMatch[],
): string {
  const ctx = `${symbol ?? "unknown"} on ${timeframe ?? "unknown"} timeframe`;

  const resistance = analysis.resistanceLevels.slice(0, 5).join(", ") || "not detected";
  const support    = analysis.supportLevels.slice(0, 5).join(", ") || "not detected";
  const supply     = analysis.supplyZones.slice(0, 3).join(", ") || "not detected";
  const demand     = analysis.demandZones.slice(0, 3).join(", ") || "not detected";

  const allPrices = [
    ...analysis.resistanceLevels,
    ...analysis.supportLevels,
    ...analysis.supplyZones,
    ...analysis.demandZones,
  ].filter(p => typeof p === "number" && p > 0).sort((a, b) => a - b);

  const priceRange = allPrices.length >= 2
    ? `Approximate price range visible on chart: ${allPrices[0].toFixed(2)} – ${allPrices[allPrices.length - 1].toFixed(2)}`
    : "No price levels detected — estimate levels from context";

  const simStr = similarSetups.length > 0
    ? similarSetups.slice(0, 4).map(s =>
        `  • ${s.strategy} (${s.side.toUpperCase()}) on ${s.symbol}: ${(s.historicalWinRate * 100).toFixed(0)}% win rate over ${s.sampleSize} trades, avg RR ${s.avgRR.toFixed(1)}`
      ).join("\n")
    : "  No historical similarity data available";

  // Lean recommendation based on trend + structure for the model to confirm or override
  const leanBias =
    (analysis.trend === "strong_uptrend" || analysis.trend === "uptrend") &&
    (analysis.marketStructure === "higher_highs_lows" || analysis.marketStructure === "breakout")
      ? "Initial lean: LONG — confirm with levels below"
    : (analysis.trend === "strong_downtrend" || analysis.trend === "downtrend") &&
      (analysis.marketStructure === "lower_highs_lows" || analysis.marketStructure === "breakdown")
      ? "Initial lean: SHORT — confirm with levels below"
    : "Initial lean: EVALUATE — check whether a clear edge exists";

  return `You are the lead analyst on ${ctx}.

═══════════════════════════════════════════════
VISION MODEL REPORT
═══════════════════════════════════════════════
Trend:            ${analysis.trend}
Market Structure: ${analysis.marketStructure}
Volume Behavior:  ${analysis.volumeBehavior}
Patterns:         ${analysis.patterns.join(", ") || "none detected"}
Resistance:       ${resistance}
Support:          ${support}
Supply Zones:     ${supply}
Demand Zones:     ${demand}
${priceRange}
Vision Summary:   "${analysis.summary}"
Vision Confidence: ${analysis.confidence}%
${leanBias}

═══════════════════════════════════════════════
HISTORICAL MEMORY — SIMILAR SETUPS
═══════════════════════════════════════════════
${simStr}

═══════════════════════════════════════════════
YOUR MANDATORY DECISION FRAMEWORK
═══════════════════════════════════════════════
Step 1 — Classify direction:
  LONG  → trend up + bullish structure + clear demand or support beneath price
  SHORT → trend down + bearish structure + clear supply or resistance above price
  NO_TRADE → genuine ambiguity: both bulls and bears have equal control right now

Step 2 — Only use NO_TRADE when ALL of these apply:
  - Trend is neutral AND structure is range_bound or unclear
  - No dominant pattern breaks the tie
  - Risk/reward would be below 1.5:1 in either direction

Step 3 — For LONG/SHORT, set levels with discipline:
  - Entry: optimal entry price (limit or market)
  - StopLoss: behind the most recent swing structure (NOT arbitrary %)
  - TP1: first major opposing level (minimum 1:1 RR)
  - TP2: next major zone beyond TP1 (minimum 2:1 RR)
  - TP3: runner target — extended move (minimum 3:1 RR)
  - Use actual price levels from the chart, not round-number guesses

Step 4 — For NO_TRADE, state exact conditions that would trigger entry:
  - What price breakout would confirm a LONG
  - What price breakdown would confirm a SHORT
  - What candlestick pattern is required for confirmation
  - What volume condition must be present

═══════════════════════════════════════════════
OUTPUT — JSON ONLY — NO PREAMBLE
═══════════════════════════════════════════════
For LONG or SHORT respond with:
{
  "direction": "LONG" or "SHORT",
  "confidence": 0_to_100,
  "entry": exact_entry_price,
  "stopLoss": exact_stop_loss_price,
  "takeProfit1": tp1_price,
  "takeProfit2": tp2_price,
  "takeProfit3": tp3_price,
  "riskReward": ratio_eg_2.5,
  "technicalReasoning": "2-3 sentences: specific patterns, candle signals, indicator confluence",
  "marketStructureReasoning": "2-3 sentences: structure, key S/R, supply/demand context",
  "historicalReasoning": "1-2 sentences: how similar setups performed historically",
  "successProbability": 0_to_100,
  "noTradeReason": null,
  "noTradeMissingCondition": null,
  "noTradeBreakoutLevel": null,
  "noTradeBreakdownLevel": null,
  "noTradeConfirmationCandle": null,
  "noTradeVolumeCondition": null
}

For NO_TRADE respond with:
{
  "direction": "NO_TRADE",
  "confidence": 0_to_100,
  "entry": 0,
  "stopLoss": 0,
  "takeProfit1": 0,
  "takeProfit2": 0,
  "takeProfit3": 0,
  "riskReward": 0,
  "technicalReasoning": "why neither direction offers clear edge right now",
  "marketStructureReasoning": "what the structure shows and why it is ambiguous",
  "historicalReasoning": "what historical data says about range-bound conditions",
  "successProbability": 0,
  "noTradeReason": "clear 1-2 sentence explanation of why no trade exists",
  "noTradeMissingCondition": "what exact condition is absent that would justify entry",
  "noTradeBreakoutLevel": price_that_triggers_long_or_null,
  "noTradeBreakdownLevel": price_that_triggers_short_or_null,
  "noTradeConfirmationCandle": "e.g. bullish engulfing close above 444.00",
  "noTradeVolumeCondition": "e.g. volume must exceed 20-period average on breakout candle"
}`;
}

const VALID_DIRECTIONS = ["LONG", "SHORT", "NO_TRADE"] as const;

export async function makeChartDecision(
  analysis: ChartAnalysis,
  symbol: string | undefined,
  timeframe: string | undefined,
  similarSetups: SimilarityMatch[],
): Promise<ChartDecision> {
  const prompt = buildDecisionPrompt(analysis, symbol, timeframe, similarSetups);

  logger.info({ symbol, timeframe, trend: analysis.trend, structure: analysis.marketStructure }, "Chart decision requested");

  const raw = await ollamaGenerate(prompt, SYSTEM, 800);

  let decision: ChartDecision;
  try {
    const parsed = parseJsonFromResponse(raw) as Record<string, unknown>;

    const direction = VALID_DIRECTIONS.includes(parsed.direction as never)
      ? (parsed.direction as ChartDecision["direction"])
      : "NO_TRADE";

    const num = (key: string, fallback = 0) =>
      typeof parsed[key] === "number" ? (parsed[key] as number) : fallback;
    const str = (key: string, fallback = "") =>
      typeof parsed[key] === "string" ? (parsed[key] as string) : fallback;
    const numOrNull = (key: string): number | undefined =>
      typeof parsed[key] === "number" ? (parsed[key] as number) : undefined;
    const strOrNull = (key: string): string | undefined =>
      typeof parsed[key] === "string" && parsed[key] !== "" ? (parsed[key] as string) : undefined;

    const entry = num("entry");
    const sl    = num("stopLoss");
    const tp1   = num("takeProfit1");
    const tp2   = num("takeProfit2");
    const tp3   = num("takeProfit3");

    // Compute RR from TP1 if model didn't provide it
    const parsedRR = num("riskReward");
    const computedRR = (entry > 0 && sl > 0 && tp1 > 0)
      ? Math.abs(tp1 - entry) / (Math.abs(entry - sl) || 0.001)
      : 0;
    const riskReward = parsedRR > 0 ? parsedRR : Math.round(computedRR * 100) / 100;

    decision = {
      direction,
      confidence:               Math.max(0, Math.min(100, num("confidence", 50))),
      entry,
      stopLoss:                 sl,
      takeProfit1:              tp1,
      takeProfit2:              tp2,
      takeProfit3:              tp3,
      riskReward,
      technicalReasoning:       str("technicalReasoning"),
      marketStructureReasoning: str("marketStructureReasoning"),
      historicalReasoning:      str("historicalReasoning"),
      successProbability:       Math.max(0, Math.min(100, num("successProbability", 50))),
      noTradeReason:            strOrNull("noTradeReason"),
      noTradeMissingCondition:  strOrNull("noTradeMissingCondition"),
      noTradeBreakoutLevel:     numOrNull("noTradeBreakoutLevel"),
      noTradeBreakdownLevel:    numOrNull("noTradeBreakdownLevel"),
      noTradeConfirmationCandle: strOrNull("noTradeConfirmationCandle"),
      noTradeVolumeCondition:   strOrNull("noTradeVolumeCondition"),
    };

    logger.info(
      { symbol, direction, confidence: decision.confidence, entry, sl, tp1, tp2, tp3, rr: riskReward },
      "Chart decision parsed",
    );
  } catch (parseErr) {
    logger.warn({ parseErr, raw: raw.slice(0, 300) }, "Chart decision parse failed — NO_TRADE fallback");
    decision = {
      direction:                "NO_TRADE",
      confidence:               0,
      entry:                    0,
      stopLoss:                 0,
      takeProfit1:              0,
      takeProfit2:              0,
      takeProfit3:              0,
      riskReward:               0,
      technicalReasoning:       "Could not parse decision from model response.",
      marketStructureReasoning: "",
      historicalReasoning:      "",
      successProbability:       0,
      noTradeReason:            "Model response could not be parsed.",
    };
  }

  return decision;
}
