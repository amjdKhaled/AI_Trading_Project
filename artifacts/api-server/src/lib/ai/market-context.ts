// ============================================================
// Market Analysis Engine
// Computes the full MarketContext from OHLCV data.
// This is pure deterministic indicator math — no LONG/SHORT.
// The context object is sent to Ollama (Trade Intelligence Engine)
// which generates the actual trade decision.
// ============================================================

import { emaArray, rsiArray } from "../analyzer/trend.js";
import { vwapArray } from "../analyzer/vwap.js";
import { classifyRegimes } from "../analyzer/regime.js";
import { sessionFor } from "../analyzer/session.js";
import { detectOrderBlocks } from "../analyzer/orderblocks.js";
import { detectFVGs } from "../analyzer/fvg.js";
import { detectAllPatterns } from "../analyzer/candlestick.js";
import type { OhlcvBar } from "../analyzer/types.js";
import type { NewsSentiment } from "./news.js";
import { db, signalsTable, aiDecisionsTable } from "@workspace/db";
import { and, eq, inArray, desc } from "drizzle-orm";
import { logger } from "../logger.js";

// ── Public types ──────────────────────────────────────────────────────────────

export interface HistoricalSetupStats {
  samples:           number;
  winRate:           number;   // 0–1
  avgRR:             number;
  avgProfit:         number;   // in R units
  avgLoss:           number;   // in R units (positive = magnitude of loss)
  regimeApproveRate: number;   // fraction of AI decisions in this regime that were APPROVE
  summary:           string;
}

export interface MarketContextIndicators {
  rsi14:          number;
  ema20:          number;
  ema50:          number;
  ema200:         number;
  macdLine:       number;
  macdSignal:     number;
  macdHist:       number;
  atr14:          number;
  vwap:           number;
  relativeVolume: number;
}

export interface MarketContextStructure {
  trendDirection:          "uptrend" | "downtrend" | "ranging";
  swingHighs:              number[];
  swingLows:               number[];
  nearestResistance:       number | null;
  nearestSupport:          number | null;
  distanceToResistancePct: number | null;  // % above current price
  distanceToSupportPct:    number | null;  // % below current price
}

export interface HtfContext {
  timeframe:      string;
  ema20:          number;
  ema50:          number;
  ema200:         number;
  rsi14:          number;
  trendDirection: "uptrend" | "downtrend" | "ranging";
  bias:           "bullish" | "bearish" | "neutral";
  swingHighs:     number[];
  swingLows:      number[];
}

export interface MarketContext {
  symbol:              string;
  timeframe:           string;
  candleTime:          number;
  currentBar:          OhlcvBar;
  indicators:          MarketContextIndicators;
  structure:           MarketContextStructure;
  recentBars:          OhlcvBar[];   // last 100 bars of active TF
  volumeEvolution:     string;       // narrative description
  trendEvolution:      string;       // narrative description
  htf:                 HtfContext;
  candlestickPatterns: string[];
  orderBlocks:         Array<{ type: "bull" | "bear"; high: number; low: number; inZone: boolean }>;
  fairValueGaps:       Array<{ type: "bull" | "bear"; high: number; low: number; filled: boolean; inZone: boolean }>;
  regime:              string;
  session:             string;
  news:                NewsSentiment;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function r4(n: number): number { return Math.round(n * 10000) / 10000; }
function r2(n: number): number { return Math.round(n * 100) / 100; }

/** Wilder-smoothed ATR per bar (EMA-style, period 14) */
function calcAtrArray(bars: OhlcvBar[]): number[] {
  const out = new Array<number>(bars.length).fill(0);
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    const tr = Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
    out[i] = i < 14 ? tr : (out[i - 1] * 13 + tr) / 14;
  }
  return out;
}

function calcMacd(closes: number[]): { line: number; signal: number; hist: number } {
  if (closes.length < 35) return { line: 0, signal: 0, hist: 0 };
  const fast = emaArray(closes, 12);
  const slow = emaArray(closes, 26);
  const macdLine = fast.map((f, i) => f - slow[i]);
  const sig = emaArray(macdLine, 9);
  const n = closes.length - 1;
  return { line: r4(macdLine[n]), signal: r4(sig[n]), hist: r4(macdLine[n] - sig[n]) };
}

/** 5-bar pivot swing highs/lows from the last `lookback` bars */
function detectSwings(bars: OhlcvBar[], arm = 5): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows:  number[] = [];
  for (let i = arm; i < bars.length - arm; i++) {
    let isH = true, isL = true;
    for (let j = i - arm; j <= i + arm; j++) {
      if (j === i) continue;
      if (bars[j].high >= bars[i].high) isH = false;
      if (bars[j].low  <= bars[i].low)  isL = false;
    }
    if (isH) highs.push(r4(bars[i].high));
    if (isL) lows.push(r4(bars[i].low));
  }
  return { highs: highs.slice(-5), lows: lows.slice(-5) };
}

function trendFromEma(
  close: number, e20: number, e50: number, e200: number,
): "uptrend" | "downtrend" | "ranging" {
  if (close > e20 && e20 > e50 && e50 > e200) return "uptrend";
  if (close < e20 && e20 < e50 && e50 < e200) return "downtrend";
  return "ranging";
}

