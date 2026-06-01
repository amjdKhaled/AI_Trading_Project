import { ollamaGenerateWithFallback, isOllamaAvailable, parseJsonFromResponse } from "./ollama.js";
import { getRelevantContextFromDb, getStrategyWinRateFromDb, getRegimeWinRateFromDb, getRecentLessonsFromDb, getWinnerLoserSummary, getFailureCategoryStats, getMostRecentLossReasoning } from "./shared-memory.js";
import { getRelevantContext, getStrategyWinRate, getRegimeWinRate, loadMemory } from "./memory.js";
import { logger } from "../logger.js";
import type { AiSignalVerdict, AiCandleDecision, CandleVerdict } from "./types.js";
import type { MarketContext, HistoricalSetupStats } from "./market-context.js";

// ── Signal pre-filter (evaluates a signal candidate from the engine) ──────────
// Legacy path: still used when the signal engine fires a candidate.
// Preserved so existing signal reflection + AI filter flows keep working.
// ─────────────────────────────────────────────────────────────────────────────

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
      getRecentLessonsFromDb(undefined, undefined, 3).catch(() => {
        const mem = loadMemory();
        return mem.recentLessons.slice(0, 3).map(lesson => ({ lesson, outcome: "unknown" as const }));
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
      recentLessons.forEach(l => lines.push(`    • ${l.lesson}`));
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
  const raw     = await ollamaGenerateWithFallback(prompt, SYSTEM);

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

// ── Candle-close memory context builder ──────────────────────────────────────
// Fetches ALL relevant AI memory sources in parallel BEFORE the Ollama call:
//   1. Similar past setups (same symbol + regime, both sides)
//   2. Recent AI lessons across all symbols
//   3. Winner/loser summary for this symbol + regime
//   4. Failure category statistics
//   5. Most recent loss reasoning (helps avoid repeat mistakes)
async function buildCandleMemoryContext(ctx: MarketContext): Promise<{
  text:                 string;
  lessons:              string[];
  memoryUsed:           boolean;
  winnerAnalysisLoaded: boolean;
  failureStatsLoaded:   boolean;
  recentLossLoaded:     boolean;
}> {
  try {
    const [longTrades, shortTrades, recentLessons, winnerSummary, failureStats, recentLoss] = await Promise.all([
      getRelevantContextFromDb(ctx.symbol, ctx.regime, "candle_decision", "long",  4).catch(() => []),
      getRelevantContextFromDb(ctx.symbol, ctx.regime, "candle_decision", "short", 4).catch(() => []),
      getRecentLessonsFromDb(undefined, undefined, 5).catch(() => []),
      getWinnerLoserSummary(ctx.symbol, ctx.regime).catch(() => ""),
      getFailureCategoryStats(ctx.symbol, ctx.regime).catch(() => ""),
      getMostRecentLossReasoning(ctx.symbol).catch(() => ""),
    ]);

    const allTrades = [...longTrades, ...shortTrades]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 6);

    const winnerAnalysisLoaded = winnerSummary.length > 0 && !winnerSummary.startsWith("No ");
    const failureStatsLoaded   = failureStats.length > 0  && !failureStats.startsWith("No ");
    const recentLossLoaded     = recentLoss.length > 0    && !recentLoss.startsWith("No ");

    if (allTrades.length === 0 && recentLessons.length === 0 && !winnerAnalysisLoaded && !failureStatsLoaded && !recentLossLoaded) {
      return { text: "No relevant memory lessons found for this symbol/regime.", lessons: [], memoryUsed: false, winnerAnalysisLoaded: false, failureStatsLoaded: false, recentLossLoaded: false };
    }

    const lines: string[] = [];
    if (allTrades.length > 0) {
      lines.push("SIMILAR PAST SETUPS (same symbol + regime):");
      for (const t of allTrades) {
        const wr = t.outcome === "tp_hit" ? "WIN" : "LOSS";
        lines.push(`  [${wr}] ${t.side.toUpperCase()} ${t.regime}/${t.session} RR:${t.rrRatio.toFixed(2)} conf:${t.confidence} — ${t.lesson ?? "no lesson"}`);
      }
    }
    if (recentLessons.length > 0) {
      lines.push("MEMORY LESSONS (all symbols, newest first):");
      for (const l of recentLessons) lines.push(`  • ${l.lesson}`);
    }
    if (winnerAnalysisLoaded) {
      const wLines = winnerSummary.split("\n  ");
      const winnerLine = wLines.find(l => l.trim().startsWith("Winners"));
      const loserLine  = wLines.find(l => l.trim().startsWith("Top loss"));
      if (winnerLine) lines.push(`WINNER ANALYSIS:\n  ${winnerLine.trim()}`);
      if (loserLine)  lines.push(`LOSER ANALYSIS:\n  ${loserLine.trim()}`);
    }
    if (failureStatsLoaded) {
      lines.push(`FAILURE CATEGORIES:\n${failureStats}`);
    }
    if (recentLossLoaded) {
      lines.push(`MOST RECENT LOSS:\n${recentLoss}`);
    }

    const lessonTexts = [
      ...allTrades.filter(t => t.lesson).map(t => t.lesson!),
      ...recentLessons.map(l => l.lesson),
    ].filter((l, i, a) => a.indexOf(l) === i).slice(0, 8);

    return { text: lines.join("\n"), lessons: lessonTexts, memoryUsed: true, winnerAnalysisLoaded, failureStatsLoaded, recentLossLoaded };
  } catch {
    return { text: "Memory unavailable.", lessons: [], memoryUsed: false, winnerAnalysisLoaded: false, failureStatsLoaded: false, recentLossLoaded: false };
  }
}

function computeMemoryImpactScore(mem: {
  lessons:              string[];
  winnerAnalysisLoaded: boolean;
  failureStatsLoaded:   boolean;
  recentLossLoaded:     boolean;
}, diverged = false): number {
  const lessonScore  = Math.min(60, mem.lessons.length * 10);
  const winnerScore  = mem.winnerAnalysisLoaded ? 15 : 0;
  const failureScore = mem.failureStatsLoaded   ? 15 : 0;
  const lossScore    = mem.recentLossLoaded     ? 10 : 0;
  // Divergence bonus: AI decision differed from the deterministic technical baseline,
  // suggesting memory context likely influenced the final decision.
  const divScore     = diverged ? 10 : 0;
  return Math.min(100, lessonScore + winnerScore + failureScore + lossScore + divScore);
}

/** Simple deterministic technical bias — used to detect memory-driven divergence. */
function computeTechnicalBias(ctx: MarketContext): "bullish" | "bearish" | "neutral" {
  const { ema200, macdHist, rsi14 } = ctx.indicators;
  const price = ctx.currentBar.close;
  if (price > ema200 && macdHist > 0 && rsi14 < 70) return "bullish";
  if (price < ema200 && macdHist < 0 && rsi14 > 30) return "bearish";
  return "neutral";
}

// ── Candle-close Trade Intelligence Engine ────────────────────────────────────
// The Market Analysis Engine (buildMarketContext) computes all indicators.
// Ollama reads the full market context and generates LONG / SHORT / WAIT.
//
// Hard rules applied AFTER Ollama (server-side enforcement):
//   - R:R < 2.0                      → WAIT
//   - LONG within 0.5% of resistance → WAIT
//   - SHORT within 0.5% of support   → WAIT
//   - confidence ≥ 85                → APPROVE  (raised from 80)
//   - confidence 65–84               → WAIT
//   - confidence < 65                → REJECT
//   - Ollama offline                 → WAIT
//   - setupGrade C or D              → WAIT
// Pre-Ollama hard gates (skip the AI call entirely):
//   - volume < 0.7× avg             → WAIT
// ─────────────────────────────────────────────────────────────────────────────

const CANDLE_SYSTEM = `You are an institutional Trade Intelligence Engine with 20 years of market experience. A deterministic Market Analysis Engine has computed complete context for you. Your sole job: read ALL the data and generate a precise LONG, SHORT, or WAIT decision. Respond ONLY with valid JSON. No preamble, no markdown, no text outside the JSON object.`;

function buildMarketContextPrompt(ctx: MarketContext, stats: HistoricalSetupStats, memBlock?: string): string {
  const { indicators: ind, structure: str, htf } = ctx;
  const price = ctx.currentBar.close;

  const obStr = ctx.orderBlocks.length > 0
    ? ctx.orderBlocks.map(o =>
        `${o.type.toUpperCase()} OB [${o.low.toFixed(4)}–${o.high.toFixed(4)}]${o.inZone ? " ← PRICE IN ZONE" : ""}`
      ).join(", ")
    : "none";

  const fvgStr = ctx.fairValueGaps.length > 0
    ? ctx.fairValueGaps.map(f =>
        `${f.type.toUpperCase()} FVG [${f.low.toFixed(4)}–${f.high.toFixed(4)}]${f.filled ? " (filled)" : f.inZone ? " ← PRICE IN ZONE" : ""}`
      ).join(", ")
    : "none";

  const recent15 = ctx.recentBars.slice(-15).map(b =>
    `  ${new Date(b.time * 1000).toISOString().slice(11, 16)} ` +
    `O:${b.open.toFixed(4)} H:${b.high.toFixed(4)} L:${b.low.toFixed(4)} C:${b.close.toFixed(4)} V:${b.volume.toFixed(0)}`
  ).join("\n");

  const resWarn = str.distanceToResistancePct != null && str.distanceToResistancePct < 0.5
    ? `\n  ⚠ PRICE IS ${str.distanceToResistancePct.toFixed(2)}% FROM RESISTANCE — NO LONG` : "";
  const supWarn = str.distanceToSupportPct != null && str.distanceToSupportPct < 0.5
    ? `\n  ⚠ PRICE IS ${str.distanceToSupportPct.toFixed(2)}% FROM SUPPORT — NO SHORT` : "";

  return `══════════════════════════════════════════════
MARKET ANALYSIS — ${ctx.symbol} ${ctx.timeframe}
Candle: ${new Date(ctx.candleTime * 1000).toISOString()} | Session: ${ctx.session}
══════════════════════════════════════════════

CURRENT BAR
  O:${ctx.currentBar.open.toFixed(4)}  H:${ctx.currentBar.high.toFixed(4)}  L:${ctx.currentBar.low.toFixed(4)}  C:${price.toFixed(4)}
  Volume: ${ctx.currentBar.volume.toFixed(0)} (${ind.relativeVolume}x 20-bar avg)

INDICATORS (last 100 ${ctx.timeframe} bars)
  RSI(14):  ${ind.rsi14}${ind.rsi14 > 70 ? " ← OVERBOUGHT" : ind.rsi14 < 30 ? " ← OVERSOLD" : ""}
  EMA20: ${ind.ema20}  EMA50: ${ind.ema50}  EMA200: ${ind.ema200}
  vs EMAs: ${price > ind.ema20 ? "ABOVE" : "BELOW"} EMA20 / ${price > ind.ema50 ? "ABOVE" : "BELOW"} EMA50 / ${price > ind.ema200 ? "ABOVE" : "BELOW"} EMA200
  MACD: ${ind.macdLine} / ${ind.macdSignal} / hist ${ind.macdHist}${ind.macdHist > 0 ? " (bullish)" : " (bearish)"}
  ATR(14): ${ind.atr14}  |  VWAP: ${ind.vwap} (price ${price > ind.vwap ? "ABOVE ↑" : "BELOW ↓"})

MARKET STRUCTURE (last 100 bars)
  Trend: ${str.trendDirection.toUpperCase()}  |  Regime: ${ctx.regime}
  Swing Highs: [${str.swingHighs.join(", ") || "none"}]
  Swing Lows:  [${str.swingLows.join(", ") || "none"}]
  Nearest Resistance: ${str.nearestResistance?.toFixed(4) ?? "none"}${str.distanceToResistancePct != null ? ` (+${str.distanceToResistancePct.toFixed(2)}% from price)` : ""}${resWarn}
  Nearest Support:    ${str.nearestSupport?.toFixed(4) ?? "none"}${str.distanceToSupportPct != null ? ` (-${str.distanceToSupportPct.toFixed(2)}% from price)` : ""}${supWarn}

TREND EVOLUTION: ${ctx.trendEvolution}
VOLUME BEHAVIOR: ${ctx.volumeEvolution}

LAST 15 BARS (${ctx.timeframe}):
${recent15}

HIGHER TIMEFRAME — ${htf.timeframe}
  Trend: ${htf.trendDirection.toUpperCase()}  |  Bias: ${htf.bias.toUpperCase()}
  RSI: ${htf.rsi14}  |  EMA20: ${htf.ema20}  EMA50: ${htf.ema50}  EMA200: ${htf.ema200}
  HTF Highs: [${htf.swingHighs.join(", ") || "none"}]
  HTF Lows:  [${htf.swingLows.join(", ") || "none"}]

INSTITUTIONAL ZONES
  Order Blocks: ${obStr}
  Fair Value Gaps: ${fvgStr}
  Candlestick Patterns: ${ctx.candlestickPatterns.join(", ") || "none"}

NEWS
  Sentiment: ${ctx.news.sentiment}${ctx.news.score != null ? ` (score: ${ctx.news.score.toFixed(2)})` : ""}
  Summary: ${ctx.news.summary || "No news data"}

HISTORICAL PERFORMANCE (${ctx.symbol})
  ${stats.summary}
  Closed trades: ${stats.samples}  |  Win Rate: ${(stats.winRate * 100).toFixed(1)}%
  Avg R:R (wins): ${stats.avgRR.toFixed(2)}  |  Avg loss: ${stats.avgLoss.toFixed(2)}R
  Regime "${ctx.regime}" AI approve rate: ${(stats.regimeApproveRate * 100).toFixed(0)}%
${memBlock ? `\n══════════════════════════════════════════════\nAI MEMORY — lessons from past trades:\n══════════════════════════════════════════════\n${memBlock}\n` : ""}
══════════════════════════════════════════════
MANDATORY DECISION RULES — ALL MUST BE APPLIED
══════════════════════════════════════════════
1. R:R MUST be ≥ 2.0 — if your R:R < 2.0, set decision = "WAIT"
2. confidence ≥ 80 → APPROVE  |  65–79 → WAIT  |  < 65 → REJECT
3. NO LONG if price is within 0.5% of nearest resistance
4. NO SHORT if price is within 0.5% of nearest support
5. Reduce confidence if HTF bias strongly opposes your direction
6. Use historical win rate and regime approve rate to calibrate confidence
7. Consider the last 15 bars — where is the highest-probability trade setup?
8. For LONG: entry near close or pullback, SL below nearest swing low, TP ≥ 2× risk
9. For SHORT: entry near close or retest, SL above nearest swing high, TP ≥ 2× risk

Return ONLY this JSON (all numeric fields must be numbers, not strings; use null for WAIT):
{
  "decision": "LONG" | "SHORT" | "WAIT",
  "confidence": <0-100>,
  "entry": <number | null>,
  "stopLoss": <number | null>,
  "takeProfit": <number | null>,
  "riskReward": <number | null>,
  "reasoning": "<2-3 sentences explaining the decision>",
  "strengths": ["<supporting factor>", "..."],
  "weaknesses": ["<risk or opposing factor>", "..."],
  "marketBias": "BULLISH" | "BEARISH" | "NEUTRAL"
}`;
}

function noTrade(
  ctx:     MarketContext,
  reason:  string,
  conf     = 0,
  verdict: CandleVerdict = "WAIT",
): AiCandleDecision {
  const techCtx: Record<string, unknown> = {
    rsi14:    ctx.indicators.rsi14,  ema20:    ctx.indicators.ema20,
    ema50:    ctx.indicators.ema50,  ema200:   ctx.indicators.ema200,
    macdHist: ctx.indicators.macdHist, atr14:  ctx.indicators.atr14,
    vwap:     ctx.indicators.vwap,   relVol:   ctx.indicators.relativeVolume,
    trend:    ctx.structure.trendDirection,
    nearRes:  ctx.structure.nearestResistance,
    nearSup:  ctx.structure.nearestSupport,
    htfBias:  ctx.htf.bias, htfRsi: ctx.htf.rsi14, htfTrend: ctx.htf.trendDirection,
  };
  return {
    symbol: ctx.symbol, timeframe: ctx.timeframe, candleTime: ctx.candleTime,
    candidateSide: "no_trade", verdict, confidence: conf,
    entryPrice: null, slPrice: null, tpPrice: null,
    invalidationLevel: null, rrRatio: null,
    aiReasoning: reason,
    rejectionReason: verdict !== "WAIT" ? reason : null,
    newsSentiment: ctx.news.sentiment, newsSummary: ctx.news.summary,
    regime: ctx.regime, htfBias: ctx.htf.bias, session: ctx.session,
    patterns: ctx.candlestickPatterns,
    strengths: [], weaknesses: [],
    marketBias: ctx.htf.bias === "bullish" ? "bullish" : ctx.htf.bias === "bearish" ? "bearish" : "neutral",
    technicalContext: techCtx,
  };
}

export async function filterCandleWithAi(
  ctx:   MarketContext,
  stats: HistoricalSetupStats,
): Promise<AiCandleDecision> {
  const ollamaOk = await isOllamaAvailable();
  if (!ollamaOk) {
    return {
      ...noTrade(ctx, "Ollama is offline — defaulting to WAIT to protect capital."),
      memoryUsed: false, lessonsLoaded: 0, winnerAnalysisLoaded: false,
      failureStatsLoaded: false, recentLossLoaded: false, memoryImpactScore: 0,
      lessonsApplied: [],
    };
  }

  // Fetch all memory sources in parallel BEFORE the Ollama call
  const mem = await buildCandleMemoryContext(ctx);
  const memBase = {
    memoryUsed:           mem.memoryUsed,
    lessonsLoaded:        mem.lessons.length,
    winnerAnalysisLoaded: mem.winnerAnalysisLoaded,
    failureStatsLoaded:   mem.failureStatsLoaded,
    recentLossLoaded:     mem.recentLossLoaded,
  };
  // Deterministic technical baseline — used to detect memory-driven direction divergence
  const techBias = computeTechnicalBias(ctx);
  const techDir: "long" | "short" | "no_trade" =
    techBias === "bullish" ? "long" : techBias === "bearish" ? "short" : "no_trade";
  // mkMemDiag: builds final diagnostics object; diverged=true adds +10 to impact score
  const mkMemDiag = (diverged = false) => ({
    ...memBase,
    memoryImpactScore: computeMemoryImpactScore(mem, diverged),
    lessonsApplied:    mem.lessons,
  });

  const techCtx: Record<string, unknown> = {
    rsi14:    ctx.indicators.rsi14,  ema20:    ctx.indicators.ema20,
    ema50:    ctx.indicators.ema50,  ema200:   ctx.indicators.ema200,
    macdHist: ctx.indicators.macdHist, atr14:  ctx.indicators.atr14,
    vwap:     ctx.indicators.vwap,   relVol:   ctx.indicators.relativeVolume,
    trend:    ctx.structure.trendDirection,
    nearRes:  ctx.structure.nearestResistance,
    nearSup:  ctx.structure.nearestSupport,
    htfBias:  ctx.htf.bias, htfRsi: ctx.htf.rsi14, htfTrend: ctx.htf.trendDirection,
    regime:   ctx.regime,
  };

  let raw = "";
  try {
    raw = await ollamaGenerateWithFallback(
      buildMarketContextPrompt(ctx, stats, mem.memoryUsed ? mem.text : undefined),
      CANDLE_SYSTEM,
    );
  } catch (err) {
    logger.warn({ symbol: ctx.symbol, timeframe: ctx.timeframe, err }, "Ollama candle decision timed out");
    return { ...noTrade(ctx, "Ollama request timed out — defaulting to WAIT."), ...mkMemDiag() };
  }

  try {
    const p = parseJsonFromResponse(raw) as Record<string, unknown>;

    const rawDec    = typeof p.decision === "string" ? p.decision.toUpperCase() : "WAIT";
    const direction: "long" | "short" | "no_trade" =
      rawDec === "LONG" ? "long" : rawDec === "SHORT" ? "short" : "no_trade";

    // Divergence: AI picked a direction but deterministic baseline said the opposite.
    // This proxy indicates memory context likely influenced the final call.
    const diverged = techDir !== "no_trade" && direction !== "no_trade" && direction !== techDir;

    const conf = typeof p.confidence === "number"
      ? Math.max(0, Math.min(100, Math.round(p.confidence))) : 0;

    const entry      = typeof p.entry      === "number" ? p.entry      : null;
    const stopLoss   = typeof p.stopLoss   === "number" ? p.stopLoss   : null;
    const takeProfit = typeof p.takeProfit === "number" ? p.takeProfit : null;
    const risk       = entry !== null && stopLoss   !== null ? Math.abs(entry - stopLoss)   : null;
    const reward     = entry !== null && takeProfit !== null ? Math.abs(takeProfit - entry) : null;
    const rr         = risk && reward && risk > 0
      ? Math.round((reward / risk) * 100) / 100
      : typeof p.riskReward === "number" ? p.riskReward : null;

    const strengths  = Array.isArray(p.strengths)  ? (p.strengths  as string[]).slice(0, 6) : [];
    const weaknesses = Array.isArray(p.weaknesses) ? (p.weaknesses as string[]).slice(0, 6) : [];
    const biasRaw    = typeof p.marketBias === "string" ? p.marketBias.toLowerCase() : "neutral";
    const marketBias: "bullish" | "bearish" | "neutral" =
      biasRaw === "bullish" ? "bullish" : biasRaw === "bearish" ? "bearish" : "neutral";
    const reasoning  = typeof p.reasoning === "string" ? p.reasoning : "No reasoning provided.";

    // WAIT: Ollama itself decided WAIT
    if (direction === "no_trade") {
      return {
        symbol: ctx.symbol, timeframe: ctx.timeframe, candleTime: ctx.candleTime,
        candidateSide: "no_trade", verdict: "WAIT",
        confidence: conf, entryPrice: entry, slPrice: stopLoss, tpPrice: takeProfit,
        invalidationLevel: null, rrRatio: rr,
        aiReasoning: reasoning, rejectionReason: null,
        newsSentiment: ctx.news.sentiment, newsSummary: ctx.news.summary,
        regime: ctx.regime, htfBias: ctx.htf.bias, session: ctx.session,
        patterns: ctx.candlestickPatterns,
        strengths, weaknesses, marketBias, technicalContext: techCtx,
        ...mkMemDiag(diverged),
      };
    }

    // R:R gate: < 2.0 → WAIT
    if (rr !== null && rr < 2.0) {
      return {
        symbol: ctx.symbol, timeframe: ctx.timeframe, candleTime: ctx.candleTime,
        candidateSide: direction, verdict: "WAIT",
        confidence: conf, entryPrice: entry, slPrice: stopLoss, tpPrice: takeProfit,
        invalidationLevel: null, rrRatio: rr,
        aiReasoning: `R:R of ${rr.toFixed(2)} is below the 2.0 minimum — waiting for a better setup.`,
        rejectionReason: `R:R ${rr.toFixed(2)} < 2.0`,
        newsSentiment: ctx.news.sentiment, newsSummary: ctx.news.summary,
        regime: ctx.regime, htfBias: ctx.htf.bias, session: ctx.session,
        patterns: ctx.candlestickPatterns,
        strengths, weaknesses, marketBias, technicalContext: techCtx,
        ...mkMemDiag(diverged),
      };
    }

    // S/R proximity gates
    const dR = ctx.structure.distanceToResistancePct;
    const dS = ctx.structure.distanceToSupportPct;
    if (direction === "long" && dR !== null && dR < 0.5) {
      return {
        symbol: ctx.symbol, timeframe: ctx.timeframe, candleTime: ctx.candleTime,
        candidateSide: direction, verdict: "WAIT",
        confidence: conf, entryPrice: entry, slPrice: stopLoss, tpPrice: takeProfit,
        invalidationLevel: null, rrRatio: rr,
        aiReasoning: `LONG blocked — entry is within ${dR.toFixed(2)}% of resistance at ${ctx.structure.nearestResistance?.toFixed(4)}. Waiting for clear breakout.`,
        rejectionReason: `Near resistance (${dR.toFixed(2)}%)`,
        newsSentiment: ctx.news.sentiment, newsSummary: ctx.news.summary,
        regime: ctx.regime, htfBias: ctx.htf.bias, session: ctx.session,
        patterns: ctx.candlestickPatterns,
        strengths, weaknesses, marketBias, technicalContext: techCtx,
        ...mkMemDiag(diverged),
      };
    }
    if (direction === "short" && dS !== null && dS < 0.5) {
      return {
        symbol: ctx.symbol, timeframe: ctx.timeframe, candleTime: ctx.candleTime,
        candidateSide: direction, verdict: "WAIT",
        confidence: conf, entryPrice: entry, slPrice: stopLoss, tpPrice: takeProfit,
        invalidationLevel: null, rrRatio: rr,
        aiReasoning: `SHORT blocked — entry is within ${dS.toFixed(2)}% of support at ${ctx.structure.nearestSupport?.toFixed(4)}. Waiting for breakdown confirmation.`,
        rejectionReason: `Near support (${dS.toFixed(2)}%)`,
        newsSentiment: ctx.news.sentiment, newsSummary: ctx.news.summary,
        regime: ctx.regime, htfBias: ctx.htf.bias, session: ctx.session,
        patterns: ctx.candlestickPatterns,
        strengths, weaknesses, marketBias, technicalContext: techCtx,
        ...mkMemDiag(diverged),
      };
    }

    // Confidence → verdict
    const verdict: CandleVerdict =
      conf >= 80 ? "APPROVE" :
      conf >= 65 ? "WAIT"    : "REJECT";

    return {
      symbol: ctx.symbol, timeframe: ctx.timeframe, candleTime: ctx.candleTime,
      candidateSide: direction, verdict,
      confidence: conf, entryPrice: entry, slPrice: stopLoss, tpPrice: takeProfit,
      invalidationLevel: null, rrRatio: rr,
      aiReasoning: reasoning,
      rejectionReason: verdict === "REJECT" ? `Confidence too low (${conf}/100)` : null,
      newsSentiment: ctx.news.sentiment, newsSummary: ctx.news.summary,
      regime: ctx.regime, htfBias: ctx.htf.bias, session: ctx.session,
      patterns: ctx.candlestickPatterns,
      strengths, weaknesses, marketBias, technicalContext: techCtx,
      ...mkMemDiag(diverged),
    };
  } catch (parseErr) {
    logger.warn({ parseErr, raw, symbol: ctx.symbol }, "Candle decision JSON parse failed — WAIT");
    return { ...noTrade(ctx, "AI response could not be parsed — defaulting to WAIT."), ...mkMemDiag() };
  }
}

// ── Replay pass ───────────────────────────────────────────────────────────────
// Runs one Ollama call for the replay engine (no full AiCandleDecision needed).
// Called twice per historical candle: pass 1 without memory, pass 2 with memory.
// ─────────────────────────────────────────────────────────────────────────────
export async function runCandlePassForReplay(
  ctx:       MarketContext,
  stats:     HistoricalSetupStats,
  useMemory: boolean,
): Promise<{
  decision:   "LONG" | "SHORT" | "WAIT";
  confidence: number;
  entry:      number | null;
  stopLoss:   number | null;
  takeProfit: number | null;
  rr:         number | null;
  lessons:    string[];
  memoryUsed: boolean;
}> {
  let memBlock:  string | undefined;
  let lessons:   string[] = [];
  let memoryUsed = false;

  if (useMemory) {
    const mem = await buildCandleMemoryContext(ctx);
    if (mem.memoryUsed) {
      memBlock   = mem.text;
      lessons    = mem.lessons;
      memoryUsed = true;
    }
  }

  let raw = "";
  try {
    raw = await ollamaGenerateWithFallback(
      buildMarketContextPrompt(ctx, stats, memBlock),
      CANDLE_SYSTEM,
    );
  } catch {
    return { decision: "WAIT", confidence: 0, entry: null, stopLoss: null, takeProfit: null, rr: null, lessons, memoryUsed };
  }

  try {
    const p        = parseJsonFromResponse(raw) as Record<string, unknown>;
    const rawDec   = typeof p.decision === "string" ? p.decision.toUpperCase() : "WAIT";
    const decision: "LONG" | "SHORT" | "WAIT" =
      rawDec === "LONG" ? "LONG" : rawDec === "SHORT" ? "SHORT" : "WAIT";
    const confidence = typeof p.confidence === "number"
      ? Math.max(0, Math.min(100, Math.round(p.confidence))) : 0;
    const entry      = typeof p.entry      === "number" ? p.entry      : null;
    const stopLoss   = typeof p.stopLoss   === "number" ? p.stopLoss   : null;
    const takeProfit = typeof p.takeProfit === "number" ? p.takeProfit : null;
    const risk       = entry !== null && stopLoss   !== null ? Math.abs(entry - stopLoss)   : null;
    const reward     = entry !== null && takeProfit !== null ? Math.abs(takeProfit - entry) : null;
    const rr         = risk && reward && risk > 0
      ? Math.round((reward / risk) * 100) / 100
      : typeof p.riskReward === "number" ? (p.riskReward as number) : null;
    return { decision, confidence, entry, stopLoss, takeProfit, rr, lessons, memoryUsed };
  } catch {
    return { decision: "WAIT", confidence: 0, entry: null, stopLoss: null, takeProfit: null, rr: null, lessons, memoryUsed };
  }
}
