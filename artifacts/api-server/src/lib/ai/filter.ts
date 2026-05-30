import { ollamaGenerate, isOllamaAvailable, parseJsonFromResponse } from "./ollama.js";
import { getRelevantContextFromDb, getStrategyWinRateFromDb, getRegimeWinRateFromDb, getRecentLessonsFromDb } from "./shared-memory.js";
import { getRelevantContext, getStrategyWinRate, getRegimeWinRate, loadMemory } from "./memory.js";
import { logger } from "../logger.js";
import type { AiSignalVerdict, AiCandleDecision, CandleVerdict } from "./types.js";
import type { SignalCandidate, OhlcvBar } from "../analyzer/types.js";
import type { NewsSentiment } from "./news.js";

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

// ── Candle-close AI decision ─────────────────────────────────────────────────
// Called after every candle close. Returns APPROVE / REJECT / WAIT.
// Hard rules (applied before Ollama):
//   - confidence < 80 → WAIT (never force a low-confidence trade)
//   - R:R < 1.5       → REJECT immediately
//   - Ollama offline  → WAIT (safe default, no capital risked)
// ─────────────────────────────────────────────────────────────────────────────

const CANDLE_SYSTEM = `You are a professional trading risk manager. A technical engine generated a trade candidate. Your ONLY job: evaluate it and return APPROVE, REJECT, or WAIT. Respond ONLY with valid JSON. No markdown, no preamble.`;

function buildCandlePrompt(
  candidate: SignalCandidate,
  news: NewsSentiment,
  bars: OhlcvBar[],
  symbol: string,
  timeframe: string,
): string {
  const meta    = (candidate.metadata ?? {}) as Record<string, unknown>;
  const risk    = Math.abs(candidate.entryPrice - candidate.slPrice) || 1;
  const reward  = Math.abs(candidate.tpPrice - candidate.entryPrice);
  const rrRatio = (reward / risk).toFixed(2);
  const last5   = bars.slice(-5)
    .map(b => `O:${b.open.toFixed(4)} H:${b.high.toFixed(4)} L:${b.low.toFixed(4)} C:${b.close.toFixed(4)}`)
    .join(" | ");

  return `Evaluate this ${timeframe} signal on ${symbol}.

CANDIDATE:
  Side: ${candidate.side.toUpperCase()} | Entry: ${candidate.entryPrice.toFixed(4)} | SL: ${candidate.slPrice.toFixed(4)} | TP: ${candidate.tpPrice.toFixed(4)}
  R:R: ${rrRatio} | Engine confidence: ${candidate.confidence}/100 | Grade: ${candidate.grade}
  Strategy: ${candidate.strategy ?? "N/A"} | Regime: ${String(meta.regime ?? "?")}
  HTF Bias: ${String(meta.htfBias ?? "neutral")} | Session: ${String(meta.session ?? "?")}
  Volume: ${String(meta.volumeState ?? "?")} | Structure: ${String(meta.structureState ?? "?")}
  Patterns: ${candidate.patterns.slice(0, 8).join(", ") || "none"}
  Confluence pillars: ${String(meta.confluenceCount ?? "?")}

LAST 5 BARS: ${last5}

NEWS (secondary — technical structure takes priority):
  Sentiment: ${news.sentiment} (${news.score.toFixed(2)}) | ${news.summary}

HARD REJECTION RULES — reject if ANY applies:
1. R:R < 1.5
2. Entry is directly at key S/R (within 0.3% of recent swing high/low)
3. Regime is "chop" with no strong pattern
4. HTF bias strongly opposes the direction (e.g., LONG in "bear" HTF)
5. News strongly opposes the direction AND setup is already marginal
6. Price just completed 5+ consecutive bars in same direction (post-extended)

WAIT if: confidence feels below 80, entry quality is ambiguous, or mixed signals.
APPROVE only when: clean structure, R:R ≥ 1.5, aligned HTF, volume confirms.

Return ONLY this JSON (numbers must be numeric, not strings):
{
  "verdict": "APPROVE" | "REJECT" | "WAIT",
  "confidence": 0-100,
  "entry": <number>,
  "stopLoss": <number>,
  "takeProfit": <number>,
  "invalidation": <price that voids the setup>,
  "reasoning": "<2 sentences max>",
  "rejectionReason": null | "<brief reason>"
}`;
}

function noTradeDecision(
  symbol: string, timeframe: string, candleTimeSec: number, reason: string,
): AiCandleDecision {
  return {
    symbol, timeframe, candleTime: candleTimeSec,
    candidateSide: "no_trade", verdict: "WAIT", confidence: 0,
    entryPrice: null, slPrice: null, tpPrice: null,
    invalidationLevel: null, rrRatio: null,
    aiReasoning: reason, rejectionReason: null,
    newsSentiment: "neutral", newsSummary: "",
    regime: "unknown", htfBias: "neutral", session: "unknown",
    patterns: [], technicalContext: {},
  };
}

/**
 * Run Ollama verdict after a candle closes.
 * Returns an AiCandleDecision — always resolves, never throws.
 */
