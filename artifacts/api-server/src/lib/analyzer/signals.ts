// ============================================================
// Signal Combiner — Multi-Engine Decision System
// ============================================================

import type {
  OhlcvBar, PatternDetection, SignalCandidate,
  TrendState, MomentumState, VolatilityState, VolumeAnalysis,
  StructurePoint, TradingSignal, Side, SignalGrade, RiskLevel,
} from "./types";
import { detectAllPatterns } from "./candlestick";
import { detectChartPatterns } from "./patterns";
import { analyzeStructure } from "./structure";
import { analyzeVolume } from "./volume";
import { analyzeTrendMomentumVolatility } from "./trend";

const ID_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function genId(): string {
  let s = "";
  for (let i = 0; i < 12; i++) s += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  return s;
}

// --- Price Action Detectors ---

function detectBreakoutRetest(bars: OhlcvBar[], i: number): { type: string; bullish: boolean } | null {
  if (i < 5) return null;
  const c = bars[i];
  const window = bars.slice(i - 5, i);
  const wh = Math.max(...window.map(b => b.high));
  const wl = Math.min(...window.map(b => b.low));
  if (c.close > wh * 1.001 && c.volume > window.reduce((s, b) => s + b.volume, 0) / 5 * 1.5) {
    return { type: "breakout", bullish: true };
  }
  if (c.close < wl * 0.999 && c.volume > window.reduce((s, b) => s + b.volume, 0) / 5 * 1.5) {
    return { type: "breakdown", bullish: false };
  }
  // Retest: price returns to broken level
  const prevWh = Math.max(...bars.slice(Math.max(0, i - 10), i - 3).map(b => b.high));
  if (Math.abs(c.close - prevWh) / (c.close || 1) < 0.005 && bars[i - 1].close < prevWh && c.close > prevWh * 0.995) {
    return { type: "retest-bullish", bullish: true };
  }
  return null;
}

function detectConsolidationExpansion(bars: OhlcvBar[], i: number): { expanding: boolean; contracting: boolean } {
  if (i < 10) return { expanding: false, contracting: false };
  const early = bars.slice(i - 10, i - 5);
  const late = bars.slice(i - 5, i);
  const eRange = Math.max(...early.map(b => b.high)) - Math.min(...early.map(b => b.low));
  const lRange = Math.max(...late.map(b => b.high)) - Math.min(...late.map(b => b.low));
  return {
    expanding: lRange > eRange * 1.5,
    contracting: lRange < eRange * 0.6,
  };
}

// --- Main Signal Generator ---

