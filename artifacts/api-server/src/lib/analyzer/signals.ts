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
import { detectOrderBlocks } from "./orderblocks";
import { detectFVGs } from "./fvg";

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

// ── Trend Efficiency Ratio ─────────────────────────────────────────────────
// Perry Kaufman's Efficiency Ratio: |net displacement| / total path length.
// Measures how "directionally clean" price movement is over the last N bars.
//   ER > 0.55 = very clean trending move (institutional edge present)
//   ER < 0.20 = choppy, directionless — no sustainable edge regardless of
//               what other indicators say. Hard skip these bars entirely.
function efficiencyRatio(bars: OhlcvBar[], idx: number, n = 20): number {
  if (idx < n) return 0.5; // not enough bars — assume neutral
  const start = idx - n;
  const net   = Math.abs(bars[idx].close - bars[start].close);
  let   path  = 0;
  for (let j = start + 1; j <= idx; j++) {
    path += Math.abs(bars[j].close - bars[j - 1].close);
  }
  return path > 0 ? Math.min(1, net / path) : 0.5;
}

// ── HTF Bias Builder ──────────────────────────────────────────────────────
// Builds a function that, given a 5m bar's epoch-seconds time, returns the
// 15m bias active at that time: "bull" | "bear" | "neutral".
//
// Bias is computed once per 15m bar from its own EMA stack:
//   bull    → close > e20 > e50 > e200
//   bear    → close < e20 < e50 < e200
//   neutral → mixed
// ── Daily bias lookup (macro trend filter) ────────────────────────────────
// Determines whether the DAILY trend is bullish, bearish, or neutral at any
// given intraday timestamp. Uses EMA20 > EMA50 (price above both) for bull,
// EMA20 < EMA50 (price below both) for bear. Subtracted 4 h from tSec to
// avoid lookahead — daily bars close at 4pm ET; the daily bar for "today"
// should not influence signals fired at 9:30am of that same day.
function buildDailyBiasLookup(dailyBars: OhlcvBar[]): (tSec: number) => "bull" | "bear" | "neutral" {
  if (dailyBars.length === 0) return () => "neutral";
  const closes = dailyBars.map(b => b.close);
  const e20    = emaArray(closes, 20);
  const e50    = emaArray(closes, 50);
  const bias: ("bull" | "bear" | "neutral")[] = dailyBars.map((_, i) => {
    const c = closes[i];
    if (c > e20[i] && e20[i] > e50[i]) return "bull";
    if (c < e20[i] && e20[i] < e50[i]) return "bear";
    return "neutral";
  });
  return (tSec: number) => {
    // yfinance daily bars are timestamped at midnight ET (04:00 UTC summer / 05:00 UTC winter).
    // Subtracting 17 h pushes the earliest intraday bar (9:30 ET = 13:30 UTC) to 20:30 UTC
    // the PREVIOUS calendar day, safely below the 04:00 UTC bar boundary.
    // The latest intraday bar (4pm ET = 20:00 UTC) becomes 03:00 UTC — also before today's bar.
    // This guarantees we always use yesterday's confirmed close with zero lookahead.
    const lookupTs = tSec - 61_200; // 17 h → previous day's confirmed daily close
    let lo = 0, hi = dailyBars.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (dailyBars[mid].time <= lookupTs) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans >= 0 ? bias[ans] : "neutral";
  };
}

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

// ── Per-symbol volatility + behaviour profiles ────────────────────────────
// Accounts for the fact that TSLA and NVDA have different ATR profiles,
// pullback depths, and trend-persistence characteristics.
interface SymbolProfile {
  slAtrMult:        number; // SL max-width multiplier (applied to 1.8 ATR cap)
  momentumBonus:    number; // extra score for confirmed momentum setups
  pullbackAtrTol:   number; // how many ATR above EMA20 still counts as pullback
}
const SYMBOL_PROFILES: Record<string, SymbolProfile> = {
  TSLA: { slAtrMult: 1.0, momentumBonus: 0, pullbackAtrTol: 0.45 },
  NVDA: { slAtrMult: 1.1, momentumBonus: 5, pullbackAtrTol: 0.60 }, // wider pullbacks, vol bonus
  SPY:  { slAtrMult: 0.9, momentumBonus: 0, pullbackAtrTol: 0.35 },
  QQQ:  { slAtrMult: 0.9, momentumBonus: 0, pullbackAtrTol: 0.35 },
};
const DEFAULT_PROFILE: SymbolProfile = { slAtrMult: 1.0, momentumBonus: 0, pullbackAtrTol: 0.45 };

