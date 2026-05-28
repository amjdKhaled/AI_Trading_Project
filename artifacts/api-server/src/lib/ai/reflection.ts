import { ollamaGenerate, parseJsonFromResponse } from "./ollama.js";
import { appendTrade, getRelevantContext } from "./memory.js";
import { logger } from "../logger.js";
import type { TradeMemoryEntry, AiReflection } from "./types.js";

const SYSTEM = `You are a professional trading coach and market analyst. You analyze completed trades with precision and extract actionable lessons. You respond ONLY with valid JSON — no preamble, no markdown outside the JSON block.`;

function buildReflectionPrompt(trade: TradeMemoryEntry, similar: TradeMemoryEntry[]): string {
  const similarSummary = similar.length > 0
    ? similar.slice(0, 4).map(t =>
        `  - ${t.strategy} ${t.side} ${t.regime}: ${t.outcome} (conf ${t.confidence}, pillars ${t.confluenceCount})`
      ).join("\n")
    : "  None in memory yet.";

  return `Analyze this completed trade and extract lessons.

TRADE:
  Symbol: ${trade.symbol} | Side: ${trade.side} | Strategy: ${trade.strategy}
  Regime: ${trade.regime} | Session: ${trade.session} | HTF Bias: ${trade.htfBias}
  Confidence: ${trade.confidence} | Grade: ${trade.grade} | Pillars: ${trade.confluenceCount}
  Entry: ${trade.entryPrice} | SL: ${trade.slPrice} | TP: ${trade.tpPrice} | Exit: ${trade.exitPrice ?? "N/A"}
  R:R Ratio: ${trade.rrRatio} | Risk Level: ${trade.riskLevel}
  Volume State: ${trade.volumeState} | Structure: ${trade.structureState}
  Patterns: ${trade.patterns.join(", ") || "none"}
  OUTCOME: ${trade.outcome.toUpperCase()}

SIMILAR RECENT TRADES (same symbol/regime/side):
${similarSummary}

Respond with JSON only:
{
  "lesson": "One concrete, specific lesson from this trade outcome (max 120 chars)",
  "weaknesses": ["list of 1-3 specific setup weaknesses that contributed to outcome"],
  "trapType": "name of trap pattern if applicable (fake_breakout | liquidity_sweep | counter_trend | exhaustion | null)",
  "continuationProbability": 0.0,
  "reasoning": "2-3 sentence analysis of why this trade won or lost"
}`;
}

export async function reflectOnTrade(trade: TradeMemoryEntry): Promise<AiReflection> {
  const similar = getRelevantContext(trade.symbol, trade.regime, trade.strategy, trade.side);

  const prompt  = buildReflectionPrompt(trade, similar);
  const raw     = await ollamaGenerate(prompt, SYSTEM);

  let reflection: AiReflection;
  try {
    const parsed = parseJsonFromResponse(raw) as Partial<AiReflection>;
    reflection = {
      outcome:                 trade.outcome,
      lesson:                  parsed.lesson                  ?? `${trade.strategy} in ${trade.regime}: ${trade.outcome}`,
      weaknesses:              Array.isArray(parsed.weaknesses) ? parsed.weaknesses : [],
      trapType:                parsed.trapType                ?? null,
      continuationProbability: typeof parsed.continuationProbability === "number"
                                 ? Math.max(0, Math.min(1, parsed.continuationProbability))
                                 : 0.5,
      reasoning:               parsed.reasoning              ?? "",
    };
  } catch (parseErr) {
    logger.warn({ parseErr, raw }, "AI reflection parse failed — using fallback");
    reflection = {
      outcome:                 trade.outcome,
      lesson:                  `${trade.strategy} ${trade.side} in ${trade.regime}: ${trade.outcome}`,
      weaknesses:              [],
      trapType:                null,
      continuationProbability: trade.outcome === "tp_hit" ? 0.65 : 0.35,
      reasoning:               raw.slice(0, 200),
    };
  }

  const withLesson: TradeMemoryEntry = {
    ...trade,
    lesson:                  reflection.lesson,
    weaknesses:              reflection.weaknesses,
    trapType:                reflection.trapType,
    continuationProbability: reflection.continuationProbability,
  };
  appendTrade(withLesson);

  return reflection;
}

export async function reflectWithoutAi(trade: TradeMemoryEntry): Promise<void> {
  appendTrade(trade);
}
