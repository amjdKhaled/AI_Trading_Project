// ============================================================
// Signal Combiner — Regime-Aware Institutional Signal Engine
// ============================================================
// Design principles:
//  1. Regime filter: LONG only when not in strong downtrend, SHORT only when not in strong uptrend
//  2. Pullback entries: best longs = price touches EMA20 from above in uptrend; vice versa for shorts
//  3. Per-bar indicators: every EMA/RSI/MACD value uses the bar's own index
//  4. Minimum confirmations required before a signal fires
//  5. VWAP, Multi-timeframe bias, Market Regime, and Session Awareness modulate score & threshold
//  6. Full historical scan: every deduped candidate is returned (no top-N truncation)
// ============================================================

import type { OhlcvBar, SignalCandidate, TradingSignal } from "./types";
import { detectAllPatterns } from "./candlestick";
import { detectChartPatterns } from "./patterns";
import { analyzeStructure } from "./structure";
import { analyzeVolume } from "./volume";
import { analyzeTrendMomentumVolatility, emaArray } from "./trend";
import { vwapArray } from "./vwap";
import { classifyRegimes, type Regime } from "./regime";
import { sessionFor, type Session } from "./session";

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

// ── HTF Bias Builder ──────────────────────────────────────────────────────
// Builds a function that, given a 5m bar's epoch-seconds time, returns the
// 15m bias active at that time: "bull" | "bear" | "neutral".
//
// Bias is computed once per 15m bar from its own EMA stack:
//   bull    → close > e20 > e50 > e200
//   bear    → close < e20 < e50 < e200
//   neutral → mixed
function buildHtfBiasLookup(htfBars: OhlcvBar[]): (tSec: number) => "bull" | "bear" | "neutral" {
  if (htfBars.length === 0) return () => "neutral";
  const closes = htfBars.map(b => b.close);
  const e20    = emaArray(closes, 20);
  const e50    = emaArray(closes, 50);
  const e200   = emaArray(closes, 200);
  const bias: ("bull" | "bear" | "neutral")[] = htfBars.map((_, i) => {
    const c = closes[i];
    if (c > e20[i] && e20[i] > e50[i] && e50[i] > e200[i]) return "bull";
    if (c < e20[i] && e20[i] < e50[i] && e50[i] < e200[i]) return "bear";
    return "neutral";
  });

  // Binary search: find the most recent htfBar with time <= tSec
  return (tSec: number) => {
    let lo = 0, hi = htfBars.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (htfBars[mid].time <= tSec) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans >= 0 ? bias[ans] : "neutral";
  };
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
  vwapReclaim: boolean;
  side: "long" | "short";
}): string {
  if (opts.vwapReclaim)  return opts.side === "long" ? "VWAP Reclaim" : "VWAP Rejection";
  if (opts.pullback)     return opts.side === "long" ? "EMA20 Pullback" : "EMA20 Rejection";
  if (opts.breakout)     return opts.side === "long" ? "Breakout Candle" : "Breakdown Candle";
  if (opts.retest)       return opts.side === "long" ? "Support Retest"  : "Resistance Retest";
  if (opts.compression)  return opts.side === "long" ? "Compression Long" : "Compression Short";
  if (opts.volumeSpike && opts.emaAlignment) return opts.side === "long" ? "Volume Surge Long" : "Volume Surge Short";
  if (opts.macdCross)    return opts.side === "long" ? "MACD Crossover" : "MACD Reversal";
  if (opts.structConfirm && opts.emaAlignment) return opts.side === "long" ? "Trend Continuation" : "Trend Continuation Short";
  return opts.side === "long" ? "Momentum Long" : "Momentum Short";
}

// ── Per-regime / per-session score threshold ──────────────────────────────
// Institutional-grade filter: only A / A+ setups pass.
// High threshold + minimum confirmations keeps the chart sparse and readable.
function scoreThreshold(regime: Regime, session: Session): number {
  let t = 82;                                  // high base — only genuine setups
  if (regime === "chop")               t += 14; // 96: almost nothing fires in chop
  else if (regime === "ranging")       t += 6;  // 88: requires strong confirming signal
  else if (regime === "vol-expansion") t -= 4;  // 78: breakouts allowed earlier
  if (session === "midday")            t += 8;  // lunch chop = very few signals
  if (session === "open")              t -= 3;  // open-drive setups welcome
  return t;
}