export function generateSignals(
  bars: OhlcvBar[],
  symbol: string,
  timeframe: string,
): { signals: TradingSignal[]; candidates: SignalCandidate[]; analysis: {
  patterns: PatternDetection[];
  structure: ReturnType<typeof analyzeStructure>;
  trend: TrendState;
  momentum: MomentumState;
  volatility: VolatilityState;
  lastVolume: VolumeAnalysis;
} } {

  if (bars.length < 50) return { signals: [], candidates: [], analysis: { patterns: [], structure: { points: [], regime: "ranging", bosCount: 0, chochCount: 0, lastBosDir: null, lastChochDir: null }, trend: { direction: "sideways", strength: 0, emaAligned: false, pullbackQuality: 50, exhaustion: false }, momentum: { rsi: 50, macdHist: 0, divergence: "none", hiddenDivergence: "none", accelerating: false, strength: 50 }, volatility: { atr: 0, expanding: false, contracting: false, compression: false, breakoutProbability: 50 }, lastVolume: { rvol: 1, spike: false, climax: false, absorption: false, breakoutVol: false, distribution: false, accumulation: false } } };

  // Run all engines
  const candlePatterns = detectAllPatterns(bars);
  const chartPatterns = detectChartPatterns(bars);
  const allPatterns = [...candlePatterns, ...chartPatterns];
  const structure = analyzeStructure(bars);
  const { trend, momentum, volatility, ema20, atrValues } = analyzeTrendMomentumVolatility(bars);
  const lastVol = analyzeVolume(bars, bars.length - 1);

  const candidates: SignalCandidate[] = [];
  const lookback = Math.min(bars.length, 200);

  for (let i = bars.length - lookback; i < bars.length; i++) {
    const bar = bars[i];
    const vol = analyzeVolume(bars, i);
    const ce = detectBreakoutRetest(bars, i);
    const ceState = detectConsolidationExpansion(bars, i);

    // --- Bullish confluence scoring ---
    let bullScore = 0;
    const bullPatterns = allPatterns.filter(p => p.type === "bullish" && p.index === i);
    bullPatterns.forEach(p => bullScore += p.confidence * 0.25);

    // Structure confirmation
    const structConfirmBull = structure.regime === "uptrend" || structure.lastChochDir === "bullish";
    if (structConfirmBull) bullScore += 12;

    // Trend confirmation
    const trendConfirmBull = trend.direction === "up" && trend.strength > 30;
    if (trendConfirmBull) bullScore += 15;
    if (trend.emaAligned && trend.direction === "up") bullScore += 8;
    if (trend.exhaustion) bullScore -= 15; // avoid exhaustion entries

    // Momentum confirmation
    const momConfirmBull = momentum.divergence === "bullish" || momentum.hiddenDivergence === "bullish";
    if (momConfirmBull) bullScore += 12;
    if (momentum.rsi > 30 && momentum.rsi < 70) bullScore += 5; // not overbought
    if (momentum.accelerating && momentum.macdHist > 0) bullScore += 8;

    // Volume confirmation
    const volConfirmBull = vol.spike || vol.breakoutVol || vol.accumulation;
    if (volConfirmBull) bullScore += 8;
    if (lastVol.rvol > 1.5) bullScore += 4;

    // Volatility OK
    const volOk = !volatility.expanding || volatility.compression;
    if (volOk) bullScore += 5;
    if (volatility.compression && ceState.expanding) bullScore += 10; // compression -> expansion

    // Candle confirmation
    const candleBull = bar.close > bar.open && (bar.close - bar.low) > (bar.high - bar.close) * 1.2;
    if (candleBull) bullScore += 5;

    // Price action
    if (ce?.bullish) bullScore += 10;

    // --- Bearish confluence scoring ---
    let bearScore = 0;
    const bearPatterns = allPatterns.filter(p => p.type === "bearish" && p.index === i);
    bearPatterns.forEach(p => bearScore += p.confidence * 0.25);

    const structConfirmBear = structure.regime === "downtrend" || structure.lastChochDir === "bearish";
    if (structConfirmBear) bearScore += 12;

    const trendConfirmBear = trend.direction === "down" && trend.strength > 30;
    if (trendConfirmBear) bearScore += 15;
    if (trend.emaAligned && trend.direction === "down") bearScore += 8;
    if (trend.exhaustion) bearScore -= 15;

    const momConfirmBear = momentum.divergence === "bearish" || momentum.hiddenDivergence === "bearish";
    if (momConfirmBear) bearScore += 12;
    if (momentum.rsi > 30 && momentum.rsi < 70) bearScore += 5;
    if (momentum.accelerating && momentum.macdHist < 0) bearScore += 8;

    const volConfirmBear = vol.spike || vol.breakoutVol || vol.distribution;
    if (volConfirmBear) bearScore += 8;

    if (volOk) bearScore += 5;
    if (volatility.compression && ceState.expanding) bearScore += 10;

    const candleBear = bar.close < bar.open && (bar.high - bar.open) > (bar.close - bar.low) * 1.2;
    if (candleBear) bearScore += 5;
    if (ce && !ce.bullish) bearScore += 10;

    // --- Generate candidate only if score high enough ---
    const atrVal = atrValues[i] || (bar.high - bar.low);
    const emaVal = ema20[i] || bar.close;

    // Only generate on confirmed candle (i is the close)
    // Anti-chop: require decent ATR relative to price
    const atrPct = atrVal / (bar.close || 1);
    if (atrPct < 0.0008) continue; // skip dead/low-vol periods

    if (bullScore >= 65) {
      const sl = Math.min(bar.low, emaVal - atrVal * 1.5);
      const tp = bar.close + (bar.close - sl) * 2.0;
      const riskDist = bar.close - sl;
      const riskScore = Math.min(100, (atrPct * 1000) + (1 / (riskDist / (bar.close || 1) + 0.001)) * 20);

      candidates.push({
        side: "long",
        barIndex: i,
        time: bar.time,
        entryPrice: bar.close,
        slPrice: sl,
        tpPrice: tp,
        confidence: Math.min(100, bullScore),
        grade: bullScore >= 85 ? "A+" : bullScore >= 70 ? "A" : "B",
        riskLevel: riskScore < 30 ? "Safe" : riskScore < 55 ? "Medium" : "Danger",
        riskScore,
        patterns: bullPatterns.map(p => p.name),
        structureConfirm: structConfirmBull,
        volumeConfirm: volConfirmBull,
        trendConfirm: trendConfirmBull,
        momentumConfirm: momConfirmBull,
        candleConfirm: candleBull,
        volatilityOk: volOk,
      });
    }

    if (bearScore >= 65) {
      const sl = Math.max(bar.high, emaVal + atrVal * 1.5);
      const tp = bar.close - (sl - bar.close) * 2.0;
      const riskDist = sl - bar.close;
      const riskScore = Math.min(100, (atrPct * 1000) + (1 / (riskDist / (bar.close || 1) + 0.001)) * 20);

      candidates.push({
        side: "short",
        barIndex: i,
        time: bar.time,
        entryPrice: bar.close,
        slPrice: sl,
        tpPrice: tp,
        confidence: Math.min(100, bearScore),
        grade: bearScore >= 85 ? "A+" : bearScore >= 70 ? "A" : "B",
        riskLevel: riskScore < 30 ? "Safe" : riskScore < 55 ? "Medium" : "Danger",
        riskScore,
        patterns: bearPatterns.map(p => p.name),
        structureConfirm: structConfirmBear,
        volumeConfirm: volConfirmBear,
        trendConfirm: trendConfirmBear,
        momentumConfirm: momConfirmBear,
        candleConfirm: candleBear,
        volatilityOk: volOk,
      });
    }
  }

  // --- Deduplicate: keep only best candidate per bar, and best within 5 bars ---
  const deduped: SignalCandidate[] = [];
  const usedTimes = new Set<number>();
  // Sort by confidence desc
  const sorted = [...candidates].sort((a, b) => b.confidence - a.confidence);
  for (const c of sorted) {
    // Skip if within 5 bars of an already accepted signal
    let tooClose = false;
    for (const ut of usedTimes) {
      const minGap = timeframe === "1d" ? 86400 * 5 : timeframe === "1w" ? 604800 * 3 : 300 * 5;
      if (Math.abs(c.time - ut) < minGap) {
        tooClose = true; break;
      }
    }
    if (tooClose) continue;
    usedTimes.add(c.time);
    deduped.push(c);
  }

  // --- Filter to A+/A only for display ---
  const displayCandidates = deduped.filter(c => c.grade === "A+" || c.grade === "A");

  // --- Convert to TradingSignal ---
  const signals: TradingSignal[] = displayCandidates.slice(0, 20).map(c => ({
    id: genId(),
    side: c.side,
    symbol,
    timeframe,
    barTime: c.time,
    entryPrice: Math.round(c.entryPrice * 100) / 100,
    slPrice: Math.round(c.slPrice * 100) / 100,
    tpPrice: Math.round(c.tpPrice * 100) / 100,
    confidence: Math.round(c.confidence),
    grade: c.grade,
    riskLevel: c.riskLevel,
    patterns: c.patterns.slice(0, 5),
    state: "active",
    createdAt: new Date().toISOString(),
  }));

  return {
    signals,
    candidates: deduped,
    analysis: {
      patterns: allPatterns.slice(-50),
      structure,
      trend,
      momentum,
      volatility,
      lastVolume: lastVol,
    },
  };
}
