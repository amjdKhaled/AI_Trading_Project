// ============================================================
// Chart Decision — qwen2.5:14b decision engine
// Takes structured ChartAnalysis output from the vision model
// and produces a concrete trade plan with Entry/SL/TP/RR.
// ============================================================

import { ollamaGenerate, parseJsonFromResponse } from "./ollama.js";
import type { ChartAnalysis } from "./analyze-chart.js";
import type { SimilarityMatch } from "./similarity.js";
import { logger } from "../logger.js";

export interface ChartDecision {
  direction: "BUY" | "SELL" | "NO_TRADE";
  confidence: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  riskReward: number;
  technicalReasoning: string;
  marketStructureReasoning: string;
  historicalReasoning: string;
  successProbability: number;
}

const SYSTEM = `You are an institutional trading desk analyst with 20 years of experience. You receive structured technical analysis from a vision model and provide precise, actionable trade plans. You respond ONLY with valid JSON — no preamble, no markdown.`;

function buildDecisionPrompt(
  analysis: ChartAnalysis,
  symbol: string | undefined,
  timeframe: string | undefined,
  similarSetups: SimilarityMatch[],
): string {
  const ctx = `${symbol ?? "unknown"} on ${timeframe ?? "unknown"} timeframe`;

  const levels = [
    ...analysis.resistanceLevels.slice(0, 4).map((l) => `R:${l}`),
    ...analysis.supportLevels.slice(0, 4).map((l) => `S:${l}`),
  ].join(", ");

  const zones = [
    ...analysis.supplyZones.slice(0, 2).map((z) => `Supply:${z}`),
    ...analysis.demandZones.slice(0, 2).map((z) => `Demand:${z}`),
  ].join(", ");

  const simStr = similarSetups.length > 0
    ? similarSetups.slice(0, 3).map((s) =>
        `${s.strategy} (${s.side}) @ ${s.symbol}: ${(s.historicalWinRate * 100).toFixed(0)}% WR over ${s.sampleSize} trades, avg RR ${s.avgRR.toFixed(1)}`
      ).join("; ")
    : "No historical similarity data available";

  const allPrices = [
    ...analysis.resistanceLevels,
    ...analysis.supportLevels,
    ...analysis.supplyZones,
    ...analysis.demandZones,
  ].filter((p) => typeof p === "number" && p > 0);
  const hasLevels = allPrices.length >= 2;

  return `You are analyzing a trading chart for ${ctx}.

VISION MODEL FINDINGS:
- Trend: ${analysis.trend}
- Market Structure: ${analysis.marketStructure}
- Volume Behavior: ${analysis.volumeBehavior}
- Patterns Detected: ${analysis.patterns.join(", ") || "none"}
- Key Price Levels: ${levels || "none"}
- Supply/Demand Zones: ${zones || "none"}
- Vision Summary: "${analysis.summary}"
- Vision Model Confidence: ${analysis.confidence}%

HISTORICAL SIMILAR SETUPS:
${simStr}

INSTRUCTIONS:
Determine trade direction from trend + structure:
- strong_uptrend + higher_highs_lows or breakout → lean BUY
- strong_downtrend + lower_highs_lows or breakdown → lean SELL  
- neutral / range_bound / unclear → NO_TRADE unless strong pattern confluence
- Low vision confidence (<40%) → prefer NO_TRADE

${hasLevels ? `Set trade levels using detected price zones:
- Entry (BUY): near nearest demand zone or just above last support
- Entry (SELL): near nearest supply zone or just below last resistance
- Stop Loss: 1-2 ATR (estimated ~0.5-1%) beyond the opposing level
- Take Profit: at the next major opposing level (target 2:1+ RR)` : `No price levels were detected by the vision model. Set entry/stopLoss/takeProfit to 0 and direction to NO_TRADE.`}

Respond with JSON ONLY:
{
  "direction": "BUY | SELL | NO_TRADE",
  "confidence": 0_to_100,
  "entry": price_or_0,
  "stopLoss": price_or_0,
  "takeProfit": price_or_0,
  "riskReward": ratio_or_0,
  "technicalReasoning": "2-3 sentences on patterns and indicator confluence",
  "marketStructureReasoning": "2-3 sentences on structure, S/R levels, zone context",
  "historicalReasoning": "1-2 sentences referencing similar historical setups and success rates",
  "successProbability": 0_to_100
}`;
}

const VALID_DIRECTIONS = ["BUY", "SELL", "NO_TRADE"] as const;

export async function makeChartDecision(
  analysis: ChartAnalysis,
  symbol: string | undefined,
  timeframe: string | undefined,
  similarSetups: SimilarityMatch[],
): Promise<ChartDecision> {
  const prompt = buildDecisionPrompt(analysis, symbol, timeframe, similarSetups);

  logger.info({ symbol, timeframe, trend: analysis.trend }, "Chart decision requested");

  const raw = await ollamaGenerate(prompt, SYSTEM, 600);

  let decision: ChartDecision;
  try {
    const parsed = parseJsonFromResponse(raw) as Partial<ChartDecision>;

    const direction = VALID_DIRECTIONS.includes(parsed.direction as never)
      ? (parsed.direction as ChartDecision["direction"])
      : "NO_TRADE";

    const entry = typeof parsed.entry === "number" ? parsed.entry : 0;
    const sl    = typeof parsed.stopLoss === "number" ? parsed.stopLoss : 0;
    const tp    = typeof parsed.takeProfit === "number" ? parsed.takeProfit : 0;

    const rr = typeof parsed.riskReward === "number"
      ? parsed.riskReward
      : (entry > 0 && sl > 0 && tp > 0
          ? Math.abs(tp - entry) / (Math.abs(entry - sl) || 0.001)
          : 0);

    decision = {
      direction,
      confidence:               Math.max(0, Math.min(100, typeof parsed.confidence === "number" ? parsed.confidence : 50)),
      entry,
      stopLoss:                 sl,
      takeProfit:               tp,
      riskReward:               Math.round(rr * 100) / 100,
      technicalReasoning:       typeof parsed.technicalReasoning === "string" ? parsed.technicalReasoning : "",
      marketStructureReasoning: typeof parsed.marketStructureReasoning === "string" ? parsed.marketStructureReasoning : "",
      historicalReasoning:      typeof parsed.historicalReasoning === "string" ? parsed.historicalReasoning : "",
      successProbability:       Math.max(0, Math.min(100, typeof parsed.successProbability === "number" ? parsed.successProbability : 50)),
    };
  } catch (parseErr) {
    logger.warn({ parseErr, raw: raw.slice(0, 200) }, "Chart decision parse failed — using NO_TRADE fallback");
    decision = {
      direction:                "NO_TRADE",
      confidence:               0,
      entry:                    0,
      stopLoss:                 0,
      takeProfit:               0,
      riskReward:               0,
      technicalReasoning:       "Could not parse decision from model response.",
      marketStructureReasoning: "",
      historicalReasoning:      "",
      successProbability:       0,
    };
  }

  return decision;
}
