// ============================================================
// AI Decision Engine — Ollama as the final trading decision maker
// ============================================================
// Receives all technical context for the most recent bar and asks
// the local Ollama model to decide: BUY, SELL, or NO_TRADE.
// The AI calculates its own entry, SL, and TP based on ATR and
// market structure — no hardcoded levels.
// ============================================================

import { ollamaGenerateWithFallback, parseJsonFromResponse } from "./ollama.js";
import {
  getRecentLessonsFromDb,
  getSymbolStatsFromDb,
  getWinnerLoserSummary,
  getFailureCategoryStats,
  getMostRecentLossReasoning,
  type LessonWithContext,
} from "./shared-memory.js";
import { snapshotRegime } from "./regime-tracker.js";
import { loadMemory } from "./memory.js";
import { findSimilarPatterns, formatSimilarityContext } from "./similarity.js";
import { logger } from "../logger.js";
import { analyzeTrendMomentumVolatility, emaArray } from "../analyzer/trend.js";
import { analyzeStructure } from "../analyzer/structure.js";
import { detectAllPatterns } from "../analyzer/candlestick.js";
import { classifyRegimes } from "../analyzer/regime.js";
import { vwapArray } from "../analyzer/vwap.js";
import { sessionFor } from "../analyzer/session.js";
import type { OhlcvBar } from "../analyzer/types.js";
import type { AiDecision } from "./types.js";

const SYSTEM = `You are a professional institutional prop-firm trader with 20 years of experience in equity and futures markets. You behave like a disciplined discretionary trader — you take fewer, higher-quality trades, not many low-quality ones.

You analyze all provided market data and return a trading decision: BUY, SELL, or NO_TRADE.

Rules you always follow:
- Choose NO_TRADE if confidence is below 65 or market conditions are mixed
- Calculate entry, stop loss, and take profit precisely using ATR and structure
- BUY: stopLoss MUST be below entry; takeProfit MUST be above entry
- SELL: stopLoss MUST be above entry; takeProfit MUST be below entry
- Target minimum R:R of 1.5, prefer 2.0 or higher
- Never force a trade — quality over quantity
- You respond ONLY with valid JSON — no preamble, no explanation outside the JSON`;

interface DecisionInput {
  symbol: string;
  timeframe: string;
  bar: OhlcvBar;
  regime: string;
  session: string;
  atr: number;
  rsi: number;
  macd: number;
  vwapVal: number;
  e20: number;
  e50: number;
  e200: number;
  htfBias: string;
  recentPatterns: string[];
  swingHighs: number[];
  swingLows: number[];
  recentBars: Array<{ t: string; o: string; h: string; l: string; c: string; v: number }>;
  recentLessons: LessonWithContext[];
  symbolStats: { wins: number; losses: number; total: number } | undefined;
  similarityContext: string;
  winnerLoserSummary: string;
  failureCategoryStats: string;
  mostRecentLossReasoning: string;
}

