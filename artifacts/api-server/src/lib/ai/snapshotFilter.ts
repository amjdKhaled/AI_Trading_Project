// ============================================================
// Snapshot Filter — AI BUY / SELL / WAIT decision from a
// pure technical MarketSnapshot (no memory context loaded).
// ============================================================
// Hard rules (applied after Ollama):
//   • confidence < 75 → WAIT
//   • RR < 1.8        → WAIT
//   • BUY within 0.5 % of nearest resistance → WAIT
//   • SELL within 0.5 % of nearest support   → WAIT
//   • relativeVolume < 0.6                   → WAIT
// ============================================================

import { ollamaGenerateWithFallback, isOllamaAvailable, parseJsonFromResponse } from "./ollama.js";
import { logger } from "../logger.js";
import type { MarketSnapshot } from "../analyzer/marketSnapshot.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export type SnapshotDecisionType = "BUY" | "SELL" | "WAIT";
export type SnapshotGrade       = "A+" | "A" | "B" | "C" | "WAIT";

export interface SnapshotDecision {
  decision:   SnapshotDecisionType;
  confidence: number;
  reason:     string;
  entry:      number | null;
  sl:         number | null;
  tp:         number | null;
  rr:         number | null;
  grade:      SnapshotGrade;
  strengths:  string[];
  weaknesses: string[];
}

// ── Prompt builder ─────────────────────────────────────────────────────────────

const SYSTEM = `You are an institutional trading analyst with 20 years of experience. You evaluate intraday setups with strict discipline. Respond ONLY with a valid JSON object — no preamble, no markdown, no explanation outside the JSON.`;

function fmt(n: number | null | undefined, dp = 2): string {
  return n != null ? n.toFixed(dp) : "N/A";
}

