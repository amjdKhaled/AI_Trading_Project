// ============================================================
// Signal Combiner — Regime-Aware Institutional Signal Engine
// ============================================================
// Design principles:
//  1. Regime filter: LONG only when not in strong downtrend, SHORT only when not in strong uptrend
//  2. Pullback entries: best longs = price touches EMA20 from above in uptrend; vice versa for shorts
//  3. Per-bar indicators: every EMA/RSI/MACD value uses the bar's own index
//  4. Minimum 3 confirmations required before a signal fires
//  5. Threshold 82 + A+/A grade only = fewer, higher-quality signals
//  6. Descriptive trigger names so every signal has a readable label
// ============================================================

import type { OhlcvBar, SignalCandidate, TradingSignal } from "./types";
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

// ── Breakout / Retest Detector ─────────────────────────────────────────────
function detectBreakoutRetest(bars: OhlcvBar[], i: number) {
  if (i < 5) return null;
  const c   = bars[i];
  const win = bars.slice(i - 5, i);
  const wh  = Math.max(...win.map(b => b.high));
  const wl  = Math.min(...win.map(b => b.low));
  const av  = win.reduce((s, b) => s + b.volume, 0) / 5;

  if (c.close > wh * 1.001 && c.volume > av * 1.35) return { type: "breakout",  bullish: true  };
  if (c.close < wl * 0.999 && c.volume > av * 1.35) return { type: "breakdown", bullish: false };

  if (i >= 10) {
    const prev  = bars.slice(i - 10, i - 3);
    const prevH = Math.max(...prev.map(b => b.high));
    const prevL = Math.min(...prev.map(b => b.low));
    if (Math.abs(c.close - prevH) / (prevH || 1) < 0.004 && c.close > prevH * 0.997) return { type: "retest-bull", bullish: true  };
    if (Math.abs(c.close - prevL) / (prevL || 1) < 0.004 && c.close < prevL * 1.003) return { type: "retest-bear", bullish: false };
  }
  return null;
}

// ── Consolidation / Compression Detector ──────────────────────────────────
function detectConsolidation(bars: OhlcvBar[], i: number) {
  if (i < 10) return { contracting: false, expanding: false };
  const early = bars.slice(i - 10, i - 5);
  const late  = bars.slice(i - 5,  i);
  const eR    = Math.max(...early.map(b => b.high)) - Math.min(...early.map(b => b.low));
  const lR    = Math.max(...late.map(b => b.high))  - Math.min(...late.map(b => b.low));
  return { contracting: lR < eR * 0.65, expanding: lR > eR * 1.5 };
}

// ── Descriptive trigger name (when no candlestick pattern fires) ───────────
function buildTriggerName(opts: {
  pullback: boolean;
  breakout: boolean;
  retest: boolean;
  compression: boolean;
  volumeSpike: boolean;
  macdCross: boolean;
  emaAlignment: boolean;
  structConfirm: boolean;
  side: "long" | "short";
}): string {
  if (opts.pullback)     return opts.side === "long" ? "EMA20 Pullback" : "EMA20 Rejection";
  if (opts.breakout)     return opts.side === "long" ? "Breakout Candle" : "Breakdown Candle";
  if (opts.retest)       return opts.side === "long" ? "Support Retest"  : "Resistance Retest";
  if (opts.compression)  return opts.side === "long" ? "Compression Long" : "Compression Short";
  if (opts.volumeSpike && opts.emaAlignment) return opts.side === "long" ? "Volume Surge Long" : "Volume Surge Short";
  if (opts.macdCross)    return opts.side === "long" ? "MACD Crossover" : "MACD Reversal";
  if (opts.structConfirm && opts.emaAlignment) return opts.side === "long" ? "Trend Continuation" : "Trend Continuation Short";
  return opts.side === "long" ? "Momentum Long" : "Momentum Short";
}