export async function filterCandleWithAi(
  candidate:     SignalCandidate | null,
  news:          NewsSentiment,
  bars:          OhlcvBar[],
  symbol:        string,
  timeframe:     string,
  candleTimeSec: number,
): Promise<AiCandleDecision> {
  // No setup from the engine → WAIT, no Ollama call needed
  if (!candidate) {
    return noTradeDecision(symbol, timeframe, candleTimeSec,
      "Engine found no qualifying setup at this candle close.");
  }

  const meta    = (candidate.metadata ?? {}) as Record<string, unknown>;
  const risk    = Math.abs(candidate.entryPrice - candidate.slPrice) || 1;
  const reward  = Math.abs(candidate.tpPrice - candidate.entryPrice);
  const rrRatio = Math.round((reward / risk) * 100) / 100;

  const base = {
    symbol, timeframe, candleTime: candleTimeSec,
    candidateSide:  candidate.side as "long" | "short",
    confidence:     candidate.confidence,
    entryPrice:     candidate.entryPrice,
    slPrice:        candidate.slPrice,
    tpPrice:        candidate.tpPrice,
    invalidationLevel: null as number | null,
    rrRatio,
    newsSentiment:  news.sentiment,
    newsSummary:    news.summary,
    regime:         String(meta.regime   ?? "unknown"),
    htfBias:        String(meta.htfBias  ?? "neutral"),
    session:        String(meta.session  ?? "unknown"),
    patterns:       candidate.patterns,
    technicalContext: {
      confidence:      candidate.confidence,
      grade:           candidate.grade,
      strategy:        candidate.strategy ?? null,
      volumeState:     meta.volumeState    ?? null,
      structureState:  meta.structureState ?? null,
      confluenceCount: meta.confluenceCount ?? null,
      rrRatio,
    } as Record<string, unknown>,
  };

  // Hard confidence gate — below 80 = WAIT, no Ollama call
  if (candidate.confidence < 80) {
    return {
      ...base, verdict: "WAIT",
      aiReasoning:    `Confidence ${candidate.confidence}/100 is below the 80 threshold — waiting for a cleaner setup.`,
      rejectionReason: `Confidence below threshold (${candidate.confidence})`,
    };
  }

  // R:R gate — reject < 1.5 immediately
  if (rrRatio < 1.5) {
    return {
      ...base, verdict: "REJECT",
      aiReasoning:    `R:R of ${rrRatio} is below 1.5 minimum — trade skipped.`,
      rejectionReason: `R:R too low: ${rrRatio}`,
    };
  }

  // Ollama availability
  const ollamaOk = await isOllamaAvailable();
  if (!ollamaOk) {
    return {
      ...base, verdict: "WAIT",
      aiReasoning:    "Ollama is offline — cannot evaluate. Defaulting to WAIT.",
      rejectionReason: null,
    };
  }

  // Call Ollama (30 s timeout — tight enough not to stall the chart)
  let raw = "";
  try {
    raw = await ollamaGenerate(buildCandlePrompt(candidate, news, bars, symbol, timeframe), CANDLE_SYSTEM);
  } catch (err) {
    logger.warn({ symbol, timeframe, err }, "Ollama candle-decision timed out — WAIT");
    return {
      ...base, verdict: "WAIT",
      aiReasoning:    "Ollama request timed out — defaulting to WAIT to protect capital.",
      rejectionReason: null,
    };
  }

  // Parse JSON
  try {
    const p = parseJsonFromResponse(raw) as Record<string, unknown>;

    const verdict: CandleVerdict = (["APPROVE", "REJECT", "WAIT"] as const).includes(p.verdict as CandleVerdict)
      ? (p.verdict as CandleVerdict)
      : "WAIT";

    const aiConf = typeof p.confidence === "number"
      ? Math.max(0, Math.min(100, Math.round(p.confidence))) : candidate.confidence;

    // Re-apply confidence gate on AI's own self-assessment
    const finalVerdict: CandleVerdict = aiConf < 80 && verdict === "APPROVE" ? "WAIT" : verdict;

    return {
      ...base,
      confidence:        aiConf,
      entryPrice:        typeof p.entry        === "number" ? p.entry        : candidate.entryPrice,
      slPrice:           typeof p.stopLoss      === "number" ? p.stopLoss     : candidate.slPrice,
      tpPrice:           typeof p.takeProfit    === "number" ? p.takeProfit   : candidate.tpPrice,
      invalidationLevel: typeof p.invalidation  === "number" ? p.invalidation : null,
      verdict:           finalVerdict,
      aiReasoning:       typeof p.reasoning       === "string" ? p.reasoning       : "No reasoning provided.",
      rejectionReason:   typeof p.rejectionReason === "string" ? p.rejectionReason : null,
    };
  } catch (parseErr) {
    logger.warn({ parseErr, raw, symbol }, "Candle decision JSON parse failed — WAIT");
    return {
      ...base, verdict: "WAIT",
      aiReasoning:    "AI response could not be parsed — defaulting to WAIT.",
      rejectionReason: null,
    };
  }
}