function buildSnapshotPrompt(s: MarketSnapshot): string {
  const { indicators: ind, structure, supportResistance: sr } = s;
  const price = s.currentBar.close;

  const obTxt = s.orderBlocks.length > 0
    ? s.orderBlocks.map(o => `${o.type.toUpperCase()} OB ${fmt(o.low)}-${fmt(o.high)}${o.inZone ? " ★IN ZONE" : ""}`).join(", ")
    : "none";

  const fvgTxt = s.fairValueGaps.length > 0
    ? s.fairValueGaps.map(f => `${f.type.toUpperCase()} FVG ${fmt(f.low)}-${fmt(f.high)}${f.inZone ? " ★IN ZONE" : ""}${f.filled ? " (filled)" : ""}`).join(", ")
    : "none";

  const fibTxt = s.fibonacci
    ? `38.2%=${fmt(s.fibonacci.fib382)}, 50%=${fmt(s.fibonacci.fib500)}, 61.8%=${fmt(s.fibonacci.fib618)}`
    : "N/A";

  const pivots = s.pivotPoints;
  const htfTxt = s.htf
    ? `${s.htf.timeframe} bias=${s.htf.bias.toUpperCase()}, EMA20=${fmt(s.htf.ema20)}, EMA50=${fmt(s.htf.ema50)}`
    : "N/A (insufficient HTF data)";

  const { volume: vol, trend, momentum, volatility } = s;
  const volState = vol.spike ? "SPIKE" : vol.rvol > 1.2 ? "ELEVATED" : vol.rvol < 0.8 ? "LOW" : "NORMAL";
  const volCtx   = [
    vol.climax       ? "climax"       : null,
    vol.absorption   ? "absorption"   : null,
    vol.breakoutVol  ? "breakout-vol" : null,
    vol.accumulation ? "accumulation" : null,
    vol.distribution ? "distribution" : null,
  ].filter(Boolean).join(", ") || "none";
  const trendStr    = `dir=${trend.direction} strength=${trend.strength}/100 emaAligned=${trend.emaAligned} exhaustion=${trend.exhaustion}`;
  const momStr      = `rsi=${fmt(momentum.rsi, 1)} macdHist=${fmt(momentum.macdHist)} div=${momentum.divergence} accel=${momentum.accelerating}`;
  const volStr      = `atr=${fmt(volatility.atr)} expanding=${volatility.expanding} contracting=${volatility.contracting} boProbability=${volatility.breakoutProbability}%`;

  return `Analyze this ${s.symbol} ${s.timeframe} candle and give a BUY, SELL, or WAIT decision.

═══ CURRENT BAR (${new Date(s.candleTime * 1000).toISOString()}) ═══
  Symbol: ${s.symbol}  Timeframe: ${s.timeframe}  Session: ${s.session.toUpperCase()}
  O=${fmt(s.currentBar.open)} H=${fmt(s.currentBar.high)} L=${fmt(s.currentBar.low)} C=${fmt(price)}
  Regime: ${s.regime.toUpperCase()}   HTF Context: ${htfTxt}

═══ TECHNICAL INDICATORS ═══
  RSI(14)=${fmt(ind.rsi14, 1)}   ATR(14)=${fmt(ind.atr14)}   RelVol=${fmt(ind.relativeVolume, 2)}x
  EMA20=${fmt(ind.ema20)}  EMA50=${fmt(ind.ema50)}  EMA200=${fmt(ind.ema200)}
  MACD Line=${fmt(ind.macdLine)}  Signal=${fmt(ind.macdSignal)}  Hist=${fmt(ind.macdHist)}
  VWAP=${fmt(ind.vwap)}  (price ${price > ind.vwap ? "ABOVE" : "BELOW"} VWAP)
  BB Upper=${fmt(ind.bbUpper)}  Lower=${fmt(ind.bbLower)}  Width=${fmt(ind.bbWidth, 2)}%

═══ MARKET STRUCTURE ═══
  Trend: ${structure.regime.toUpperCase()}   BOS count: ${structure.bosCount}   CHOCH count: ${structure.chochCount}
  Last BOS dir: ${structure.lastBosDir ?? "none"}   Last CHOCH dir: ${structure.lastChochDir ?? "none"}
  Last swing high: ${fmt(structure.lastSwingHigh)}   Last swing low: ${fmt(structure.lastSwingLow)}

═══ KEY LEVELS ═══
  Resistance: ${sr.resistanceLevels.slice(0, 3).map(l => fmt(l)).join(", ") || "none"}
  Support:    ${sr.supportLevels.slice(0, 3).map(l => fmt(l)).join(", ") || "none"}
  Nearest resistance: ${fmt(sr.nearestResistance)} (${fmt(sr.distToResistancePct, 2)}% away)
  Nearest support:    ${fmt(sr.nearestSupport)} (${fmt(sr.distToSupportPct, 2)}% away)
  Pivot PP=${fmt(pivots.pp)}  R1=${fmt(pivots.r1)}  R2=${fmt(pivots.r2)}  S1=${fmt(pivots.s1)}  S2=${fmt(pivots.s2)}
  Fibonacci: ${fibTxt}

═══ VOLUME & PATTERNS ═══
  Volume state: ${volState}   rvol=${fmt(vol.rvol, 2)}x   Context: ${volCtx}
  Candlestick patterns: ${s.candlestickPatterns.join(", ") || "none"}
  Chart patterns:       ${s.chartPatterns.join(", ") || "none"}

═══ SMART MONEY CONCEPTS ═══
  Order Blocks: ${obTxt}
  Fair Value Gaps: ${fvgTxt}

═══ TREND / MOMENTUM / VOLATILITY ═══
  Trend: ${trendStr}
  Momentum: ${momStr}
  Volatility: ${volStr}

═══ DECISION RULES (non-negotiable) ═══
- Only trade with HTF bias alignment (or neutral). Counter-HTF trades are low-probability.
- BUY requires: EMA stack bullish, price above VWAP, RSI 40-70, relVol > 0.8, no nearby resistance within 0.5%
- SELL requires: EMA stack bearish, price below VWAP, RSI 30-60, relVol > 0.8, no nearby support within 0.5%
- WAIT if: choppy regime, low volume (relVol < 0.6), extended RSI (>75 for BUY, <25 for SELL), conflicting signals
- Entry = current close; SL = below recent swing low (BUY) or above recent swing high (SELL); TP = next key level
- Minimum R:R = 1.8; confidence threshold = 75 (below this, output WAIT)
- Grade: A+ (conf≥90, RR≥3.0), A (conf≥85, RR≥2.5), B (conf≥80, RR≥2.0), C (conf≥75, RR≥1.8), WAIT otherwise

Respond with ONLY this JSON object (no extra text):
{
  "decision": "BUY" | "SELL" | "WAIT",
  "confidence": <integer 0-100>,
  "reason": "<concise 1-2 sentence rationale>",
  "entry": <number or null>,
  "sl": <number or null>,
  "tp": <number or null>,
  "rr": <number or null>,
  "grade": "A+" | "A" | "B" | "C" | "WAIT",
  "strengths": ["<string>"],
  "weaknesses": ["<string>"]
}`;
}

// ── Hard-rule post-processor ──────────────────────────────────────────────────