// ══════════════════════════════════════════════════════════════════════════
// Main Signal Generator
// ══════════════════════════════════════════════════════════════════════════
export function generateSignals(
  bars: OhlcvBar[],
  symbol: string,
  timeframe: string,
): { signals: TradingSignal[]; candidates: SignalCandidate[] } {

  if (bars.length < 80) return { signals: [], candidates: [] };

  const candlePatterns = detectAllPatterns(bars);
  const chartPatterns  = detectChartPatterns(bars);
  const allPatterns    = [...candlePatterns, ...chartPatterns];

  const structure = analyzeStructure(bars);
  const { ema20, ema50, ema200, atrValues, rsiValues, macdHist } =
    analyzeTrendMomentumVolatility(bars);

  const candidates: SignalCandidate[] = [];
  // 2000-bar lookback ≈ 4 trading weeks on 5m; captures enough structure for full session analysis
  const lookback  = Math.min(bars.length - 2, 2000);
  const startIdx  = bars.length - lookback;

  for (let i = startIdx; i < bars.length - 1; i++) {
    const bar = bars[i];

    // ── Per-bar indicator values ──────────────────────────────────────────
    const e20i      = ema20[i]     ?? bar.close;
    const e50i      = ema50[i]     ?? bar.close;
    const e200i     = ema200[i]    ?? bar.close;
    const atrI      = atrValues[i] ?? Math.max(bar.high - bar.low, bar.close * 0.005);
    const rsiI      = rsiValues[i] ?? 50;
    const macdI     = macdHist[i]     ?? 0;
    const macdPrevI = macdHist[i - 1] ?? 0;

    // Skip bars with negligible range (illiquid / blended daily artefacts)
    const atrPct = atrI / (bar.close || 1);
    if (atrPct < 0.0005) continue;

    // ── Per-bar regime flags ─────────────────────────────────────────────
    const strongUptrend   = e20i > e50i && e50i > e200i && bar.close > e50i;
    const strongDowntrend = e20i < e50i && e50i < e200i && bar.close < e50i;
    const aboveEma20 = bar.close > e20i;
    const aboveEma50 = bar.close > e50i;
    const belowEma20 = bar.close < e20i;
    const belowEma50 = bar.close < e50i;
    const bullEmaAlign = aboveEma20 && aboveEma50;
    const bearEmaAlign = belowEma20 && belowEma50;

    // ── Pullback quality ─────────────────────────────────────────────────
    // Prime long entry: uptrend + price tags EMA20 from above + bullish close
    const pullbackLong  = strongUptrend
      && bar.low  <= e20i * 1.003 && bar.close >= e20i * 0.996
      && bar.close > bar.open;
    // Prime short entry: downtrend + price bounces up to EMA20 + bearish close
    const pullbackShort = strongDowntrend
      && bar.high >= e20i * 0.997 && bar.close <= e20i * 1.004
      && bar.close < bar.open;

    // ── MACD momentum flags ──────────────────────────────────────────────
    const macdCrossBull  = macdPrevI <= 0 && macdI > 0;
    const macdCrossBear  = macdPrevI >= 0 && macdI < 0;
    const macdAccBull    = macdI > 0 && macdI > macdPrevI;
    const macdAccBear    = macdI < 0 && macdI < macdPrevI;
    const macdBull       = macdI > 0 || macdCrossBull;
    const macdBear       = macdI < 0 || macdCrossBear;

    // ── Exhaustion ───────────────────────────────────────────────────────
    const atrStr      = Math.min(100, (Math.abs(bar.close - e20i) / atrI) * 30);
    const isExhBull   = rsiI > 80 && atrStr > 55;
    const isExhBear   = rsiI < 20 && atrStr > 55;

    // ── Context ──────────────────────────────────────────────────────────
    const vol    = analyzeVolume(bars, i);
    const consol = detectConsolidation(bars, i);
    const pa     = detectBreakoutRetest(bars, i);

    const bullP  = allPatterns.filter(p => p.type === "bullish" && p.index === i);
    const bearP  = allPatterns.filter(p => p.type === "bearish" && p.index === i);

    const structBull = structure.regime === "uptrend"   || structure.lastChochDir === "bullish";
    const structBear = structure.regime === "downtrend" || structure.lastChochDir === "bearish";

    // ══════════════════════════════════════════════════════════════════════
    // LONG ANALYSIS — skip entirely only in confirmed strong downtrend
    // ══════════════════════════════════════════════════════════════════════
    if (!strongDowntrend) {
      let bullScore = 0;

      // Candle patterns
      bullP.forEach(p => { bullScore += p.confidence * 0.30; });

      // EMA trend alignment
      if      (strongUptrend)  bullScore += atrStr > 40 ? 26 : 16;
      else if (bullEmaAlign)   bullScore += atrStr > 40 ? 18 : 10;
      else if (aboveEma50)     bullScore += 6;
      if (bar.close > e200i)   bullScore += 5;

      // Pullback entry bonus
      if (pullbackLong)        bullScore += 24;

      // RSI zone
      if      (rsiI >= 40 && rsiI <= 58) bullScore += 12;
      else if (rsiI >= 30 && rsiI <  40) bullScore += 7;
      else if (rsiI >= 58 && rsiI <= 68) bullScore += 5;
      else if (rsiI <  30)               bullScore += 4;
      else if (rsiI >  68)               bullScore -= 10;

      // MACD
      if      (macdAccBull)  bullScore += 10;
      else if (macdCrossBull) bullScore += 8;
      else if (macdBull)     bullScore += 5;
      else                   bullScore -= 5;

      // Volume
      if      (vol.accumulation)                        bullScore += 14;
      else if (vol.breakoutVol && bar.close > bar.open) bullScore += 12;
      else if (vol.spike && bar.close > bar.open)       bullScore += 7;
      if (vol.rvol > 2.0)                               bullScore += 4;

      // Consolidation / expansion
      if (consol.contracting)               bullScore += 6;
      if (consol.expanding && bullEmaAlign) bullScore += 7;

      // Breakout / retest
      if (pa?.bullish)   bullScore += 14;

      // Structure
      if (structBull)    bullScore += 10;

      // Penalties
      if (isExhBull)                           bullScore -= 28;
      if (bearEmaAlign)                        bullScore -= 15;
      if (vol.distribution)                    bullScore -= 8;
      if (vol.climax && bar.close > bar.open)  bullScore -= 10;

      // Minimum confirmations gate
      const longConfirms = [
        structBull,
        bullEmaAlign || strongUptrend,
        vol.accumulation || vol.breakoutVol,
        rsiI > 30 && rsiI < 68,
        bar.close > bar.open,
        macdBull,
        pullbackLong || pa?.bullish === true,
        bullP.length > 0,
      ].filter(Boolean).length;

      if (bullScore >= 75 && longConfirms >= 2) {
        const slice    = bars.slice(Math.max(0, i - 14), i + 1);
        const swingLow = Math.min(...slice.map(b => b.low));
        const sl       = swingLow - atrI * 0.3;
        const riskDist = Math.max(bar.close - sl, atrI * 0.5);
        const tp       = bar.close + riskDist * 2.5;
        const riskSc   = Math.min(100, atrPct * 500 + (riskDist / atrI) * 12);

        const patternNames = bullP.map(p => p.name);
        if (patternNames.length === 0) {
          patternNames.push(buildTriggerName({
            side: "long",
            pullback: pullbackLong,
            breakout: pa?.type === "breakout",
            retest:   pa?.type === "retest-bull",
            compression: consol.contracting,
            volumeSpike: vol.spike || vol.accumulation,
            macdCross: macdCrossBull,
            emaAlignment: bullEmaAlign || strongUptrend,
            structConfirm: structBull,
          }));
        }

        candidates.push({
          side: "long", barIndex: i, time: bar.time,
          entryPrice: bar.close, slPrice: sl, tpPrice: tp,
          confidence:       Math.min(100, Math.round(bullScore)),
          grade:            bullScore >= 100 ? "A+" : bullScore >= 88 ? "A" : "B",
          riskLevel:        riskSc < 33 ? "Safe" : riskSc < 58 ? "Medium" : "Danger",
          riskScore:        riskSc,
          patterns:         patternNames,
          structureConfirm: structBull,
          volumeConfirm:    !!(vol.accumulation || vol.breakoutVol),
          trendConfirm:     bullEmaAlign || strongUptrend,
          momentumConfirm:  rsiI < 65,
          candleConfirm:    bar.close > bar.open,
          volatilityOk:     !isExhBull,
        });
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // SHORT ANALYSIS — skip entirely only in confirmed strong uptrend
    // ══════════════════════════════════════════════════════════════════════
    if (!strongUptrend) {
      let bearScore = 0;

      bearP.forEach(p => { bearScore += p.confidence * 0.30; });

      if      (strongDowntrend) bearScore += atrStr > 40 ? 26 : 16;
      else if (bearEmaAlign)    bearScore += atrStr > 40 ? 18 : 10;
      else if (belowEma50)      bearScore += 6;
      if (bar.close < e200i)    bearScore += 5;

      if (pullbackShort)        bearScore += 24;

      if      (rsiI >= 42 && rsiI <= 60) bearScore += 12;
      else if (rsiI >= 60 && rsiI <= 70) bearScore += 7;
      else if (rsiI >= 32 && rsiI <  42) bearScore += 5;
      else if (rsiI >  70)               bearScore += 4;
      else if (rsiI <  32)               bearScore -= 10;

      if      (macdAccBear)   bearScore += 10;
      else if (macdCrossBear) bearScore += 8;
      else if (macdBear)      bearScore += 5;
      else                    bearScore -= 5;

      if      (vol.distribution)                        bearScore += 14;
      else if (vol.breakoutVol && bar.close < bar.open) bearScore += 12;
      else if (vol.spike && bar.close < bar.open)       bearScore += 7;
      if (vol.rvol > 2.0)                               bearScore += 4;

      if (consol.contracting)               bearScore += 6;
      if (consol.expanding && bearEmaAlign) bearScore += 7;

      if (pa && !pa.bullish)  bearScore += 14;
      if (structBear)         bearScore += 10;

      if (isExhBear)                           bearScore -= 28;
      if (bullEmaAlign)                        bearScore -= 15;
      if (vol.accumulation)                    bearScore -= 8;
      if (vol.climax && bar.close < bar.open)  bearScore -= 10;

      const shortConfirms = [
        structBear,
        bearEmaAlign || strongDowntrend,
        vol.distribution || vol.breakoutVol,
        rsiI > 32 && rsiI < 70,
        bar.close < bar.open,
        macdBear,
        pullbackShort || (pa !== null && !pa.bullish),
        bearP.length > 0,
      ].filter(Boolean).length;

      if (bearScore >= 75 && shortConfirms >= 2) {
        const slice     = bars.slice(Math.max(0, i - 14), i + 1);
        const swingHigh = Math.max(...slice.map(b => b.high));
        const sl        = swingHigh + atrI * 0.3;
        const riskDist  = Math.max(sl - bar.close, atrI * 0.5);
        const tp        = bar.close - riskDist * 2.5;
        const riskSc    = Math.min(100, atrPct * 500 + (riskDist / atrI) * 12);

        const patternNames = bearP.map(p => p.name);
        if (patternNames.length === 0) {
          patternNames.push(buildTriggerName({
            side: "short",
            pullback: pullbackShort,
            breakout: pa?.type === "breakdown",
            retest:   pa?.type === "retest-bear",
            compression: consol.contracting,
            volumeSpike: vol.spike || vol.distribution,
            macdCross: macdCrossBear,
            emaAlignment: bearEmaAlign || strongDowntrend,
            structConfirm: structBear,
          }));
        }

        candidates.push({
          side: "short", barIndex: i, time: bar.time,
          entryPrice: bar.close, slPrice: sl, tpPrice: tp,
          confidence:       Math.min(100, Math.round(bearScore)),
          grade:            bearScore >= 100 ? "A+" : bearScore >= 88 ? "A" : "B",
          riskLevel:        riskSc < 33 ? "Safe" : riskSc < 58 ? "Medium" : "Danger",
          riskScore:        riskSc,
          patterns:         patternNames,
          structureConfirm: structBear,
          volumeConfirm:    !!(vol.distribution || vol.breakoutVol),
          trendConfirm:     bearEmaAlign || strongDowntrend,
          momentumConfirm:  rsiI > 35,
          candleConfirm:    bar.close < bar.open,
          volatilityOk:     !isExhBear,
        });
      }
    }
  }

  // ── Deduplication: enforce minimum gap between same-side signals ─────────
  // 5m: 6 bars = 30 min minimum gap; 15m: 4 bars = 60 min minimum gap
  const minGapSec    = timeframe === "15m" ? 900 * 4 : 300 * 6;
  const sorted       = [...candidates].sort((a, b) => b.confidence - a.confidence);
  const usedByLong   = new Set<number>();
  const usedByShort  = new Set<number>();
  const deduped: SignalCandidate[] = [];

  for (const c of sorted) {
    const used = c.side === "long" ? usedByLong : usedByShort;
    let tooClose = false;
    for (const ut of used) {
      if (Math.abs(c.time - ut) < minGapSec) { tooClose = true; break; }
    }
    if (!tooClose) { used.add(c.time); deduped.push(c); }
  }

  // Keep the 20 best signals (A+, A, or B grade), sorted most-recent-first
  const bestCandidates = deduped
    .sort((a, b) => b.time - a.time)
    .slice(0, 20);

  const signals: TradingSignal[] = bestCandidates.map(c => ({
    id:         genId(),
    side:       c.side,
    symbol,
    timeframe,
    barTime:    c.time,
    entryPrice: Math.round(c.entryPrice * 100) / 100,
    slPrice:    Math.round(c.slPrice    * 100) / 100,
    tpPrice:    Math.round(c.tpPrice    * 100) / 100,
    confidence: Math.round(c.confidence),
    grade:      c.grade,
    riskLevel:  c.riskLevel,
    patterns:   c.patterns.slice(0, 4),
    state:      "active",
    createdAt:  new Date().toISOString(),
  }));

  return { signals, candidates: deduped };
}
