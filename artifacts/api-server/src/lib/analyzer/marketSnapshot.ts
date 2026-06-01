// ============================================================
// Market Snapshot Engine (Task #46 / #47)
// ============================================================
// Assembles a deterministic, structured market snapshot from raw
// OHLCV bars.  No AI memory is loaded here — the snapshot is a
// pure technical picture used by filterCandleWithSnapshot.
// ============================================================

import { analyzeTrendMomentumVolatility, emaArray } from "./trend.js";
import { vwapArray } from "./vwap.js";
import { classifyRegimes } from "./regime.js";
import { sessionFor } from "./session.js";
import { analyzeStructure } from "./structure.js";
import { analyzeVolume } from "./volume.js";
import { detectAllPatterns } from "./candlestick.js";
import { detectChartPatterns } from "./patterns.js";
import { detectOrderBlocks } from "./orderblocks.js";
import { detectFVGs } from "./fvg.js";
import type {
  OhlcvBar,
  VolumeAnalysis,
  TrendState,
  MomentumState,
  VolatilityState,
  StructurePoint,
} from "./types.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface MarketSnapshotIndicators {
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
  bbUpper:        number;
  bbLower:        number;
  bbWidth:        number;
}

export interface MarketSnapshotStructure {
  regime:       "uptrend" | "downtrend" | "ranging";
  bosCount:     number;
  chochCount:   number;
  lastBosDir:   "bullish" | "bearish" | null;
  lastChochDir: "bullish" | "bearish" | null;
  lastSwingHigh: number;
  lastSwingLow:  number;
  points: StructurePoint[];
}

export interface SnapshotSupportResistance {
  resistanceLevels:    number[];
  supportLevels:       number[];
  nearestResistance:   number | null;
  nearestSupport:      number | null;
  distToResistancePct: number | null;
  distToSupportPct:    number | null;
}

export interface SnapshotPivotPoints {
  pp: number;
  r1: number;
  r2: number;
  r3: number;
  s1: number;
  s2: number;
  s3: number;
}

export interface SnapshotFibonacci {
  swingHigh: number;
  swingLow:  number;
  fib0:      number;
  fib236:    number;
  fib382:    number;
  fib500:    number;
  fib618:    number;
  fib786:    number;
  fib100:    number;
}

export interface SnapshotHtfContext {
  timeframe: string;
  ema20:     number;
  ema50:     number;
  ema200:    number;
  rsi14:     number;
  bias:      "bullish" | "bearish" | "neutral";
}

export interface SnapshotOrderBlock {
  type:   "bull" | "bear";
  high:   number;
  low:    number;
  inZone: boolean;
}

export interface SnapshotFVG {
  type:   "bull" | "bear";
  high:   number;
  low:    number;
  filled: boolean;
  inZone: boolean;
}

export interface MarketSnapshot {
  symbol:     string;
  timeframe:  string;
  candleTime: number;
  session:    string;
  regime:     string;
  currentBar: OhlcvBar;
  indicators:       MarketSnapshotIndicators;
  structure:        MarketSnapshotStructure;
  supportResistance: SnapshotSupportResistance;
  pivotPoints:      SnapshotPivotPoints;
  fibonacci:        SnapshotFibonacci | null;
  volume:           VolumeAnalysis;
  candlestickPatterns: string[];
  chartPatterns:       string[];
  orderBlocks:  SnapshotOrderBlock[];
  fairValueGaps: SnapshotFVG[];
  trend:      TrendState;
  momentum:   MomentumState;
  volatility: VolatilityState;
  htf:        SnapshotHtfContext | null;
}

// ── Helper computations ────────────────────────────────────────────────────────

function r4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function macdFull(closes: number[]): { line: number[]; signal: number[]; hist: number[] } {
  const ema12 = emaArray(closes, 12);
  const ema26 = emaArray(closes, 26);
  const line   = ema12.map((v, i) => v - ema26[i]);
  const signal = emaArray(line, 9);
  const hist   = line.map((v, i) => v - signal[i]);
  return { line, signal, hist };
}

function bollingerBands(closes: number[], ema20Arr: number[], period = 20): {
  upper: number[];
  lower: number[];
} {
  const n     = closes.length;
  const upper = new Array<number>(n).fill(0);
  const lower = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const start  = Math.max(0, i - period + 1);
    const slice  = closes.slice(start, i + 1);
    const mean   = ema20Arr[i];
    const variance = slice.reduce((acc, v) => acc + (v - mean) ** 2, 0) / slice.length;
    const std    = Math.sqrt(variance);
    upper[i]     = mean + 2 * std;
    lower[i]     = mean - 2 * std;
  }
  return { upper, lower };
}

function relativeVolume(bars: OhlcvBar[], i: number, lookback = 20): number {
  const start  = Math.max(0, i - lookback);
  const slice  = bars.slice(start, i);
  if (slice.length === 0) return 1;
  const avgVol = slice.reduce((acc, b) => acc + b.volume, 0) / slice.length;
  return avgVol > 0 ? bars[i].volume / avgVol : 1;
}