function applyHardRules(
  raw: SnapshotDecision,
  snapshot: MarketSnapshot,
): SnapshotDecision {
  const { decision, confidence, rr } = raw;
  const price = snapshot.currentBar.close;
  const sr    = snapshot.supportResistance;

  if (decision === "WAIT") return { ...raw, grade: "WAIT" };

  // Low volume gate
  if (snapshot.indicators.relativeVolume < 0.6) {
    return { ...raw, decision: "WAIT", grade: "WAIT", reason: "Low relative volume — waiting for participation." };
  }

  // Confidence gate
  if (confidence < 75) {
    return { ...raw, decision: "WAIT", grade: "WAIT", reason: `Confidence ${confidence} below 75 threshold.` };
  }

  // RR gate
  if (!rr || rr < 1.8) {
    return { ...raw, decision: "WAIT", grade: "WAIT", reason: `R:R ${rr?.toFixed(2) ?? "N/A"} below minimum 1.8.` };
  }

  // BUY too close to resistance
  if (decision === "BUY" && sr.nearestResistance !== null) {
    const distPct = ((sr.nearestResistance - price) / price) * 100;
    if (distPct < 0.5) {
      return { ...raw, decision: "WAIT", grade: "WAIT", reason: `BUY rejected — nearest resistance ${distPct.toFixed(2)}% away (< 0.5%).` };
    }
  }

  // SELL too close to support
  if (decision === "SELL" && sr.nearestSupport !== null) {
    const distPct = ((price - sr.nearestSupport) / price) * 100;
    if (distPct < 0.5) {
      return { ...raw, decision: "WAIT", grade: "WAIT", reason: `SELL rejected — nearest support ${distPct.toFixed(2)}% away (< 0.5%).` };
    }
  }

  // Grade
  let grade: SnapshotGrade = "C";
  if      (confidence >= 90 && rr >= 3.0) grade = "A+";
  else if (confidence >= 85 && rr >= 2.5) grade = "A";
  else if (confidence >= 80 && rr >= 2.0) grade = "B";
  else if (confidence >= 75 && rr >= 1.8) grade = "C";

  return { ...raw, grade };
}

// ── Main export ────────────────────────────────────────────────────────────────

const WAIT_DECISION: SnapshotDecision = {
  decision:   "WAIT",
  confidence: 0,
  reason:     "Ollama not available.",
  entry:      null,
  sl:         null,
  tp:         null,
  rr:         null,
  grade:      "WAIT",
  strengths:  [],
  weaknesses: [],
};

export async function filterCandleWithSnapshot(
  snapshot: MarketSnapshot,
): Promise<SnapshotDecision> {
  // Pre-gate: Ollama offline
  const ollamaOk = await isOllamaAvailable();
  if (!ollamaOk) {
    logger.warn({ symbol: snapshot.symbol }, "snapshotFilter: Ollama offline — returning WAIT");
    return WAIT_DECISION;
  }

  // Pre-gate: low volume (skip Ollama call entirely)
  if (snapshot.indicators.relativeVolume < 0.4) {
    return {
      ...WAIT_DECISION,
      reason: "Pre-gate: very low relative volume — no Ollama call made.",
    };
  }

  const prompt = buildSnapshotPrompt(snapshot);

  try {
    const rawStr = await ollamaGenerateWithFallback(prompt, SYSTEM, 800);
    const parsed = parseJsonFromResponse(rawStr) as Record<string, unknown>;

    const decision: SnapshotDecision = {
      decision:   (["BUY", "SELL", "WAIT"].includes(String(parsed.decision)) ? parsed.decision : "WAIT") as SnapshotDecisionType,
      confidence: typeof parsed.confidence === "number" ? Math.min(100, Math.max(0, parsed.confidence)) : 0,
      reason:     typeof parsed.reason === "string" ? parsed.reason : "No reason provided.",
      entry:      typeof parsed.entry === "number" ? parsed.entry : null,
      sl:         typeof parsed.sl === "number" ? parsed.sl : null,
      tp:         typeof parsed.tp === "number" ? parsed.tp : null,
      rr:         typeof parsed.rr === "number" ? parsed.rr : null,
      grade:      "WAIT",
      strengths:  Array.isArray(parsed.strengths) ? (parsed.strengths as unknown[]).filter(s => typeof s === "string") as string[] : [],
      weaknesses: Array.isArray(parsed.weaknesses) ? (parsed.weaknesses as unknown[]).filter(s => typeof s === "string") as string[] : [],
    };

    return applyHardRules(decision, snapshot);
  } catch (err) {
    logger.error({ err, symbol: snapshot.symbol }, "snapshotFilter: parse error — returning WAIT");
    return {
      ...WAIT_DECISION,
      reason: "Ollama response parse error.",
    };
  }
}