function buildDecisionPrompt(d: DecisionInput): string {
  const price  = d.bar.close;
  const date   = new Date(d.bar.time * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const atrPct = ((d.atr / price) * 100).toFixed(2);

  const vwapDiff = ((price - d.vwapVal) / (d.vwapVal || 1) * 100).toFixed(2);
  const e20Diff  = ((price - d.e20)     / (d.e20     || 1) * 100).toFixed(2);
  const e50Diff  = ((price - d.e50)     / (d.e50     || 1) * 100).toFixed(2);

  const trend =
    price > d.e20 && d.e20 > d.e50 && d.e50 > d.e200 ? "STRONG UPTREND (price > EMA20 > EMA50 > EMA200)" :
    price < d.e20 && d.e20 < d.e50 && d.e50 < d.e200 ? "STRONG DOWNTREND (price < EMA20 < EMA50 < EMA200)" :
    price > d.e20 && d.e20 > d.e50                    ? "UPTREND (price > EMA20 > EMA50)" :
    price < d.e20 && d.e20 < d.e50                    ? "DOWNTREND (price < EMA20 < EMA50)" :
    "MIXED / SIDEWAYS — high NO_TRADE probability";

  const rsiBias =
    d.rsi > 70 ? "OVERBOUGHT (caution on longs)" :
    d.rsi > 60 ? "BULLISH MOMENTUM" :
    d.rsi < 30 ? "OVERSOLD (caution on shorts)" :
    d.rsi < 40 ? "BEARISH MOMENTUM" : "NEUTRAL";

  const resistanceStr = d.swingHighs.length > 0
    ? d.swingHighs.map(p => p.toFixed(2)).join(", ")
    : "none detected";
  const supportStr = d.swingLows.length > 0
    ? d.swingLows.map(p => p.toFixed(2)).join(", ")
    : "none detected";

  const suggestedBuySL  = (price - d.atr * 1.5).toFixed(2);
  const suggestedBuyTP  = (price + d.atr * 3.0).toFixed(2);
  const suggestedSellSL = (price + d.atr * 1.5).toFixed(2);
  const suggestedSellTP = (price - d.atr * 3.0).toFixed(2);

  const memCtx = d.symbolStats && d.symbolStats.total >= 3
    ? `${d.symbol}: ${d.symbolStats.wins}W/${d.symbolStats.losses}L of ${d.symbolStats.total} trades (${Math.round(d.symbolStats.wins / d.symbolStats.total * 100)}% WR)`
    : "No sufficient trade history for this symbol yet.";

  // ── Structured lessons with reasoning (BUG-2 fixed: symbol+regime filtered) ──
  const lessonsText = d.recentLessons.length > 0
    ? d.recentLessons.slice(0, 6).map(l => {
        const badge = l.outcome === "tp_hit" ? "[WIN]" : "[LOSS]";
        const snip  = l.reasoning && l.reasoning.length > 0
          ? ` — "${l.reasoning.slice(0, 90)}${l.reasoning.length > 90 ? "…" : ""}"`
          : "";
        return `  • ${badge} ${l.lesson}${snip}`;
      }).join("\n")
    : "  No lessons stored yet.";

  const barsTable = d.recentBars
    .map(b => `  ${b.t}  O:${b.o}  H:${b.h}  L:${b.l}  C:${b.c}  Vol:${b.v}`)
    .join("\n");

  // ── Pattern analysis block (F2) ────────────────────────────
  const patternBlock = d.winnerLoserSummary
    ? `\nPATTERN ANALYSIS (${d.symbol} · ${d.regime}):\n  ${d.winnerLoserSummary}`
    : "";

  // ── Failure category stats block (F3) ─────────────────────
  const failureBlock = d.failureCategoryStats
    ? `\nFAILURE CATEGORY BREAKDOWN (${d.regime} regime losses):\n  ${d.failureCategoryStats}`
    : "";

  // ── Most recent loss reasoning (F5) ───────────────────────
  const lossReasoningBlock = d.mostRecentLossReasoning
    ? `\nMOST RECENT LOSS ANALYSIS:\n  "${d.mostRecentLossReasoning.slice(0, 200)}${d.mostRecentLossReasoning.length > 200 ? "…" : ""}"`
    : "";

  return `Analyze ${d.symbol} on ${d.timeframe} timeframe and make a precise trading decision.

MARKET CONTEXT:
  Time: ${date}
  Session: ${d.session.toUpperCase()} | Regime: ${d.regime}
  Trend: ${trend}
  HTF Bias (higher timeframe EMA stack): ${d.htfBias.toUpperCase()}

INDICATORS (most recent bar):
  Price: ${price.toFixed(2)} | ATR: ${d.atr.toFixed(2)} (${atrPct}% of price)
  EMA20: ${d.e20.toFixed(2)} (${e20Diff}% from price)
  EMA50: ${d.e50.toFixed(2)} (${e50Diff}% from price)
  EMA200: ${d.e200.toFixed(2)}
  VWAP: ${d.vwapVal.toFixed(2)} — price is ${Math.abs(parseFloat(vwapDiff)).toFixed(2)}% ${parseFloat(vwapDiff) >= 0 ? "ABOVE" : "BELOW"} VWAP
  RSI(14): ${d.rsi.toFixed(1)} — ${rsiBias}
  MACD Histogram: ${d.macd.toFixed(4)} (${d.macd > 0 ? "positive/bullish" : "negative/bearish"})

CANDLESTICK PATTERNS (last 5 bars):
  ${d.recentPatterns.length > 0 ? d.recentPatterns.join(", ") : "None detected"}

MARKET STRUCTURE:
  Nearest resistance levels: ${resistanceStr}
  Nearest support levels: ${supportStr}

LAST 10 BARS (oldest → newest):
${barsTable}

SL/TP REFERENCE (place on structure, not blindly at these levels):
  If BUY:  suggested SL = ${suggestedBuySL} (1.5x ATR below), TP = ${suggestedBuyTP} (3x ATR above)
  If SELL: suggested SL = ${suggestedSellSL} (1.5x ATR above), TP = ${suggestedSellTP} (3x ATR below)

MEMORY & LESSONS (${d.symbol} · ${d.regime} · most recent first):
  ${memCtx}
${lessonsText}${patternBlock}${failureBlock}${lossReasoningBlock}

HISTORICAL PATTERN SIMILARITY:
${d.similarityContext}

Decision criteria:
- BUY: trend up, price above VWAP/EMA20, RSI 40-65, pullback or breakout, HTF aligned or neutral
- SELL: trend down, price below VWAP/EMA20, RSI 35-60, rejection or breakdown, HTF aligned or neutral
- NO_TRADE: mixed signals, midday chop, counter-trend, confidence < 65, no clear setup

Respond with JSON ONLY — no other text:
{
  "decision": "BUY | SELL | NO_TRADE",
  "confidence": 0-100,
  "entry": price_number,
  "stopLoss": price_number,
  "takeProfit": price_number,
  "riskReward": calculated_rr_ratio,
  "reasoning": "2-3 sentence explanation of the key factors driving this decision",
  "marketBias": "BULLISH | BEARISH | NEUTRAL"
}`;
}

export async function aiDecide(params: {
  symbol: string;
  timeframe: string;
  bars: OhlcvBar[];
  htfBars?: OhlcvBar[];
}): Promise<AiDecision> {
  const { symbol, timeframe, bars, htfBars = [] } = params;

  if (bars.length < 80) {
    throw new Error("Insufficient bars for AI analysis (need ≥ 80)");
  }

  // ── Compute all technical indicators ─────────────────────────
  const { ema20, ema50, ema200, atrValues, rsiValues, macdHist } =
    analyzeTrendMomentumVolatility(bars);
  const vwap        = vwapArray(bars);
  const { points: structurePoints, lastSwingHigh, lastSwingLow } = analyzeStructure(bars);
  const regimes  = classifyRegimes(bars, ema20, ema50, ema200, atrValues);
  const patterns = detectAllPatterns(bars);

  // Use bar[n-2] to avoid lookahead on the still-forming current bar
  const lastIdx = bars.length - 2;
  const bar     = bars[lastIdx];

  const regime  = regimes[lastIdx]  ?? "ranging";
  const session = sessionFor(bar.time);
  const atr     = atrValues[lastIdx] ?? bar.close * 0.005;
  const rsi     = rsiValues[lastIdx] ?? 50;
  const macd    = macdHist[lastIdx]  ?? 0;
  const vwapVal = vwap[lastIdx]      ?? bar.close;
  const e20     = ema20[lastIdx]     ?? bar.close;
  const e50     = ema50[lastIdx]     ?? bar.close;
  const e200    = ema200[lastIdx]    ?? bar.close;

  // ── Recent candlestick patterns (last 5 bars) ─────────────────
  const recentPatterns = patterns
    .filter(p => p.index >= lastIdx - 5)
    .map(p => p.name);

  // ── Swing highs (resistance) and lows (support) near price ───
  const price = bar.close;
  const swingHighs = structurePoints
    .filter(p => (p.type === "HH" || p.type === "swing-high") && p.price > price)
    .slice(-3)
    .map(p => p.price)
    .sort((a: number, b: number) => a - b);
  if (swingHighs.length === 0 && lastSwingHigh > price) swingHighs.push(lastSwingHigh);

  const swingLows = structurePoints
    .filter(p => (p.type === "LL" || p.type === "swing-low") && p.price < price)
    .slice(-3)
    .map(p => p.price)
    .sort((a: number, b: number) => b - a);
  if (swingLows.length === 0 && lastSwingLow < price) swingLows.push(lastSwingLow);

  // ── HTF bias from 15m bars (EMA20 vs EMA50) ──────────────────
  let htfBias = "neutral";
  if (htfBars.length >= 20) {
    const htfCloses = htfBars.map(b => b.close);
    const htfE20    = emaArray(htfCloses, 20);
    const htfE50    = emaArray(htfCloses, Math.min(50, htfBars.length - 1));
    const li        = htfBars.length - 1;
    const c         = htfCloses[li];
    if (c > htfE20[li] && htfE20[li] > htfE50[li]) htfBias = "bull";
    else if (c < htfE20[li] && htfE20[li] < htfE50[li]) htfBias = "bear";
  }

  // ── Derive candidate side from HTF bias (BUG-3 fix) ──────────
  // Used for similarity lookup — was previously hardcoded to "long"
  const candidateSide: "long" | "short" =
    htfBias === "bear" ? "short" :
    htfBias === "bull" ? "long" :
    e20 < e50          ? "short" : "long";

  // ── Regime snapshot (fire-and-forget) ────────────────────────
  void snapshotRegime({
    symbol, timeframe, regime, htfBias,
    atr, rsi, macd,
    vwapDiff: (bar.close - vwapVal) / (vwapVal || 1) * 100,
  }).catch(() => { /* non-critical — never block the decision */ });

  // ── Memory context — all fetches in parallel ──────────────────
  const [
    recentLessons,
    symbolStats,
    similarMatches,
    winnerLoserSummary,
    failureCategoryStats,
    mostRecentLossReasoning,
  ] = await Promise.all([
    getRecentLessonsFromDb(symbol, regime, 6).catch(() => {
      const mem = loadMemory();
      return mem.recentLessons.slice(0, 6).map(lesson => ({ lesson, outcome: "unknown" as const }));
    }),
    getSymbolStatsFromDb(symbol).catch(() => {
      const mem = loadMemory();
      return mem.symbolStats[symbol];
    }),
    findSimilarPatterns({
      symbol,
      regime,
      side: candidateSide,
      strategy: "ai_decision",
      patternTags: recentPatterns,
      session,
    }).catch(() => []),
    getWinnerLoserSummary(symbol, regime).catch(() => ""),
    getFailureCategoryStats(symbol, regime).catch(() => ""),
    getMostRecentLossReasoning(symbol).catch(() => ""),
  ]);

  const similarityContext = formatSimilarityContext(similarMatches);

  // ── Last 10 bars formatted for the prompt ─────────────────────
  const recentBars = bars.slice(Math.max(0, lastIdx - 9), lastIdx + 1).map(b => ({
    t: new Date(b.time * 1000).toISOString().slice(11, 16),
    o: b.open.toFixed(2),
    h: b.high.toFixed(2),
    l: b.low.toFixed(2),
    c: b.close.toFixed(2),
    v: Math.round(b.volume),
  }));

  const prompt = buildDecisionPrompt({
    symbol, timeframe, bar, regime, session, atr, rsi, macd,
    vwapVal, e20, e50, e200, htfBias,
    recentPatterns, swingHighs, swingLows,
    recentBars, recentLessons, symbolStats,
    similarityContext,
    winnerLoserSummary,
    failureCategoryStats,
    mostRecentLossReasoning,
  });

  logger.info(
    { symbol, timeframe, session, regime, price: bar.close.toFixed(2), atr: atr.toFixed(2), candidateSide },
    "AI decision requested",
  );

  // 800 tokens gives the model room to reason + produce valid JSON
  const raw = await ollamaGenerateWithFallback(prompt, SYSTEM, 800);

  // ── Parse and validate the AI response ───────────────────────
  try {
    const parsed = parseJsonFromResponse(raw) as Partial<AiDecision>;

    const decision: AiDecision["decision"] =
      (["BUY", "SELL", "NO_TRADE"] as const).includes(parsed.decision as never)
        ? (parsed.decision as AiDecision["decision"])
        : "NO_TRADE";

    const entry = typeof parsed.entry === "number" ? parsed.entry : bar.close;
    let sl      = typeof parsed.stopLoss   === "number" ? parsed.stopLoss   : entry;
    let tp      = typeof parsed.takeProfit === "number" ? parsed.takeProfit : entry;

    // Enforce directional correctness — the model occasionally flips SL/TP
    if (decision === "BUY") {
      if (sl >= entry) sl = parseFloat((entry - atr * 1.5).toFixed(4));
      if (tp <= entry) tp = parseFloat((entry + atr * 3.0).toFixed(4));
    } else if (decision === "SELL") {
      if (sl <= entry) sl = parseFloat((entry + atr * 1.5).toFixed(4));
      if (tp >= entry) tp = parseFloat((entry - atr * 3.0).toFixed(4));
    }

    const computedRR = Math.abs(tp - entry) / (Math.abs(entry - sl) || 0.001);

    return {
      decision,
      confidence: typeof parsed.confidence === "number"
        ? Math.max(0, Math.min(100, parsed.confidence)) : 50,
      entry,
      stopLoss:   sl,
      takeProfit: tp,
      riskReward: typeof parsed.riskReward === "number"
        ? parsed.riskReward : Math.round(computedRR * 100) / 100,
      reasoning: typeof parsed.reasoning === "string"
        ? parsed.reasoning : raw.slice(0, 300),
      marketBias: (["BULLISH", "BEARISH", "NEUTRAL"] as const).includes(parsed.marketBias as never)
        ? (parsed.marketBias as AiDecision["marketBias"]) : "NEUTRAL",
    };
  } catch (parseErr) {
    logger.warn({ parseErr, raw: raw.slice(0, 200) }, "AI decision parse failed — NO_TRADE");
    return {
      decision:   "NO_TRADE",
      confidence: 0,
      entry:      bar.close,
      stopLoss:   bar.close,
      takeProfit: bar.close,
      riskReward: 0,
      reasoning:  "AI response could not be parsed — defaulting to NO_TRADE for safety",
      marketBias: "NEUTRAL",
    };
  }
}