function clusterLevels(levels: number[], tolerance: number): number[] {
  const sorted = [...levels].sort((a, b) => a - b);
  const clusters: number[] = [];
  let group: number[] = [];
  for (const level of sorted) {
    if (group.length === 0 || level - group[group.length - 1] <= tolerance) {
      group.push(level);
    } else {
      clusters.push(group.reduce((a, b) => a + b, 0) / group.length);
      group = [level];
    }
  }
  if (group.length > 0) clusters.push(group.reduce((a, b) => a + b, 0) / group.length);
  return clusters;
}

function buildSupportResistance(
  points: StructurePoint[],
  currentPrice: number,
  atr: number,
): SnapshotSupportResistance {
  const tolerance = atr * 0.5;

  const swingHighPrices = points
    .filter(p => p.type === "swing-high" || p.type === "HH" || p.type === "LH")
    .map(p => p.price);
  const swingLowPrices = points
    .filter(p => p.type === "swing-low" || p.type === "HL" || p.type === "LL")
    .map(p => p.price);

  const resistanceLevels = clusterLevels(swingHighPrices, tolerance)
    .filter(l => l > currentPrice)
    .sort((a, b) => a - b)
    .slice(0, 5);

  const supportLevels = clusterLevels(swingLowPrices, tolerance)
    .filter(l => l < currentPrice)
    .sort((a, b) => b - a)
    .slice(0, 5);

  const nearestResistance = resistanceLevels[0] ?? null;
  const nearestSupport    = supportLevels[0]    ?? null;

  return {
    resistanceLevels,
    supportLevels,
    nearestResistance,
    nearestSupport,
    distToResistancePct: nearestResistance !== null
      ? r4(((nearestResistance - currentPrice) / currentPrice) * 100)
      : null,
    distToSupportPct: nearestSupport !== null
      ? r4(((currentPrice - nearestSupport) / currentPrice) * 100)
      : null,
  };
}

function computePivotPoints(bars: OhlcvBar[], currentIndex: number): SnapshotPivotPoints {
  const lookback = 20;
  const start    = Math.max(0, currentIndex - lookback);
  const slice    = bars.slice(start, currentIndex);
  const H        = slice.length > 0 ? Math.max(...slice.map(b => b.high))  : bars[currentIndex].high;
  const L        = slice.length > 0 ? Math.min(...slice.map(b => b.low))   : bars[currentIndex].low;
  const C        = slice.length > 0 ? slice[slice.length - 1].close : bars[currentIndex].close;
  const PP       = (H + L + C) / 3;
  return {
    pp: r4(PP),
    r1: r4(2 * PP - L),
    r2: r4(PP + (H - L)),
    r3: r4(H + 2 * (PP - L)),
    s1: r4(2 * PP - H),
    s2: r4(PP - (H - L)),
    s3: r4(L - 2 * (H - PP)),
  };
}

function computeFibonacci(swingHigh: number, swingLow: number): SnapshotFibonacci | null {
  const range = swingHigh - swingLow;
  if (range <= 0 || swingHigh === swingLow) return null;
  return {
    swingHigh,
    swingLow,
    fib0:   r4(swingHigh),
    fib236: r4(swingHigh - 0.236 * range),
    fib382: r4(swingHigh - 0.382 * range),
    fib500: r4(swingHigh - 0.500 * range),
    fib618: r4(swingHigh - 0.618 * range),
    fib786: r4(swingHigh - 0.786 * range),
    fib100: r4(swingLow),
  };
}

function htfBias(bars: OhlcvBar[]): "bullish" | "bearish" | "neutral" {
  if (bars.length < 50) return "neutral";
  const closes = bars.map(b => b.close);
  const e20  = emaArray(closes, 20);
  const e50  = emaArray(closes, 50);
  const n    = bars.length - 1;
  const c    = closes[n];
  if (c > e20[n] && e20[n] > e50[n]) return "bullish";
  if (c < e20[n] && e20[n] < e50[n]) return "bearish";
  return "neutral";
}

// ── Main export ────────────────────────────────────────────────────────────────