function describeTrend(bars: OhlcvBar[]): string {
  if (bars.length < 20) return "insufficient data";
  const f = bars.slice(0, 20).reduce((s, b) => s + b.close, 0) / 20;
  const l = bars.slice(-20).reduce((s, b) => s + b.close, 0) / 20;
  const pct = ((l - f) / f) * 100;
  let hhCount = 0, llCount = 0;
  let ph = bars[0].high, pl = bars[0].low;
  for (const b of bars.slice(1)) {
    if (b.high > ph) { hhCount++; ph = b.high; }
    if (b.low  < pl) { llCount++; pl = b.low;  }
  }
  const dir = pct > 1.5 ? "upward" : pct < -1.5 ? "downward" : "sideways";
  const mag = Math.abs(pct) > 3 ? "strong" : Math.abs(pct) > 1 ? "moderate" : "weak";
  return `${mag} ${dir} trend over ${bars.length} bars (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% net). HH: ${hhCount}  LL: ${llCount}.`;
}

function describeVolume(bars: OhlcvBar[]): string {
  const slice = bars.slice(-20);
  if (slice.length < 5) return "insufficient data";
  const avg = slice.reduce((s, b) => s + b.volume, 0) / slice.length;
  const l5  = slice.slice(-5).reduce((s, b) => s + b.volume, 0) / 5;
  const rel = avg > 0 ? l5 / avg : 1;
  const bv  = slice.filter(b => b.close > b.open).reduce((s, b) => s + b.volume, 0);
  const sv  = slice.filter(b => b.close < b.open).reduce((s, b) => s + b.volume, 0);
  const dom = bv > sv * 1.3 ? "buy-side dominant" : sv > bv * 1.3 ? "sell-side dominant" : "balanced";
  const trend = rel > 1.3 ? "rising" : rel < 0.7 ? "declining" : "stable";
  return `Volume ${trend} (${rel.toFixed(2)}x 20-bar avg), ${dom}.`;
}

// ── Main builder (synchronous — pure indicator math) ──────────────────────────

export function buildMarketContext(
  bars:         OhlcvBar[],
  htfBars:      OhlcvBar[],
  htfTimeframe: string,
  symbol:       string,
  timeframe:    string,
  candleTime:   number,
  news:         NewsSentiment,
): MarketContext {
  const recent = bars.slice(-100);
  const htf100 = htfBars.slice(-100);
  const n      = recent.length - 1;
  const cur    = recent[n];
  const price  = cur.close;

  const closes   = recent.map(b => b.close);
  const ema20Arr  = emaArray(closes, 20);
  const ema50Arr  = emaArray(closes, 50);
  const ema200Arr = emaArray(closes, 200);
  const rsiArr    = rsiArray(closes, 14);
  const vwapArr   = vwapArray(recent);
  const atrArr    = calcAtrArray(recent);
  const macd      = calcMacd(closes);

  const ema20  = r4(ema20Arr[n]);
  const ema50  = r4(ema50Arr[n]);
  const ema200 = r4(ema200Arr[n]);
  const rsi14  = r2(rsiArr[n]);
  const vwap   = r4(vwapArr[n]);
  const atr14  = r4(atrArr[n]);
  const avgVol = recent.slice(-21, -1).reduce((s, b) => s + b.volume, 0) / 20;
  const relVol = avgVol > 0 ? r2(cur.volume / avgVol) : 1;

  // Regime from the last bar of the 100-bar window
  const regimes = classifyRegimes(recent, ema20Arr, ema50Arr, ema200Arr, atrArr);
  const regime  = String(regimes[n] ?? "ranging");

  // Structure
  const { highs: swHigh, lows: swLow } = detectSwings(recent);
  const trendDir = trendFromEma(price, ema20, ema50, ema200);
  const above    = swHigh.filter(h => h > price).sort((a, b) => a - b);
  const below    = swLow.filter(l => l < price).sort((a, b) => b - a);
  const nearRes  = above[0] ?? null;
  const nearSup  = below[0] ?? null;

  // HTF
  const htfCloses = htf100.map(b => b.close);
  const hE20  = emaArray(htfCloses, 20);
  const hE50  = emaArray(htfCloses, 50);
  const hE200 = emaArray(htfCloses, 200);
  const hRsi  = rsiArray(htfCloses, 14);
  const hN    = htf100.length - 1;
  const htfP  = htf100[hN]?.close ?? price;
  const htfTrend = trendFromEma(htfP, hE20[hN], hE50[hN], hE200[hN]);
  const { highs: htfHigh, lows: htfLow } = detectSwings(htf100);

  // Order Blocks + FVGs
  const ob  = detectOrderBlocks(recent, n);
  const fvg = detectFVGs(recent, n);

  const orderBlocks = [
    ob.bullishOB ? { type: "bull" as const, high: ob.bullishOB.high, low: ob.bullishOB.low, inZone: ob.inBullishOB } : null,
    ob.bearishOB ? { type: "bear" as const, high: ob.bearishOB.high, low: ob.bearishOB.low, inZone: ob.inBearishOB } : null,
  ].filter((x): x is NonNullable<typeof x> => x !== null);

  const fairValueGaps = [
    fvg.bullishFVG ? { type: "bull" as const, high: fvg.bullishFVG.top, low: fvg.bullishFVG.bottom, filled: fvg.bullishFVG.filled, inZone: fvg.inBullishFVG } : null,
    fvg.bearishFVG ? { type: "bear" as const, high: fvg.bearishFVG.top, low: fvg.bearishFVG.bottom, filled: fvg.bearishFVG.filled, inZone: fvg.inBearishFVG } : null,
  ].filter((x): x is NonNullable<typeof x> => x !== null);

  const candlestickPatterns = detectAllPatterns(recent)
    .filter(p => p.index >= n - 3)   // only patterns on the last 3 bars
    .map(p => p.name).slice(0, 8);

  return {
    symbol, timeframe, candleTime,
    currentBar: cur,
    indicators: {
      rsi14, ema20, ema50, ema200,
      macdLine: macd.line, macdSignal: macd.signal, macdHist: macd.hist,
      atr14, vwap, relativeVolume: relVol,
    },
    structure: {
      trendDirection: trendDir,
      swingHighs: swHigh, swingLows: swLow,
      nearestResistance: nearRes, nearestSupport: nearSup,
      distanceToResistancePct: nearRes ? r2(((nearRes - price) / price) * 100) : null,
      distanceToSupportPct:    nearSup ? r2(((price - nearSup) / price) * 100) : null,
    },
    recentBars: recent,
    volumeEvolution: describeVolume(recent),
    trendEvolution:  describeTrend(recent),
    htf: {
      timeframe: htfTimeframe,
      ema20: r4(hE20[hN]), ema50: r4(hE50[hN]), ema200: r4(hE200[hN]),
      rsi14: r2(hRsi[hN]),
      trendDirection: htfTrend,
      bias: htfTrend === "uptrend" ? "bullish" : htfTrend === "downtrend" ? "bearish" : "neutral",
      swingHighs: htfHigh, swingLows: htfLow,
    },
    candlestickPatterns, orderBlocks, fairValueGaps,
    regime, session: sessionFor(candleTime), news,
  };
}