// ══════════════════════════════════════════════════════════════════════════
// Main Signal Generator
// ══════════════════════════════════════════════════════════════════════════
export function generateSignals(
  bars: OhlcvBar[],
  symbol: string,
  timeframe: string,
  /** Higher-timeframe bars for multi-timeframe confirmation (e.g. 15m bars
   *  when generating 5m signals). Pass empty array or omit to disable HTF bias. */
  htfBars: OhlcvBar[] = [],
): { signals: TradingSignal[]; candidates: SignalCandidate[] } {

  if (bars.length < 80) return { signals: [], candidates: [] };

  const candlePatterns = detectAllPatterns(bars);
  const chartPatterns  = detectChartPatterns(bars);
  const allPatterns    = [...candlePatterns, ...chartPatterns];

  const structure = analyzeStructure(bars);
  const { ema20, ema50, ema200, atrValues, rsiValues, macdHist } =
    analyzeTrendMomentumVolatility(bars);

  // ── New analyzers ────────────────────────────────────────────────────
  const vwap    = vwapArray(bars);
  const regimes = classifyRegimes(bars, ema20, ema50, ema200, atrValues);
  const htfBias = buildHtfBiasLookup(htfBars);

  const candidates: SignalCandidate[] = [];
  // Full-history scan: every bar from index 80 onward is a candidate.
  // Earlier engine versions capped at 2000 bars; user wants ALL historical signals.
  const startIdx = 80;

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
    const vwapI     = vwap[i]      ?? bar.close;
    const vwapPrev  = vwap[i - 1]  ?? vwapI;
    const closePrev = bars[i - 1]?.close ?? bar.close;
    const regimeI   = regimes[i];
    const sessionI  = sessionFor(bar.time);
    const htfI      = htfBias(bar.time);

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

    // ── VWAP flags ───────────────────────────────────────────────────────
    const aboveVwap     = bar.close > vwapI;
    const belowVwap     = bar.close < vwapI;
    const vwapReclaim   = closePrev <= vwapPrev && bar.close > vwapI && bar.close > bar.open;
    const vwapRejection = closePrev >= vwapPrev && bar.close < vwapI && bar.close < bar.open;

    // ── Pullback quality ─────────────────────────────────────────────────
    const pullbackLong  = strongUptrend
      && bar.low  <= e20i * 1.003 && bar.close >= e20i * 0.996
      && bar.close > bar.open;
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

    const threshold = scoreThreshold(regimeI, sessionI);

    // ══════════════════════════════════════════════════════════════════════
    // LONG ANALYSIS
    // Hard-block against-trend longs in bear HTF AND confirmed downtrend.
    // Counter-trend setups against a strong HTF trend rarely survive SL.
    // ══════════════════════════════════════════════════════════════════════
    if (!strongDowntrend && htfI !== "bear") {
      let bullScore = 0;
      const reasons: string[] = [];

      bullP.forEach(p => { bullScore += p.confidence * 0.30; });

      if      (strongUptrend)  { bullScore += atrStr > 40 ? 26 : 16; }
      else if (bullEmaAlign)   { bullScore += atrStr > 40 ? 18 : 10; }
      else if (aboveEma50)     { bullScore += 6; }
      if (bar.close > e200i)   bullScore += 5;

      if (pullbackLong)        bullScore += 24;

      if      (rsiI >= 40 && rsiI <= 58) bullScore += 12;
      else if (rsiI >= 30 && rsiI <  40) bullScore += 7;
      else if (rsiI >= 58 && rsiI <= 68) bullScore += 5;
      else if (rsiI <  30)               bullScore += 4;
      else if (rsiI >  68)               bullScore -= 10;

      if      (macdAccBull)  bullScore += 10;
      else if (macdCrossBull) bullScore += 8;
      else if (macdBull)     bullScore += 5;
      else                   bullScore -= 5;

      if      (vol.accumulation)                        bullScore += 14;
      else if (vol.breakoutVol && bar.close > bar.open) bullScore += 12;
      else if (vol.spike && bar.close > bar.open)       bullScore += 7;
      if (vol.rvol > 2.0)                               bullScore += 4;

      if (consol.contracting)               bullScore += 6;
      if (consol.expanding && bullEmaAlign) bullScore += 7;

      if (pa?.bullish)   bullScore += 14;
      if (structBull)    bullScore += 10;

      // ── VWAP bonuses ──────────────────────────────────────────────────
      if (vwapReclaim) { bullScore += 14; reasons.push("VWAP Reclaim"); }
      else if (aboveVwap) bullScore += 4;
      else if (belowVwap) bullScore -= 6;

      // ── HTF bias ──────────────────────────────────────────────────────
      if (htfI === "bull") { bullScore += 12; reasons.push("15m Bull Aligned"); }

      // ── Regime / session modifiers ────────────────────────────────────
      if (regimeI === "trending-up")       { bullScore += 8;  reasons.push("Trending"); }
      else if (regimeI === "vol-expansion" && pa?.bullish) { bullScore += 6; reasons.push("Vol Expansion"); }
      else if (regimeI === "chop")         bullScore -= 6;

      if (sessionI === "power-hour" && (strongUptrend || pa?.bullish)) {
        bullScore += 5; reasons.push("Power Hour");
      }
      if (sessionI === "open" && pa?.bullish) { bullScore += 4; reasons.push("Open Drive"); }

      // ── Penalties ─────────────────────────────────────────────────────
      if (isExhBull)                           bullScore -= 28;
      if (bearEmaAlign)                        bullScore -= 15;
      if (vol.distribution)                    bullScore -= 8;
      if (vol.climax && bar.close > bar.open)  bullScore -= 10;

      const longConfirms = [
        structBull,
        bullEmaAlign || strongUptrend,
        vol.accumulation || vol.breakoutVol,
        rsiI > 30 && rsiI < 68,
        bar.close > bar.open,
        macdBull,
        pullbackLong || pa?.bullish === true,
        bullP.length > 0,
        aboveVwap || vwapReclaim,
        htfI === "bull",
      ].filter(Boolean).length;

      // Require 4+ confluence pillars + grade A minimum (score ≥ 88 = grade A).
      // This is the institutional filter — only clear, multi-factor setups fire.
      if (bullScore >= threshold && longConfirms >= 4 && bullScore >= 88) {
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
            vwapReclaim,
          }));
        }
        // Append regime/session/htf reasons after the primary trigger name
        patternNames.push(...reasons);

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
    // SHORT ANALYSIS
    // Hard-block against-trend shorts in bull HTF AND confirmed uptrend.
    // ══════════════════════════════════════════════════════════════════════
    if (!strongUptrend && htfI !== "bull") {
      let bearScore = 0;
      const reasons: string[] = [];

      bearP.forEach(p => { bearScore += p.confidence * 0.30; });

      if      (strongDowntrend) { bearScore += atrStr > 40 ? 26 : 16; }
      else if (bearEmaAlign)    { bearScore += atrStr > 40 ? 18 : 10; }
      else if (belowEma50)      { bearScore += 6; }
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

      // VWAP
      if (vwapRejection) { bearScore += 14; reasons.push("VWAP Rejection"); }
      else if (belowVwap) bearScore += 4;
      else if (aboveVwap) bearScore -= 6;

      // HTF
      if (htfI === "bear") { bearScore += 12; reasons.push("15m Bear Aligned"); }

      // Regime / session
      if (regimeI === "trending-down")     { bearScore += 8;  reasons.push("Trending"); }
      else if (regimeI === "vol-expansion" && pa && !pa.bullish) { bearScore += 6; reasons.push("Vol Expansion"); }
      else if (regimeI === "chop")         bearScore -= 6;

      if (sessionI === "power-hour" && (strongDowntrend || (pa && !pa.bullish))) {
        bearScore += 5; reasons.push("Power Hour");
      }
      if (sessionI === "open" && pa && !pa.bullish) { bearScore += 4; reasons.push("Open Drive"); }

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
        belowVwap || vwapRejection,
        htfI === "bear",
      ].filter(Boolean).length;

      // Same institutional filter for shorts.
      if (bearScore >= threshold && shortConfirms >= 4 && bearScore >= 88) {
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
            vwapReclaim: vwapRejection,
          }));
        }
        patternNames.push(...reasons);

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

  // ── Deduplication: wide gap = one best setup per impulse leg ─────────────
  // 5m: 10 bars = 50 min; 15m: 6 bars = 90 min.
  // Within any trending leg or consolidation, only the highest-score signal
  // survives — this prevents marker pileups on the same move.
  const minGapSec    = timeframe === "15m" ? 900 * 6 : 300 * 10;
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

  // Full history: return ALL deduped signals (no slice cap).
  // The caller / DB can apply its own limit if it wants only the recent N.
  const allDeduped = deduped.sort((a, b) => a.time - b.time);

  const signals: TradingSignal[] = allDeduped.map(c => ({
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
    patterns:   c.patterns.slice(0, 6),
    state:      "active",
    createdAt:  new Date().toISOString(),
  }));

  return { signals, candidates: allDeduped };
}