export function buildMarketSnapshot(
  bars:      OhlcvBar[],
  htfBars:   OhlcvBar[],
  htfTf:     string,
  symbol:    string,
  timeframe: string,
  candleTime: number,
): MarketSnapshot {
  const recent = bars.slice(-200);
  const n      = recent.length - 1;
  const curr   = recent[n];

  // ── Core indicators ──────────────────────────────────────────────────────────
  const { trend, momentum, volatility, ema20, ema50, ema200, atrValues, rsiValues } =
    analyzeTrendMomentumVolatility(recent);

  const closes    = recent.map(b => b.close);
  const macd      = macdFull(closes);
  const vwap      = vwapArray(recent);
  const { upper: bbUp, lower: bbLo } = bollingerBands(closes, ema20);
  const regimes   = classifyRegimes(recent, ema20, ema50, ema200, atrValues);

  const indicators: MarketSnapshotIndicators = {
    rsi14:          r4(rsiValues[n]  ?? 50),
    ema20:          r4(ema20[n]      ?? curr.close),
    ema50:          r4(ema50[n]      ?? curr.close),
    ema200:         r4(ema200[n]     ?? curr.close),
    macdLine:       r4(macd.line[n]   ?? 0),
    macdSignal:     r4(macd.signal[n] ?? 0),
    macdHist:       r4(macd.hist[n]   ?? 0),
    atr14:          r4(atrValues[n]  ?? 0),
    vwap:           r4(vwap[n]       ?? curr.close),
    relativeVolume: r4(relativeVolume(recent, n)),
    bbUpper:        r4(bbUp[n] ?? curr.close),
    bbLower:        r4(bbLo[n] ?? curr.close),
    bbWidth:        r4(((bbUp[n] - bbLo[n]) / curr.close) * 100),
  };

  // ── Market structure ─────────────────────────────────────────────────────────
  const structRaw = analyzeStructure(recent);
  const structure: MarketSnapshotStructure = { ...structRaw };

  // ── Support / Resistance ─────────────────────────────────────────────────────
  const supportResistance = buildSupportResistance(
    structRaw.points,
    curr.close,
    atrValues[n] ?? curr.close * 0.005,
  );

  // ── Pivot Points ─────────────────────────────────────────────────────────────
  const pivotPoints = computePivotPoints(recent, n);

  // ── Fibonacci ────────────────────────────────────────────────────────────────
  const fibonacci = computeFibonacci(structRaw.lastSwingHigh, structRaw.lastSwingLow);

  // ── Volume ───────────────────────────────────────────────────────────────────
  const volume = analyzeVolume(recent, n);

  // ── Candlestick + Chart patterns ─────────────────────────────────────────────
  const allPatterns   = detectAllPatterns(recent);
  const chartPatterns = detectChartPatterns(recent);

  const candlestickPatterns = allPatterns
    .filter(p => p.confidence >= 60)
    .map(p => p.name);
  const chartPatternNames = chartPatterns
    .filter(p => p.confidence >= 60)
    .map(p => p.name);

  // ── Order blocks + FVGs ──────────────────────────────────────────────────────
  const ob  = detectOrderBlocks(recent, n);
  const fvg = detectFVGs(recent, n);

  const orderBlocks: SnapshotOrderBlock[] = [
    ob.bullishOB ? { type: "bull" as const, high: ob.bullishOB.high, low: ob.bullishOB.low, inZone: ob.inBullishOB } : null,
    ob.bearishOB ? { type: "bear" as const, high: ob.bearishOB.high, low: ob.bearishOB.low, inZone: ob.inBearishOB } : null,
  ].filter((x): x is SnapshotOrderBlock => x !== null);

  const fairValueGaps: SnapshotFVG[] = [
    fvg.bullishFVG ? { type: "bull" as const, high: fvg.bullishFVG.top, low: fvg.bullishFVG.bottom, filled: fvg.bullishFVG.filled, inZone: fvg.inBullishFVG } : null,
    fvg.bearishFVG ? { type: "bear" as const, high: fvg.bearishFVG.top, low: fvg.bearishFVG.bottom, filled: fvg.bearishFVG.filled, inZone: fvg.inBearishFVG } : null,
  ].filter((x): x is SnapshotFVG => x !== null);

  // ── HTF context ──────────────────────────────────────────────────────────────
  let htf: SnapshotHtfContext | null = null;
  if (htfBars.length >= 50) {
    const hRecent  = htfBars.slice(-100);
    const hCloses  = hRecent.map(b => b.close);
    const hE20     = emaArray(hCloses, 20);
    const hE50     = emaArray(hCloses, 50);
    const hE200    = emaArray(hCloses, 200);
    const hRsi     = emaArray(hCloses, 14); // use ema as rough RSI proxy for HTF
    const hN       = hRecent.length - 1;
    htf = {
      timeframe: htfTf,
      ema20:     r4(hE20[hN]  ?? hRecent[hN].close),
      ema50:     r4(hE50[hN]  ?? hRecent[hN].close),
      ema200:    r4(hE200[hN] ?? hRecent[hN].close),
      rsi14:     r4(hRsi[hN]  ?? 50),
      bias:      htfBias(hRecent),
    };
  }

  return {
    symbol,
    timeframe,
    candleTime,
    session:    sessionFor(candleTime),
    regime:     regimes[n] ?? "ranging",
    currentBar: curr,
    indicators,
    structure,
    supportResistance,
    pivotPoints,
    fibonacci,
    volume,
    candlestickPatterns,
    chartPatterns: chartPatternNames,
    orderBlocks,
    fairValueGaps,
    trend,
    momentum,
    volatility,
    htf,
  };
}
