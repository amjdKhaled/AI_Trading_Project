// ============================================================
// Chart Analysis — qwen2.5-vl:7b vision model
// Accepts a base64 chart image, returns structured ChartAnalysis.
// Stores result in ai_chart_analyses table.
// ============================================================

import { ollamaVisionGenerate } from "./ollama-vision.js";
import { parseJsonFromResponse } from "./ollama.js";
import { db, aiChartAnalysesTable } from "@workspace/db";
import { logger } from "../logger.js";

const SYSTEM = `You are an expert technical analyst with 20 years of experience in equity markets. You analyze chart images with precision and identify key patterns, levels, and market structure. You respond ONLY with valid JSON — no preamble, no markdown outside the JSON block.`;

export interface ChartAnalysis {
  trend: "strong_uptrend" | "uptrend" | "neutral" | "downtrend" | "strong_downtrend";
  patterns: string[];
  resistanceLevels: number[];
  supportLevels: number[];
  volumeBehavior: "expanding" | "contracting" | "climax" | "normal" | "weak";
  marketStructure: "higher_highs_lows" | "lower_highs_lows" | "range_bound" | "breakout" | "breakdown" | "unclear";
  supplyZones: number[];
  demandZones: number[];
  summary: string;
  confidence: number;
}

function buildChartPrompt(symbol?: string, timeframe?: string): string {
  const ctx = symbol ? `Symbol: ${symbol}${timeframe ? `, Timeframe: ${timeframe}` : ""}` : "Unknown chart";
  return `Analyze this trading chart image and identify all key technical elements.

Chart context: ${ctx}

Examine the chart carefully for:
1. Overall trend direction and strength
2. Candlestick patterns (engulfing, doji, hammer, shooting star, inside bar, etc.)
3. Key resistance levels (price levels where price has rejected multiple times)
4. Key support levels (price levels where price has bounced multiple times)  
5. Volume behavior (expanding, contracting, climax volume)
6. Market structure (higher highs/lows = uptrend, lower highs/lows = downtrend, range-bound)
7. Supply zones (price areas with heavy selling pressure)
8. Demand zones (price areas with heavy buying pressure)

Respond with JSON ONLY:
{
  "trend": "strong_uptrend | uptrend | neutral | downtrend | strong_downtrend",
  "patterns": ["list of candlestick or chart patterns you see"],
  "resistanceLevels": [price_numbers_only],
  "supportLevels": [price_numbers_only],
  "volumeBehavior": "expanding | contracting | climax | normal | weak",
  "marketStructure": "higher_highs_lows | lower_highs_lows | range_bound | breakout | breakdown | unclear",
  "supplyZones": [price_numbers_only],
  "demandZones": [price_numbers_only],
  "summary": "2-3 sentence technical summary of the chart",
  "confidence": 0_to_100
}`;
}

const VALID_TRENDS = ["strong_uptrend","uptrend","neutral","downtrend","strong_downtrend"] as const;
const VALID_VOLUMES = ["expanding","contracting","climax","normal","weak"] as const;
const VALID_STRUCTURES = ["higher_highs_lows","lower_highs_lows","range_bound","breakout","breakdown","unclear"] as const;

export async function analyzeChart(params: {
  imageBase64: string;
  symbol?: string;
  timeframe?: string;
  signalId?: string;
}): Promise<ChartAnalysis> {
  const { imageBase64, symbol, timeframe, signalId } = params;

  const prompt = buildChartPrompt(symbol, timeframe);

  logger.info({ symbol, timeframe, signalId, hasImage: !!imageBase64 }, "Chart analysis requested");

  const raw = await ollamaVisionGenerate(prompt, imageBase64, SYSTEM, 600);

  let analysis: ChartAnalysis;
  try {
    const parsed = parseJsonFromResponse(raw) as Partial<ChartAnalysis>;

    analysis = {
      trend: VALID_TRENDS.includes(parsed.trend as never)
        ? (parsed.trend as ChartAnalysis["trend"]) : "neutral",
      patterns: Array.isArray(parsed.patterns) ? parsed.patterns : [],
      resistanceLevels: Array.isArray(parsed.resistanceLevels)
        ? parsed.resistanceLevels.filter(v => typeof v === "number") : [],
      supportLevels: Array.isArray(parsed.supportLevels)
        ? parsed.supportLevels.filter(v => typeof v === "number") : [],
      volumeBehavior: VALID_VOLUMES.includes(parsed.volumeBehavior as never)
        ? (parsed.volumeBehavior as ChartAnalysis["volumeBehavior"]) : "normal",
      marketStructure: VALID_STRUCTURES.includes(parsed.marketStructure as never)
        ? (parsed.marketStructure as ChartAnalysis["marketStructure"]) : "unclear",
      supplyZones: Array.isArray(parsed.supplyZones)
        ? parsed.supplyZones.filter(v => typeof v === "number") : [],
      demandZones: Array.isArray(parsed.demandZones)
        ? parsed.demandZones.filter(v => typeof v === "number") : [],
      summary: typeof parsed.summary === "string" ? parsed.summary : raw.slice(0, 200),
      confidence: typeof parsed.confidence === "number"
        ? Math.max(0, Math.min(100, parsed.confidence)) : 50,
    };
  } catch (parseErr) {
    logger.warn({ parseErr, raw: raw.slice(0, 200) }, "Chart analysis parse failed — using fallback");
    analysis = {
      trend: "neutral",
      patterns: [],
      resistanceLevels: [],
      supportLevels: [],
      volumeBehavior: "normal",
      marketStructure: "unclear",
      supplyZones: [],
      demandZones: [],
      summary: "Chart analysis could not be parsed from vision model response",
      confidence: 0,
    };
  }

  try {
    await db.insert(aiChartAnalysesTable).values({
      signalId:         signalId ?? null,
      symbol:           symbol ?? null,
      timeframe:        timeframe ?? null,
      trend:            analysis.trend,
      patterns:         analysis.patterns,
      resistanceLevels: analysis.resistanceLevels,
      supportLevels:    analysis.supportLevels,
      volumeBehavior:   analysis.volumeBehavior,
      marketStructure:  analysis.marketStructure,
      supplyZones:      analysis.supplyZones,
      demandZones:      analysis.demandZones,
      summary:          analysis.summary,
      confidence:       analysis.confidence,
      rawResponse:      raw.slice(0, 4000),
    });
  } catch (dbErr) {
    logger.warn({ dbErr }, "Failed to persist chart analysis to DB");
  }

  return analysis;
}
