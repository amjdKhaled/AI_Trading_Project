// ============================================================
// Signal Combiner — Multi-Engine Decision System (Per-Bar Analysis)
// ============================================================

import type {
  OhlcvBar, PatternDetection, SignalCandidate,
  TradingSignal, Side, SignalGrade, RiskLevel,
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

// --- Price Action Detectors (per-bar) ---

function detectBreakoutRetest(bars: OhlcvBar[], i: number): { type: string; bullish: boolean } | null {
  if (i < 5) return null;
  const c = bars[i];
  const window = bars.slice(i - 5, i);
  const wh = Math.max(...window.map(b => b.high));
  const wl = Math.min(...window.map(b => b.low));
  const avgVol = window.reduce((s, b) => s + b.volume, 0) / 5;

  if (c.close > wh * 1.001 && c.volume > avgVol * 1.4) return { type: "breakout",  bullish: true };
  if (c.close < wl * 0.999 && c.volume > avgVol * 1.4) return { type: "breakdown", bullish: false };

  if (i >= 10) {
    const prev     = bars.slice(i - 10, i - 3);
    const prevHigh = Math.max(...prev.map(b => b.high));
    const prevLow  = Math.min(...prev.map(b => b.low));
    if (Math.abs(c.close - prevHigh) / (prevHigh || 1) < 0.004 && c.close > prevHigh * 0.997) {
      return { type: "retest-bullish", bullish: true };
    }
    if (Math.abs(c.close - prevLow) / (prevLow || 1) < 0.004 && c.close < prevLow * 1.003) {
      return { type: "retest-bearish", bullish: false };
    }
  }
  return null;
}

function detectConsolidation(bars: OhlcvBar[], i: number): { contracting: boolean; expanding: boolean } {
  if (i < 10) return { contracting: false, expanding: false };
  const early = bars.slice(i - 10, i - 5);
  const late  = bars.slice(i - 5, i);
  const eRange = Math.max(...early.map(b => b.high)) - Math.min(...early.map(b => b.low));
  const lRange = Math.max(...late.map(b => b.high))  - Math.min(...late.map(b => b.low));
  return {
    contracting: lRange < eRange * 0.65,
    expanding:   lRange > eRange * 1.50,
  };
}

// ================================================================
// Main Signal Generator
// ================================================================

export function generateSignals(
  bars: OhlcvBar[],
  symbol: string,
  timeframe: string,
): { signals: TradingSignal[]; candidates: SignalCandidate[] } {

  if (bars.length < 60) return { signals: [], candidates: [] };

  const candlePatterns = detectAllPatterns(bars);
  const chartPatterns  = detectChartPatterns(bars);
  const allPatterns    = [...candlePatterns, ...chartPatterns];

  const structure = analyzeStructure(bars);
  const { ema20, ema50, ema200, atrValues, rsiValues } = analyzeTrendMomentumVolatility(bars);

  const candidates: SignalCandidate[] = [];
  const lookback = Math.min(bars.length - 1, 300);
  const startIdx = bars.length - lookback;

  for (let i = startIdx; i < bars.length - 1; i++) {
    const bar = bars[i];

    // Per-bar indicator values (KEY FIX: use index i, not last bar)
    const e20i  = ema20[i]     || bar.close;
    const e50i  = ema50[i]     || bar.close;
    const e200i = ema200[i]    || bar.close;
    const atrI  = atrValues[i] || (bar.high - bar.low) || bar.close * 0.005;
    const rsiI  = rsiValues[i] ?? 50;

    const atrPct = atrI / (bar.close || 1);
    if (atrPct < 0.0005) continue;

    // Per-bar trend direction based on EMA alignment AT bar i
    const bullEmaAlign = bar.close > e20i && e20i > e50i;
    const bearEmaAlign = bar.close < e20i && e20i < e50i;
    const aboveEma50   = bar.close > e50i;
    const belowEma50   = bar.close < e50i;

    const trendStr  = Math.min(100, (Math.abs(bar.close - e20i) / atrI) * 30);
    const isExhBull = bullEmaAlign && rsiI > 78 && trendStr > 55;
    const isExhBear = bearEmaAlign && rsiI < 22 && trendStr > 55;

    const vol    = analyzeVolume(bars, i);
    const consol = detectConsolidation(bars, i);
    const pa     = detectBreakoutRetest(bars, i);

    const bullP = allPatterns.filter(p => p.type === "bullish" && p.index === i);
    const bearP = allPatterns.filter(p => p.type === "bearish" && p.index === i);

    const structBull = structure.regime === "uptrend"   || structure.lastChochDir === "bullish";
    const structBear = structure.regime === "downtrend" || structure.lastChochDir === "bearish";

    // ── BULLISH SCORE ─────────────────────────────────────────
    let bullScore = 0;

    bullP.forEach(p => { bullScore += p.confidence * 0.28; });

    // EMA alignment at bar i (the core per-bar fix)
    if (bullEmaAlign)    bullScore += trendStr > 45 ? 24 : 15;
    else if (aboveEma50) bullScore += 7;

    if (bar.close > e200i) bullScore += 4;

    // RSI in healthy zone for longs
    if      (rsiI >= 40 && rsiI <= 58) bullScore += 10;
    else if (rsiI >  30 && rsiI <  40) bullScore += 6;
    else if (rsiI <= 30)               bullScore += 4;
    else if (rsiI > 72)                bullScore -= 8;

    if      (vol.accumulation)                             bullScore += 12;
    else if (vol.breakoutVol && bar.close > bar.open)     bullScore += 10;
    else if (vol.spike       && bar.close > bar.open)     bullScore += 6;
    if (vol.rvol > 1.8) bullScore += 3;

    if (consol.contracting)               bullScore += 5;
    if (consol.expanding && bullEmaAlign) bullScore += 6;
    if (pa?.bullish)                      bullScore += 12;
    if (structBull)                       bullScore += 8;

    if (isExhBull)     bullScore -= 22;
    if (bearEmaAlign)  bullScore -= 12;
    if (vol.distribution) bullScore -= 5;

    // ── BEARISH SCORE ─────────────────────────────────────────
    let bearScore = 0;

    bearP.forEach(p => { bearScore += p.confidence * 0.28; });

    if (bearEmaAlign)    bearScore += trendStr > 45 ? 24 : 15;
    else if (belowEma50) bearScore += 7;

    if (bar.close < e200i) bearScore += 4;

    if      (rsiI >= 42 && rsiI <= 60) bearScore += 10;
    else if (rsiI >= 60 && rsiI <  72) bearScore += 6;
    else if (rsiI >= 72)               bearScore += 4;
    else if (rsiI < 28)                bearScore -= 8;

    if      (vol.distribution)                            bearScore += 12;
    else if (vol.breakoutVol && bar.close < bar.open)    bearScore += 10;
    else if (vol.spike       && bar.close < bar.open)    bearScore += 6;
    if (vol.rvol > 1.8) bearScore += 3;

    if (consol.contracting)                bearScore += 5;
    if (consol.expanding && bearEmaAlign)  bearScore += 6;
    if (pa && !pa.bullish)                 bearScore += 12;
    if (structBear)                        bearScore += 8;

    if (isExhBear)     bearScore -= 22;
    if (bullEmaAlign)  bearScore -= 12;
    if (vol.accumulation) bearScore -= 5;

    // ── GENERATE CANDIDATES (threshold: 78) ───────────────────
    if (bullScore >= 78) {
      const slice    = bars.slice(Math.max(0, i - 14), i + 1);
      const swingLow = Math.min(...slice.map(b => b.low));
      const sl       = swingLow - atrI * 0.25;
      const riskDist = Math.max(bar.close - sl, atrI * 0.4);
      const tp       = bar.close + riskDist * 2.5;
      const riskSc   = Math.min(100, atrPct * 600 + (riskDist / atrI) * 15);

      candidates.push({
        side: "long",
        barIndex: i,
        time: bar.time,
        entryPrice: bar.close,
        slPrice: sl,
        tpPrice: tp,
        confidence: Math.min(100, Math.round(bullScore)),
        grade: bullScore >= 100 ? "A+" : bullScore >= 88 ? "A" : "B",
        riskLevel: riskSc < 35 ? "Safe" : riskSc < 60 ? "Medium" : "Danger",
        riskScore: riskSc,
        patterns: bullP.map(p => p.name),
        structureConfirm: structBull,
        volumeConfirm: !!(vol.accumulation || vol.breakoutVol),
        trendConfirm: bullEmaAlign,
        momentumConfirm: rsiI < 65,
        candleConfirm: bar.close > bar.open,
        volatilityOk: !isExhBull,
      });
    }

    if (bearScore >= 78) {
      const slice     = bars.slice(Math.max(0, i - 14), i + 1);
      const swingHigh = Math.max(...slice.map(b => b.high));
      const sl        = swingHigh + atrI * 0.25;
      const riskDist  = Math.max(sl - bar.close, atrI * 0.4);
      const tp        = bar.close - riskDist * 2.5;
      const riskSc    = Math.min(100, atrPct * 600 + (riskDist / atrI) * 15);

      candidates.push({
        side: "short",
        barIndex: i,
        time: bar.time,
        entryPrice: bar.close,
        slPrice: sl,
        tpPrice: tp,
        confidence: Math.min(100, Math.round(bearScore)),
        grade: bearScore >= 100 ? "A+" : bearScore >= 88 ? "A" : "B",
        riskLevel: riskSc < 35 ? "Safe" : riskSc < 60 ? "Medium" : "Danger",
        riskScore: riskSc,
        patterns: bearP.map(p => p.name),
        structureConfirm: structBear,
        volumeConfirm: !!(vol.distribution || vol.breakoutVol),
        trendConfirm: bearEmaAlign,
        momentumConfirm: rsiI > 35,
        candleConfirm: bar.close < bar.open,
        volatilityOk: !isExhBear,
      });
    }
  }

  // Deduplicate: keep highest-confidence, enforce minimum bar gap
  const minGapSec = timeframe === "15m" ? 900 * 8 : 300 * 10;
  const sorted    = [...candidates].sort((a, b) => b.confidence - a.confidence);
  const deduped: SignalCandidate[] = [];
  const usedTimes = new Set<number>();

  for (const c of sorted) {
    let tooClose = false;
    for (const ut of usedTimes) {
      if (Math.abs(c.time - ut) < minGapSec) { tooClose = true; break; }
    }
    if (tooClose) continue;
    usedTimes.add(c.time);
    deduped.push(c);
  }

  // Most recent A+/A signals only, limited to 12
  const displayCandidates = deduped
    .filter(c => c.grade === "A+" || c.grade === "A")
    .sort((a, b) => b.time - a.time)
    .slice(0, 12);

  const signals: TradingSignal[] = displayCandidates.map(c => ({
    id: genId(),
    side: c.side,
    symbol,
    timeframe,
    barTime: c.time,
    entryPrice: Math.round(c.entryPrice * 100) / 100,
    slPrice:    Math.round(c.slPrice    * 100) / 100,
    tpPrice:    Math.round(c.tpPrice    * 100) / 100,
    confidence: Math.round(c.confidence),
    grade: c.grade,
    riskLevel: c.riskLevel,
    patterns: c.patterns.slice(0, 4),
    state: "active",
    createdAt: new Date().toISOString(),
  }));

  return { signals, candidates: deduped };
}