// ── Regime-adaptive score threshold ───────────────────────────────────────
// The score floor is NOT hardcoded at 97 anymore. Instead it adapts to the
// current market regime:
//   • trending:       lower bar — capture strong momentum participation
//   • ranging:        moderate bar — require clear setup against support/resistance
//   • chop:           high bar — almost nothing fires, only cleanest setups
//   • vol-expansion:  lower bar — breakout continuation allowed earlier
// Session overlays raise/lower the bar for time-of-day quality.
function scoreThreshold(regime: Regime, session: Session): number {
  let t = 91;                                       // base calibrated for momentum participation
  if      (regime === "trending-up" ||
           regime === "trending-down")  t -= 7;    // 84: trend regime — active momentum participation
  else if (regime === "vol-expansion")  t -= 9;    // 82: breakout regime — enter early
  else if (regime === "ranging")        t += 2;    // 93: sideways — require clear structure
  else if (regime === "chop")           t += 6;    // 97: directionless — very selective
  if (session === "midday")             t += 4;    // lunch chop — raise bar (but not as much)
  if (session === "open")               t -= 3;    // open-drive momentum — welcome
  if (session === "power-hour")         t -= 2;    // power hour — aggressive
  return t;
}

// ── Adaptive confluence requirement ───────────────────────────────────────
// Strong trends: 4 confirmations capture momentum participation.
// Pullback continuation in a trend is the highest-probability setup —
// it doesn't need 6 independent dimensions; 4 aligned confirmations suffice.
// Chop reversals: keep strict at 6+ — too many false signals in directionless tape.
function minConfluencePillars(regime: Regime): number {
  if (regime === "trending-up" || regime === "trending-down") return 4;
  if (regime === "vol-expansion")                             return 4;
  if (regime === "ranging")                                   return 5;
  return 6; // chop — full institutional standard
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
  /** Daily bars for macro trend filter. When the daily trend opposes the intraday
   *  direction the signal receives a heavy penalty — this addresses bear-rally longs
   *  and bull-pullback shorts that look valid on 5m/15m but fail at the macro level. */
  dailyBars: OhlcvBar[] = [],
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
  const htfBias   = buildHtfBiasLookup(htfBars);
  const dailyBias = buildDailyBiasLookup(dailyBars);
  const profile  = SYMBOL_PROFILES[symbol] ?? DEFAULT_PROFILE;

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
    const dayBiasI  = dailyBias(bar.time);

    // Skip bars with negligible range (illiquid / blended daily artefacts)
    const atrPct = atrI / (bar.close || 1);
    if (atrPct < 0.0005) continue;

    // ── Efficiency Ratio: hard skip + score modifiers ─────────────────────
    // Skip bars where price is truly directionless. The threshold is kept
    // conservative (0.12) because 5m bars naturally have ER 0.15–0.35 even
    // in solid trends; only the worst chop falls below 0.12.
    const efI     = efficiencyRatio(bars, i, 20);
    if (efI < 0.12) continue;
    const cleanER = efI > 0.50; // sustained directional momentum — reward
    const weakER  = efI < 0.17; // genuinely choppy range — small penalty

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

    // ── Pullback quality: ATR-relative EMA20 proximity ──────────────────
    // A professional momentum trader enters when price APPROACHES EMA20 in a trend,
    // not only when it touches it exactly. "Near EMA20" = within profile.pullbackAtrTol
    // ATR of it — adapts to each symbol's volatility.
    // TSLA (ATR ~$4): within $1.80 above EMA20. NVDA (ATR ~$22): within $13.
    const pullbackLong  = strongUptrend
      && bar.low  <= e20i + atrI * profile.pullbackAtrTol
      && bar.close >= e20i - atrI * 0.2
      && bar.close > bar.open;
    const pullbackShort = strongDowntrend
      && bar.high >= e20i - atrI * profile.pullbackAtrTol
      && bar.close <= e20i + atrI * 0.2
      && bar.close < bar.open;

    // ── Trend continuation patterns ───────────────────────────────────────
    // Higher low (bull): in uptrend, this bar's low exceeds the prior 5-bar swing low —
    // the classic "staircase" structure of a healthy uptrend.
    const prior5Lows    = bars.slice(Math.max(0, i - 5), i).map(b => b.low);
    const priorSwingLow = prior5Lows.length > 0 ? Math.min(...prior5Lows) : bar.low;
    const higherLowBull = strongUptrend && bar.low > priorSwingLow && bar.close > bar.open;

    // Lower high (bear): in downtrend, this bar's high is below the prior 5-bar swing high.
    const prior5Highs    = bars.slice(Math.max(0, i - 5), i).map(b => b.high);
    const priorSwingHigh = prior5Highs.length > 0 ? Math.max(...prior5Highs) : bar.high;
    const lowerHighBear  = strongDowntrend && bar.high < priorSwingHigh && bar.close < bar.open;

    // EMA reclaim (bull): price closed below EMA20 last bar, reclaims it this bar.
    // This is a high-probability continuation trigger: the mean acted as support.
    const emaReclaimBull = closePrev < e20i && bar.close > e20i * 1.001 && bar.close > bar.open;
    // EMA rejection (bear): price closed above EMA20 last bar, loses it this bar.
    const emaRejectionBear = closePrev > e20i && bar.close < e20i * 0.999 && bar.close < bar.open;

    // ── MACD momentum flags ──────────────────────────────────────────────
    const macdCrossBull  = macdPrevI <= 0 && macdI > 0;
    const macdCrossBear  = macdPrevI >= 0 && macdI < 0;
    const macdAccBull    = macdI > 0 && macdI > macdPrevI;
    const macdAccBear    = macdI < 0 && macdI < macdPrevI;
    const macdBull       = macdI > 0 || macdCrossBull;
    const macdBear       = macdI < 0 || macdCrossBear;

    // ── Exhaustion ───────────────────────────────────────────────────────
    // Only flag exhaustion when BOTH RSI is extreme AND price is very far from EMA.
    // Raised bar vs old (80→85, 55→65) so strong momentum doesn't get killed early.
    const atrStr      = Math.min(100, (Math.abs(bar.close - e20i) / atrI) * 30);
    const isExhBull   = rsiI > 85 && atrStr > 65;
    const isExhBear   = rsiI < 15 && atrStr > 65;

    // ── Context ──────────────────────────────────────────────────────────
    const vol    = analyzeVolume(bars, i);
    const consol = detectConsolidation(bars, i);
    const pa     = detectBreakoutRetest(bars, i);
    const ob     = detectOrderBlocks(bars, i);
    const fvg    = detectFVGs(bars, i);

    // ── Trend persistence model ───────────────────────────────────────────
    // Count consecutive Higher-High + Higher-Low pairs in last 8 bars.
    // A persistent trend has a clear staircase structure; the engine should
    // be MORE aggressive (fewer hesitations) when that structure is intact.
    let hhhlCount = 0;
    for (let j = Math.max(1, i - 7); j < i; j++) {
      const cur = bars[j], prv = bars[j - 1];
      if (cur.high > prv.high && cur.low > prv.low) hhhlCount++;
    }
    const trendPersistence  = hhhlCount; // 0–7
    const persistenceBonus  = trendPersistence >= 4 ? 12
                            : trendPersistence >= 3 ?  8
                            : trendPersistence >= 2 ?  4 : 0;

    // ── Bull / Bear flag continuation ─────────────────────────────────────
    // Strong prior move (last 4 bars > 1% directional) followed by tight
    // consolidation (contracting range) and a breakout close — classic flag.
    const priorClose4   = bars[Math.max(0, i - 4)]?.close ?? bar.close;
    const priorMovePct  = (bar.close - priorClose4) / (priorClose4 || bar.close);
    const bullFlagCont  = strongUptrend   && priorMovePct >  0.005
                        && consol.contracting && bar.close > bar.open && bar.close > e20i;
    const bearFlagCont  = strongDowntrend && priorMovePct < -0.005
                        && consol.contracting && bar.close < bar.open && bar.close < e20i;

    // ── Overextension / bar quality (pre-filter, applies to both sides) ──────
    // 1. Vertical move: last 5 bars moved >2.5×ATR in one direction. Entering
    //    in the same direction is a classic late/chasing entry — almost always
    //    fails because the move is already exhausted.
    const move5      = bar.close - (bars[Math.max(0, i - 5)]?.close ?? bar.close);
    const isVertBull = move5 >  atrI * 2.5;  // spike up — don't long
    const isVertBear = move5 < -atrI * 2.5;  // spike down — don't short

    // 2. EMA20 overextension: ATR-relative limit.
    //    High-ATR symbols (NVDA) naturally swing further from EMA — percentage-based
    //    limits are too strict for them. 1.8 ATR in a strong trend is the extension
    //    limit; momentum continuation setups above that have very low hit rates.
    //    Range/chop: 1.0 ATR (tighter — no chasing in directionless tape).
    const ema20Dist    = Math.abs(bar.close - e20i) / (e20i || bar.close);
    const ema20AtrDist = Math.abs(bar.close - e20i) / (atrI || bar.close * 0.01);
    const extLimit     = (strongUptrend || strongDowntrend) ? 1.8 : 1.0;
    const farAboveEma  = ema20AtrDist > extLimit && bar.close > e20i;
    const farBelowEma  = ema20AtrDist > extLimit && bar.close < e20i;

    // 3. Bar body quality: a doji/spinning-top at entry = indecision. Not a
    //    good signal bar. (Hammer/shooting-star shapes are intentionally kept —
    //    they have directional meaning; the 0.18 threshold targets pure dojis.)
    const barRng    = bar.high - bar.low || 0.0001;
    const bodyRatio = Math.abs(bar.close - bar.open) / barRng;
    const isDoji    = bodyRatio < 0.18;

    // 4. Volume hard skip — only reject extremely thin/no-participation bars.
    //    Below 0.55× = essentially no market participation. Bars 0.55–0.80
    //    get a proportional soft penalty inside the score blocks.
    if (vol.rvol < 0.55) continue;

    // Close position within the bar (0 = at low, 1 = at high).
    // A breakout bar that closes in the lower half of its range means bears
    // pushed back hard intra-bar — that is a fake breakout, not a valid entry.
    const closeInRange    = (bar.close - bar.low) / barRng;
    const fakeBreakoutBull = pa?.type === "breakout"  && closeInRange < 0.45;
    const fakeBreakoutBear = pa?.type === "breakdown" && closeInRange > 0.55;

    // ── Liquidity sweep / stop hunt detection ─────────────────────────────
    // A sweep = bar briefly violates a key structural level (triggering stops)
    // then closes BACK through it, showing strong absorption on the other side.
    // Bull sweep: wick below 15-bar swing low, close above + bullish body.
    // Bear sweep: wick above 15-bar swing high, close below + bearish body.
    // These are among the highest-probability reversal setups in the market.
    const lookback15  = bars.slice(Math.max(0, i - 15), i);
    const swingLow15  = lookback15.length > 0 ? Math.min(...lookback15.map(b => b.low))  : bar.low;
    const swingHigh15 = lookback15.length > 0 ? Math.max(...lookback15.map(b => b.high)) : bar.high;
    // Sweep requires a meaningful ATR-scaled breach (≥ 0.25 ATR below key low),
    // a strong recovery (close clearly above the violated level), and good volume.
    // The 0.9998 % threshold was too loose — any tiny wick would qualify.
    const sweepBull = bar.low < swingLow15 - atrI * 0.25 && bar.close > swingLow15
      && bar.close > bar.open && closeInRange > 0.60 && vol.rvol > 1.2;
    const sweepBear = bar.high > swingHigh15 + atrI * 0.25 && bar.close < swingHigh15
      && bar.close < bar.open && closeInRange < 0.40 && vol.rvol > 1.2;

    // ── Pullback volume quality ───────────────────────────────────────────
    // A healthy institutional pullback has LOWER volume than the trend that
    // preceded it — passive retracement, no real counter-side participation.
    // High volume on a pullback = genuine distribution/supply = avoid entry.
    const recentVol5 = bars.slice(Math.max(0, i - 4), i + 1).reduce((s, b) => s + b.volume, 0) / 5;
    const priorVol10 = bars.slice(Math.max(0, i - 14), i - 4).reduce((s, b) => s + b.volume, 0) / 10;
    const pullbackVolOk = priorVol10 > 0 && recentVol5 < priorVol10 * 0.88;

    const bullP  = allPatterns.filter(p => p.type === "bullish" && p.index === i);
    const bearP  = allPatterns.filter(p => p.type === "bearish" && p.index === i);

    const structBull = structure.regime === "uptrend"   || structure.lastChochDir === "bullish";
    const structBear = structure.regime === "downtrend" || structure.lastChochDir === "bearish";

    const threshold  = scoreThreshold(regimeI, sessionI);
    const minPillars = minConfluencePillars(regimeI);

    // ══════════════════════════════════════════════════════════════════════
    // LONG ANALYSIS
    // Hard-block against-trend longs in bear HTF AND confirmed downtrend.
    // RSI is handled via adaptive scoring — no hard cap; strong trends
    // with volume can sustain elevated RSI as momentum, not exhaustion.
    // ══════════════════════════════════════════════════════════════════════
    if (!strongDowntrend && htfI !== "bear") {
      let bullScore = 0;
      const reasons: string[] = [];

      // Daily bias is tracked in metadata (dayBiasI) but no score penalty is applied here.
      // Symmetric daily-trend penalties were tested and found counterproductive:
      // TSLA intraday shorts work well even in a daily bull phase (intraday mean-reversion),
      // and penalizing them removes the profitable edge. Future directional filtering
      // should be applied only after per-regime win-rate evidence is collected.

      bullP.forEach(p => { bullScore += p.confidence * 0.30; });

      if      (strongUptrend)  { bullScore += atrStr > 40 ? 26 : 16; }
      else if (bullEmaAlign)   { bullScore += atrStr > 40 ? 18 : 10; }
      else if (aboveEma50)     { bullScore += 6; }
      if (bar.close > e200i)   bullScore += 5;

      if (pullbackLong)        bullScore += 24;
      if (pullbackLong && ema20Dist < 0.005) bullScore += 8; // textbook EMA20 touch = precision bonus
      if (emaReclaimBull)    { bullScore += 18; reasons.push("EMA Reclaim"); }
      if (higherLowBull)       bullScore += 10; // trend staircase structure
      if (bullFlagCont)      { bullScore += 16; reasons.push("Bull Flag"); }
      // Trend persistence: more bonus when structure is clean and consistent
      if (persistenceBonus > 0 && strongUptrend) {
        bullScore += persistenceBonus;
        if (persistenceBonus >= 12) reasons.push("Trend Persistence");
      }

      // ── Advanced quality factors ────────────────────────────────────────
      // Liquidity sweep: genuine stop hunt with ATR-scaled breach + recovery.
      // Treated as a supplemental bonus — it enhances a setup but is not the
      // sole reason to enter. The main entry trigger must still be present.
      if (sweepBull)                      bullScore += 8;
      // ER: bonus for very clean directional trend, small penalty for extreme chop
      if (cleanER)                        bullScore += 8;
      if (weakER)                         bullScore -= 6;
      // Pullback volume: declining vol on pullback = healthy, high vol = selling
      if (pullbackLong && pullbackVolOk)  bullScore += 7;
      if (pullbackLong && !pullbackVolOk) bullScore -= 5;

      // RSI — trend-aware scoring.
      // In genuine momentum (strong trend + institutional volume), elevated RSI
      // signals continuation, not exhaustion. Only in normal conditions does
      // RSI >70 indicate an overextended entry.
      const momentumLong = strongUptrend && (vol.accumulation || vol.breakoutVol || vol.rvol > 1.5);
      if (momentumLong) {
        if      (rsiI >= 40 && rsiI <= 72) bullScore += 12; // ideal momentum zone
        else if (rsiI >= 30 && rsiI <  40) bullScore += 7;
        else if (rsiI >  72 && rsiI <= 82) bullScore += 4;  // extended but trend + vol confirm
        else if (rsiI >  82 && rsiI <= 90) bullScore -= 8;  // very extended — caution
        else if (rsiI >  90)               bullScore -= 18; // exhaustion territory
        else if (rsiI <  30)               bullScore -= 6;
      } else {
        if      (rsiI >= 38 && rsiI <= 56) bullScore += 12;
        else if (rsiI >= 30 && rsiI <  38) bullScore += 7;
        else if (rsiI >= 56 && rsiI <= 63) bullScore += 4;
        else if (rsiI <  30)               bullScore -= 6;
        else if (rsiI >= 63 && rsiI <  70) bullScore -= 10; // softened: was -14
        else if (rsiI >= 70 && rsiI <= 78) bullScore -= 20; // softened: was -28
        else if (rsiI >  78)               bullScore -= 30; // keep heavy penalty for extreme RSI
      }

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

      if (pa?.bullish)      bullScore += 14;
      if (structBull)       bullScore += 10;
      if (ob.inBullishOB)  { bullScore += 14; reasons.push("Order Block"); }
      if (fvg.inBullishFVG){ bullScore += 10; reasons.push("FVG Fill"); }

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
      // Vertical move penalty is WAIVED when a valid continuation pattern is present
      // (pullback near EMA, EMA reclaim, higher low, flag) — those ARE valid entries
      // inside a strong momentum move. Only penalize raw "chasing" with no structure.
      const hasContinuationPattern = pullbackLong || emaReclaimBull || higherLowBull || bullFlagCont;
      if (isVertBull && !hasContinuationPattern) bullScore -= (vol.rvol > 1.5 ? 8 : 22);
      if (isVertBull &&  hasContinuationPattern) bullScore -= 4; // tiny friction on continuation in spike
      if (farAboveEma)      bullScore -= 18; // ATR-relative overextension
      if (isDoji)           bullScore -= 12; // indecisive bar = bad signal bar
      if (fakeBreakoutBull) bullScore -= 20; // breakout bar closed weak — bears pushed back
      // RVOL soft penalty: proportional for bars between hard skip (0.55) and healthy (0.80)
      if (vol.rvol < 0.80) bullScore -= Math.round((0.80 - vol.rvol) * 35);
      // Per-symbol momentum bonus: higher trend-persistence symbols get extra credit
      if (profile.momentumBonus > 0 && strongUptrend && (vol.accumulation || vol.breakoutVol)) {
        bullScore += profile.momentumBonus;
      }

      // ── SL / RR pre-check (computed before gate to allow early rejection) ──
      const longSlice    = bars.slice(Math.max(0, i - 20), i + 1);
      const longSwingLow = Math.min(...longSlice.map(b => b.low));
      const longRawRisk  = Math.max(bar.close - (longSwingLow - atrI * 0.25), atrI * 0.7);
      // Symbol-profile SL width multiplier: wider cap for high-volatility instruments
      const longBadRR    = longRawRisk > atrI * 1.8 * profile.slAtrMult;

      const longConfirms = [
        regimeI === "trending-up" || regimeI === "vol-expansion", // local regime is bullish
        bullEmaAlign || strongUptrend,                            // EMA stack aligned
        vol.accumulation || (vol.breakoutVol && vol.rvol > 1.2), // volume conviction
        momentumLong ? rsiI >= 30 && rsiI <= 90 : rsiI >= 30 && rsiI <= 64, // RSI — wider in momentum
        bar.close > bar.open,                                     // bullish close
        macdBull,                                                 // momentum positive
        pullbackLong || pa?.bullish === true || sweepBull,        // entry at pullback, retest, or sweep
        bullP.length > 0,                                         // candlestick confirmation
        aboveVwap || vwapReclaim,                                 // price vs VWAP
        htfI === "bull",                                          // HTF timeframe aligned
      ].filter(Boolean).length;

      // Adaptive confluence gate: minPillars is regime-dependent (4 in trend, 6 in chop).
      // Score threshold is also regime-dependent — no separate hardcoded 97 floor.
      const hasLongStrategy = pullbackLong || vwapReclaim || emaReclaimBull || higherLowBull
        || bullFlagCont || pa?.bullish === true || (consol.contracting && bullEmaAlign)
        || (strongUptrend && (vol.accumulation || vol.breakoutVol))
        || (bullEmaAlign && structBull && macdBull);

      if (!longBadRR && bullScore >= threshold && longConfirms >= minPillars && hasLongStrategy) {
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

        const strategyTypeLong =
          sweepBull                        ? "liquidity_sweep"       :
          pullbackLong && consol.contracting ? "compression_pullback" :
          pullbackLong                     ? "trend_pullback"         :
          vwapReclaim                      ? "vwap_reclaim"           :
          pa?.type === "breakout"          ? (consol.contracting ? "compression_breakout" : "breakout_continuation") :
          pa?.type === "retest-bull"       ? "breakout_retest"        : "momentum";

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
          strategy:         strategyTypeLong,
          metadata: {
            regime:         regimeI,
            efRatio:        Math.round(efI * 100) / 100,
            strategy:       strategyTypeLong,
            sweepEntry:     sweepBull,
            pullbackVolOk:  pullbackLong ? pullbackVolOk : null,
            htfBias:        htfI,
            session:        sessionI,
            confluenceCount: longConfirms,
            volumeState:    vol.accumulation ? "accumulation" : vol.distribution ? "distribution" : "neutral",
            structureState: structBull ? "uptrend" : "mixed",
          },
        });
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // SHORT ANALYSIS
    // Hard-block against-trend shorts in bull HTF AND confirmed uptrend.
    // RSI handled via adaptive scoring — no hard floor; strong downtrends
    // with volume can sustain low RSI as momentum continuation.
    // ══════════════════════════════════════════════════════════════════════
    if (!strongUptrend && htfI !== "bull") {
      let bearScore = 0;
      const reasons: string[] = [];

      // No daily-bias score penalty here — see long-block comment above.

      bearP.forEach(p => { bearScore += p.confidence * 0.30; });

      if      (strongDowntrend) { bearScore += atrStr > 40 ? 26 : 16; }
      else if (bearEmaAlign)    { bearScore += atrStr > 40 ? 18 : 10; }
      else if (belowEma50)      { bearScore += 6; }
      if (bar.close < e200i)    bearScore += 5;

      if (pullbackShort)        bearScore += 24;
      if (pullbackShort && ema20Dist < 0.005) bearScore += 8; // textbook EMA20 touch = precision bonus
      if (emaRejectionBear)  { bearScore += 18; reasons.push("EMA Rejection"); }
      if (lowerHighBear)       bearScore += 10; // trend staircase structure
      if (bearFlagCont)      { bearScore += 16; reasons.push("Bear Flag"); }
      // Trend persistence: HH/HL count (inversely used for bear — falling staircase)
      if (persistenceBonus > 0 && strongDowntrend) {
        bearScore += persistenceBonus;
        if (persistenceBonus >= 12) reasons.push("Trend Persistence");
      }

      // ── Advanced quality factors ────────────────────────────────────────
      if (sweepBear)                       bearScore += 8;  // stop hunt then rejection — supplemental bonus
      if (cleanER)                         bearScore += 8;
      if (weakER)                          bearScore -= 6;
      if (pullbackShort && pullbackVolOk)  bearScore += 7;
      if (pullbackShort && !pullbackVolOk) bearScore -= 5;

      // RSI — trend-aware scoring for shorts.
      // In genuine downward momentum (trend + institutional distribution), low RSI
      // signals continuation. Only in normal conditions does RSI <30 indicate chasing.
      const momentumShort = strongDowntrend && (vol.distribution || vol.breakoutVol || vol.rvol > 1.5);
      if (momentumShort) {
        if      (rsiI >= 28 && rsiI <= 60) bearScore += 12; // ideal momentum zone
        else if (rsiI >= 60 && rsiI <= 70) bearScore += 7;
        else if (rsiI >= 18 && rsiI <  28) bearScore += 4;  // oversold but trend + vol confirm
        else if (rsiI >= 10 && rsiI <  18) bearScore -= 8;  // very oversold — caution
        else if (rsiI <  10)               bearScore -= 18; // exhaustion territory
        else if (rsiI >  70)               bearScore -= 6;
      } else {
        if      (rsiI >= 44 && rsiI <= 62) bearScore += 12;
        else if (rsiI >= 62 && rsiI <= 70) bearScore += 7;
        else if (rsiI >= 37 && rsiI <  44) bearScore += 4;
        else if (rsiI >  70)               bearScore -= 6;
        else if (rsiI >= 22 && rsiI <  37) bearScore -= 10; // softened: was -14
        else if (rsiI >= 14 && rsiI <  22) bearScore -= 20; // softened: was -28
        else if (rsiI <  14)               bearScore -= 30; // keep heavy penalty for extreme RSI
      }

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

      if (pa && !pa.bullish)   bearScore += 14;
      if (structBear)          bearScore += 10;
      if (ob.inBearishOB)     { bearScore += 14; reasons.push("Order Block"); }
      if (fvg.inBearishFVG)   { bearScore += 10; reasons.push("FVG Fill"); }

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
      // Vertical move penalty waived when a valid short continuation pattern is present.
      const hasBearContinuation = pullbackShort || emaRejectionBear || lowerHighBear || bearFlagCont;
      if (isVertBear && !hasBearContinuation) bearScore -= (vol.rvol > 1.5 ? 8 : 22);
      if (isVertBear &&  hasBearContinuation) bearScore -= 4; // tiny friction only
      if (farBelowEma)      bearScore -= 18; // ATR-relative overextension
      if (isDoji)           bearScore -= 12; // indecisive bar = bad signal bar
      if (fakeBreakoutBear) bearScore -= 20; // breakdown bar closed strong — bulls pushed back
      // RVOL soft penalty: proportional for bars 0.55–0.80
      if (vol.rvol < 0.80) bearScore -= Math.round((0.80 - vol.rvol) * 35);
      // Per-symbol momentum bonus
      if (profile.momentumBonus > 0 && strongDowntrend && (vol.distribution || vol.breakoutVol)) {
        bearScore += profile.momentumBonus;
      }

      // ── SL / RR pre-check for shorts ───────────────────────────────────
      const shortSlice     = bars.slice(Math.max(0, i - 20), i + 1);
      const shortSwingHigh = Math.max(...shortSlice.map(b => b.high));
      const shortRawRisk   = Math.max((shortSwingHigh + atrI * 0.25) - bar.close, atrI * 0.7);
      const shortBadRR     = shortRawRisk > atrI * 1.8 * profile.slAtrMult;

      const shortConfirms = [
        regimeI === "trending-down" || regimeI === "vol-expansion", // local regime is bearish
        bearEmaAlign || strongDowntrend,                            // EMA stack aligned bear
        vol.distribution || (vol.breakoutVol && vol.rvol > 1.2),   // volume conviction
        momentumShort ? rsiI >= 10 && rsiI <= 70 : rsiI >= 36 && rsiI <= 70, // RSI — wider in momentum
        bar.close < bar.open,                                       // bearish close
        macdBear,                                                   // momentum negative
        pullbackShort || (pa !== null && !pa.bullish) || sweepBear, // entry at rejection, retest, or sweep
        bearP.length > 0,                                           // candlestick confirmation
        belowVwap || vwapRejection,                                 // price vs VWAP
        htfI === "bear",                                            // HTF timeframe aligned
      ].filter(Boolean).length;

      // Adaptive confluence gate: regime-dependent pillars and threshold.
      const hasShortStrategy = pullbackShort || vwapRejection || emaRejectionBear || lowerHighBear
        || bearFlagCont || (pa !== null && !pa.bullish) || (consol.contracting && bearEmaAlign)
        || (strongDowntrend && (vol.distribution || vol.breakoutVol))
        || (bearEmaAlign && structBear && macdBear);

      if (!shortBadRR && bearScore >= threshold && shortConfirms >= minPillars && hasShortStrategy) {
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

        const strategyTypeShort =
          sweepBear                          ? "liquidity_sweep"        :
          pullbackShort && consol.contracting ? "compression_pullback"  :
          pullbackShort                      ? "trend_pullback"          :
          vwapRejection                      ? "vwap_rejection"          :
          pa?.type === "breakdown"           ? (consol.contracting ? "compression_breakout" : "breakdown_continuation") :
          pa?.type === "retest-bear"         ? "breakout_retest"         : "momentum";

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
          strategy:         strategyTypeShort,
          metadata: {
            regime:         regimeI,
            efRatio:        Math.round(efI * 100) / 100,
            strategy:       strategyTypeShort,
            sweepEntry:     sweepBear,
            pullbackVolOk:  pullbackShort ? pullbackVolOk : null,
            htfBias:        htfI,
            session:        sessionI,
            confluenceCount: shortConfirms,
            volumeState:    vol.distribution ? "distribution" : vol.accumulation ? "accumulation" : "neutral",
            structureState: structBear ? "downtrend" : "mixed",
          },
        });
      }
    }
  }

  // ── Deduplication: one best setup per 45-min window (per side) ──────────
  // 5m: 9 bars = 45 min; 15m: 3 bars = 45 min.
  // 45-min windows allow faster re-entry after TP while still preventing
  // micro-spam within the same momentum burst. Quality control is maintained
  // by the score gate (84 in trending) and the sequential filter.
  const minGapSec    = timeframe === "15m" ? 900 * 3 : 300 * 9;
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
    strategy:   c.strategy,
    regime:     (c.metadata?.regime as string | undefined) ?? "ranging",
    metadata:   c.metadata,
  }));

  return { signals, candidates: allDeduped };
}
