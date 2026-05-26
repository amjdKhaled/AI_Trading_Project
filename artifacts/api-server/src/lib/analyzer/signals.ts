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
import { simulateLifecycle, MAX_HOLD_BARS } from "./lifecycle";
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

    // ── Overextension / bar quality (pre-filter, applies to both sides) ──────
    // 1. Vertical move: last 5 bars moved >2.5×ATR in one direction. Entering
    //    in the same direction is a classic late/chasing entry — almost always
    //    fails because the move is already exhausted.
    const move5      = bar.close - (bars[Math.max(0, i - 5)]?.close ?? bar.close);
    const isVertBull = move5 >  atrI * 2.5;  // spike up — don't long
    const isVertBear = move5 < -atrI * 2.5;  // spike down — don't short

    // 2. EMA20 distance: >1.8% from EMA20 = overextended. A quality pullback
    //    entry sits near EMA20, not far above/below it.
    const ema20Dist  = Math.abs(bar.close - e20i) / (e20i || bar.close);
    const farAboveEma = ema20Dist > 0.018 && bar.close > e20i;
    const farBelowEma = ema20Dist > 0.018 && bar.close < e20i;

    // 3. Bar body quality: a doji/spinning-top at entry = indecision. Not a
    //    good signal bar. (Hammer/shooting-star shapes are intentionally kept —
    //    they have directional meaning; the 0.18 threshold targets pure dojis.)
    const barRng    = bar.high - bar.low || 0.0001;
    const bodyRatio = Math.abs(bar.close - bar.open) / barRng;
    const isDoji    = bodyRatio < 0.18;

    // 4. Below-average volume = no conviction behind the move. Hard skip.
    if (vol.rvol < 0.75) continue;

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

      // RSI discipline: longs need RSI in a healthy pullback zone.
      // Entering a long at RSI 70+ is chasing overbought momentum.
      if      (rsiI >= 38 && rsiI <= 56) bullScore += 12;
      else if (rsiI >= 30 && rsiI <  38) bullScore += 7;
      else if (rsiI >= 56 && rsiI <= 63) bullScore += 4;
      else if (rsiI <  30)               bullScore -= 6;   // oversold ≠ momentum long
      else if (rsiI >= 63 && rsiI <  70) bullScore -= 14; // stretched — avoid
      else if (rsiI >= 70)               bullScore -= 28; // hard: overbought long = chasing

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
      // Overextension / late entry penalties
      if (isVertBull)   bullScore -= 30; // chasing a 5-bar vertical spike
      if (farAboveEma)  bullScore -= 18; // entry >1.8% above EMA20 = overextended
      if (isDoji)       bullScore -= 12; // indecisive bar = bad signal bar

      // ── SL / RR pre-check (computed before gate to allow early rejection) ──
      // Use 20-bar swing low (wider lookback than before = more robust level).
      // Enforce minimum 0.8 ATR SL distance (no noise stops) and
      // maximum 2.2 ATR SL distance (no wide stops that need huge TP to justify).
      const longSlice   = bars.slice(Math.max(0, i - 20), i + 1);
      const longSwingLow = Math.min(...longSlice.map(b => b.low));
      const longRawRisk  = Math.max(bar.close - (longSwingLow - atrI * 0.4), atrI * 0.8);
      const longBadRR    = longRawRisk > atrI * 2.2; // SL too wide → TP too far → low probability

      const longConfirms = [
        regimeI === "trending-up" || regimeI === "vol-expansion", // local regime is bullish
        bullEmaAlign || strongUptrend,                            // EMA stack aligned
        vol.accumulation || (vol.breakoutVol && vol.rvol > 1.2), // volume conviction > 1.2× avg
        rsiI >= 30 && rsiI <= 64,                                 // RSI in healthy bull zone
        bar.close > bar.open,                                     // bullish close
        macdBull,                                                 // momentum positive
        pullbackLong || pa?.bullish === true,                     // entry at pullback or retest
        bullP.length > 0,                                         // candlestick confirmation
        aboveVwap || vwapReclaim,                                 // price vs VWAP
        htfI === "bull",                                          // HTF timeframe aligned
      ].filter(Boolean).length;

      // Require 6+ confluence pillars (raised from 5) + hard score floor of 95.
      // Six independent confirmations from separate analysis dimensions = only
      // the cleanest, highest-conviction institutional setups. No mediocre entries.
      if (!longBadRR && bullScore >= threshold && longConfirms >= 6 && bullScore >= 95) {
        const sl       = bar.close - longRawRisk;
        const riskDist = longRawRisk;
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

      // RSI discipline: shorts need RSI in a healthy rejection zone.
      // Entering a short at RSI 30 or below is chasing oversold momentum.
      if      (rsiI >= 44 && rsiI <= 62) bearScore += 12;
      else if (rsiI >= 62 && rsiI <= 70) bearScore += 7;
      else if (rsiI >= 37 && rsiI <  44) bearScore += 4;
      else if (rsiI >  70)               bearScore -= 6;   // overbought ≠ momentum short
      else if (rsiI >= 30 && rsiI <  37) bearScore -= 14; // stretched — avoid
      else if (rsiI <  30)               bearScore -= 28; // hard: oversold short = chasing

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
      // Overextension / late entry penalties
      if (isVertBear)   bearScore -= 30; // chasing a 5-bar vertical drop
      if (farBelowEma)  bearScore -= 18; // entry >1.8% below EMA20 = overextended
      if (isDoji)       bearScore -= 12; // indecisive bar = bad signal bar

      // ── SL / RR pre-check for shorts ───────────────────────────────────
      const shortSlice    = bars.slice(Math.max(0, i - 20), i + 1);
      const shortSwingHigh = Math.max(...shortSlice.map(b => b.high));
      const shortRawRisk   = Math.max((shortSwingHigh + atrI * 0.4) - bar.close, atrI * 0.8);
      const shortBadRR     = shortRawRisk > atrI * 2.2;

      const shortConfirms = [
        regimeI === "trending-down" || regimeI === "vol-expansion", // local regime is bearish
        bearEmaAlign || strongDowntrend,                            // EMA stack aligned bear
        vol.distribution || (vol.breakoutVol && vol.rvol > 1.2),   // volume conviction
        rsiI >= 36 && rsiI <= 70,                                   // RSI in healthy bear zone
        bar.close < bar.open,                                       // bearish close
        macdBear,                                                   // momentum negative
        pullbackShort || (pa !== null && !pa.bullish),              // entry at rejection/retest
        bearP.length > 0,                                           // candlestick confirmation
        belowVwap || vwapRejection,                                 // price vs VWAP
        htfI === "bear",                                            // HTF timeframe aligned
      ].filter(Boolean).length;

      // Same six-pillar institutional filter for shorts.
      if (!shortBadRR && bearScore >= threshold && shortConfirms >= 6 && bearScore >= 95) {
        const sl       = bar.close + shortRawRisk;
        const riskDist = shortRawRisk;
        const tp       = bar.close - riskDist * 2.5;
        const riskSc   = Math.min(100, atrPct * 500 + (riskDist / atrI) * 12);

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

  // ── Deduplication: one best setup per session segment ────────────────────
  // 5m: 24 bars = 120 min (2 hours); 15m: 8 bars = 120 min.
  // This enforces at most one long and one short entry per major session
  // segment (open / midday / power-hour), eliminating repeated signals
  // during the same sustained move.
  const minGapSec    = timeframe === "15m" ? 900 * 8 : 300 * 24;
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

  // ── Sequential one-trade-at-a-time filter ─────────────────────────────
  // A professional trader never stacks entries while a trade is still open.
  // Walk the deduped candidates in chronological order; once a trade fires,
  // simulate its lifecycle and skip all candidates until that trade resolves.
  //
  // This is the most important filter for realistic trade simulation:
  //   ENTRY → trade active → TP/SL/expiry → next entry allowed
  //
  const barSec     = timeframe === "15m" ? 900 : 300;
  const maxHoldSec = MAX_HOLD_BARS * barSec;

  // O(1) bar lookup by time (bars are unique-per-time on OHLCV grids).
  const barTimeToIdx = new Map<number, number>();
  bars.forEach((b, i) => barTimeToIdx.set(b.time, i));

  const chronological = deduped.sort((a, b) => a.time - b.time);
  const sequential: typeof chronological = [];
  let nextAllowedTime = 0; // epoch-seconds; 0 = no active trade

  for (const c of chronological) {
    if (c.time < nextAllowedTime) continue; // current trade still open

    sequential.push(c);

    // Simulate this trade's lifecycle to find when it closes.
    const entryIdx = barTimeToIdx.get(c.time) ?? -1;
    if (entryIdx >= 0) {
      const lc = simulateLifecycle(
        bars, entryIdx, c.side as "long" | "short",
        c.entryPrice, c.slPrice, c.tpPrice,
      );
      // Block all new entries until one bar AFTER exit.
      // For unresolved (active) trades, block for the full hold window.
      nextAllowedTime = lc.exitBarTime
        ? lc.exitBarTime + barSec
        : c.time + maxHoldSec + barSec;
    }
  }

  const allDeduped = sequential; // rename for clarity below

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