// ── Historical similar setups — queries DB ────────────────────────────────────

export async function findSimilarHistoricalSetups(
  symbol:   string,
  regime:   string,
  _rsi14:   number,
  _patterns: string[],
): Promise<HistoricalSetupStats> {
  const empty: HistoricalSetupStats = {
    samples: 0, winRate: 0, avgRR: 0,
    avgProfit: 0, avgLoss: 1, regimeApproveRate: 0,
    summary: "No historical data available yet.",
  };

  try {
    const [sigs, regimeDecs] = await Promise.all([
      db
        .select({ state: signalsTable.state, rrRatio: signalsTable.rrRatio })
        .from(signalsTable)
        .where(and(
          eq(signalsTable.symbol, symbol),
          inArray(signalsTable.state, ["tp_hit", "sl_hit"]),
        ))
        .orderBy(desc(signalsTable.barTime))
        .limit(200),

      db
        .select({ verdict: aiDecisionsTable.verdict })
        .from(aiDecisionsTable)
        .where(and(
          eq(aiDecisionsTable.symbol, symbol),
          eq(aiDecisionsTable.regime, regime),
        ))
        .orderBy(desc(aiDecisionsTable.createdAt))
        .limit(50),
    ]);

    const wins   = sigs.filter(r => r.state === "tp_hit");
    const losses = sigs.filter(r => r.state === "sl_hit");
    const total  = sigs.length;
    const wr     = total > 0 ? wins.length / total : 0;
    const avgRR  = wins.length   > 0 ? wins.reduce((s, r) => s + (r.rrRatio ?? 1.5), 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, r) => s + (r.rrRatio ?? 1),   0) / losses.length : 1;
    const approved = regimeDecs.filter(d => d.verdict === "APPROVE").length;
    const rar      = regimeDecs.length > 0 ? approved / regimeDecs.length : 0;

    if (total === 0 && regimeDecs.length === 0) return empty;

    const summary =
      `${total} closed trades — WR: ${(wr * 100).toFixed(1)}%, avg R:R: ${avgRR.toFixed(2)}, avg loss: ${avgLoss.toFixed(2)}R. ` +
      `Regime "${regime}": AI approve rate ${(rar * 100).toFixed(0)}% (${regimeDecs.length} decisions).`;

    return {
      samples:           total,
      winRate:           Math.round(wr    * 1000) / 1000,
      avgRR:             Math.round(avgRR  * 100) / 100,
      avgProfit:         Math.round(avgRR  * 100) / 100,
      avgLoss:           Math.round(avgLoss * 100) / 100,
      regimeApproveRate: Math.round(rar    * 1000) / 1000,
      summary,
    };
  } catch (err) {
    logger.warn({ err, symbol }, "Historical setup query failed — returning empty stats");
    return empty;
  }
}
