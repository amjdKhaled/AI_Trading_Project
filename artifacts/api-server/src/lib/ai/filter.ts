import { ollamaGenerate, parseJsonFromResponse } from "./ollama.js";
import { getRelevantContextFromDb, getStrategyWinRateFromDb, getRegimeWinRateFromDb, getRecentLessonsFromDb } from "./shared-memory.js";
import { getRelevantContext, getStrategyWinRate, getRegimeWinRate, loadMemory } from "./memory.js";
import { logger } from "../logger.js";
import type { AiSignalVerdict } from "./types.js";

const SYSTEM = `You are a professional institutional trading analyst with 20 years of experience. You evaluate intraday momentum setups with discipline. You respond ONLY with valid JSON — no preamble, no markdown outside the JSON block. Be concise and data-driven.`;

interface SignalContext {
  symbol: string;
  side: "long" | "short";
  strategy: string;
  regime: string;
  session: string;
  htfBias: string;
  dayBias?: string;
  confidence: number;
  grade: string;
  confluenceCount: number;
  riskLevel: string;
  patterns: string[];
  rrRatio: number;
  volumeState: string;
  structureState: string;
  efRatio?: number;
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
}

function buildFilterPrompt(ctx: SignalContext, memCtx: string): string {
  return `Evaluate this trading signal and determine if it should be approved.

SIGNAL:
  Symbol: ${ctx.symbol} | Side: ${ctx.side.toUpperCase()} | Strategy: ${ctx.strategy}
  Regime: ${ctx.regime} | Session: ${ctx.session}
  HTF Bias: ${ctx.htfBias} | Daily Bias: ${ctx.dayBias ?? "unknown"}
  Confidence: ${ctx.confidence}/100 | Grade: ${ctx.grade}
  Confluence Pillars: ${ctx.confluenceCount}
  Risk: ${ctx.riskLevel} | R:R Ratio: ${ctx.rrRatio}
  Volume: ${ctx.volumeState} | Structure: ${ctx.structureState}
  Patterns: ${ctx.patterns.join(", ") || "none"}
  Entry: ${ctx.entryPrice} | SL: ${ctx.slPrice} | TP: ${ctx.tpPrice}
  Efficiency Ratio: ${ctx.efRatio ?? "N/A"}

MEMORY CONTEXT (similar past trades):
${memCtx}

Rules for approval:
- APPROVE if: regime matches direction, HTF bias aligned or neutral, volume confirms, R:R ≥ 1.5, no clear trap pattern
- CAUTION if: counter-trend, low volume, high RSI on long, session mismatch
- REJECT if: strong counter-trend signals, known trap pattern, R:R < 1.2, repeated failures in this regime+strategy combo

Respond with JSON only:
{
  "approved": true,
  "confidence": 72,
  "continuationProbability": 0.65,
  "trapProbability": 0.15,
  "setupQuality": "good",
  "reasoning": "Concise 2-sentence reasoning for decision",
  "warnings": ["list any specific warnings (empty array if none)"],
  "lessons": ["relevant lessons from memory that apply (empty array if none)"]
}`;
}

async function buildMemoryContext(ctx: SignalContext): Promise<string> {
  const lines: string[] = [];

  try {
    const [strategyWr, regimeWr, recent, recentLessons] = await Promise.all([
      getStrategyWinRateFromDb(ctx.strategy).catch(() => getStrategyWinRate(ctx.strategy)),
      getRegimeWinRateFromDb(ctx.regime).catch(() => getRegimeWinRate(ctx.regime)),
      getRelevantContextFromDb(ctx.symbol, ctx.regime, ctx.strategy, ctx.side).catch(
        () => getRelevantContext(ctx.symbol, ctx.regime, ctx.strategy, ctx.side),
      ),
      getRecentLessonsFromDb(3).catch(() => {
        const mem = loadMemory();
        return mem.recentLessons.slice(0, 3);
      }),
    ]);

    if (strategyWr !== null)
      lines.push(`  Strategy "${ctx.strategy}" historical WR: ${Math.round(strategyWr * 100)}%`);
    if (regimeWr !== null)
      lines.push(`  Regime "${ctx.regime}" historical WR: ${Math.round(regimeWr * 100)}%`);

    if (recent.length > 0) {
      lines.push("  Recent similar trades:");
      recent.slice(0, 4).forEach(t => {
        const wr = t.outcome === "tp_hit" ? "WIN" : "LOSS";
        lines.push(`    [${wr}] ${t.strategy} ${t.side} ${t.regime}/${t.session} — ${t.lesson ?? "no lesson"}`);
      });
    } else {
      lines.push("  No similar trades in memory yet.");
    }

    if (recentLessons.length > 0) {
      lines.push("  Recent lessons:");
      recentLessons.forEach(l => lines.push(`    • ${l}`));
    }
  } catch (err) {
    logger.warn({ err }, "Memory context build failed — using fallback");
    lines.push("  Memory unavailable.");
  }

  return lines.join("\n") || "  No memory context available.";
}

export async function filterSignalWithAi(ctx: SignalContext): Promise<AiSignalVerdict> {
  const memCtx = await buildMemoryContext(ctx);
  const prompt  = buildFilterPrompt(ctx, memCtx);
  const raw     = await ollamaGenerate(prompt, SYSTEM);

  try {
    const parsed = parseJsonFromResponse(raw) as Partial<AiSignalVerdict>;
    return {
      approved:                typeof parsed.approved === "boolean" ? parsed.approved : true,
      confidence:              typeof parsed.confidence === "number"
                                 ? Math.max(0, Math.min(100, parsed.confidence)) : ctx.confidence,
      continuationProbability: typeof parsed.continuationProbability === "number"
                                 ? Math.max(0, Math.min(1, parsed.continuationProbability)) : 0.5,
      trapProbability:         typeof parsed.trapProbability === "number"
                                 ? Math.max(0, Math.min(1, parsed.trapProbability)) : 0.2,
      setupQuality:            (["excellent","good","marginal","poor"] as const)
                                 .includes(parsed.setupQuality as never)
                                 ? parsed.setupQuality as AiSignalVerdict["setupQuality"]
                                 : "marginal",
      reasoning:               typeof parsed.reasoning === "string" ? parsed.reasoning : raw.slice(0, 200),
      warnings:                Array.isArray(parsed.warnings)  ? parsed.warnings  : [],
      lessons:                 Array.isArray(parsed.lessons)   ? parsed.lessons   : [],
    };
  } catch (parseErr) {
    logger.warn({ parseErr, raw }, "AI filter parse failed — defaulting to approve");
    return {
      approved:                true,
      confidence:              ctx.confidence,
      continuationProbability: 0.5,
      trapProbability:         0.2,
      setupQuality:            "marginal",
      reasoning:               "AI filter parse error — signal passed by default",
      warnings:                ["AI filter unavailable"],
      lessons:                 [],
    };
  }
}
