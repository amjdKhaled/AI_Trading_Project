// ============================================================
// Trend & Momentum Engine — EMA, RSI, MACD, Trend Strength
// ============================================================

import type { OhlcvBar, TrendState, MomentumState, VolatilityState } from "./types";

// --- EMA ---
function ema(values: number[], period: number): number[] {
  const result: number[] = [];
  const k = 2 / (period + 1);
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    if (i === 0) { result.push(values[0]); continue; }
    const v = values[i] * k + prev * (1 - k);
    result.push(v);
    prev = v;
  }
  return result;
}

// --- RSI ---
function rsi(closes: number[], period = 14): number[] {
  const result: number[] = [];
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gain += change;
    else loss -= change;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = 0; i < period; i++) result.push(50);

  for (let i = period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const g = change > 0 ? change : 0;
    const l = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    const rs = avgGain / (avgLoss || 0.001);
    result.push(100 - 100 / (1 + rs));
  }
  return result;
}

// --- MACD ---
function macd(closes: number[]): { macd: number[]; signal: number[]; hist: number[] } {
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signalLine = ema(macdLine, 9);
  const hist = macdLine.map((v, i) => v - signalLine[i]);
  return { macd: macdLine, signal: signalLine, hist };
}

// --- ATR ---
function atr(bars: OhlcvBar[], period = 14): number[] {
  const tr: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i === 0) { tr.push(bars[i].high - bars[i].low); continue; }
    const h = bars[i].high, l = bars[i].low, p = bars[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - p), Math.abs(l - p)));
  }
  return ema(tr, period);
}

// --- MAIN ---
export function analyzeTrendMomentumVolatility(bars: OhlcvBar[]): {
  trend: TrendState;
  momentum: MomentumState;
  volatility: VolatilityState;
  ema20: number[];
  ema50: number[];
  ema200: number[];
  atrValues: number[];
} {
  const closes = bars.map(b => b.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const rsiVals = rsi(closes);
  const macdVals = macd(closes);
  const atrVals = atr(bars);

  const last = bars.length - 1;
  const c = closes[last];

  // Trend direction
  const e20 = ema20[last];
  const e50 = ema50[last];
  const e200 = ema200[last];
  const emaAligned = c > e20 && e20 > e50 && e50 > e200;
  const emaBearAligned = c < e20 && e20 < e50 && e50 < e200;

  let direction: "up" | "down" | "sideways" = "sideways";
  if (emaAligned) direction = "up";
  else if (emaBearAligned) direction = "down";
  else if (c > e50) direction = "up";
  else if (c < e50) direction = "down";

  // Trend strength (distance from EMA20 relative to ATR)
  const dist = Math.abs(c - e20) / (atrVals[last] || 1);
  const strength = Math.min(100, dist * 25);

  // Pullback quality
  let pullbackQuality = 50;
  if (direction === "up") {
    pullbackQuality = c > e20 ? 90 : c > e50 ? 70 : 40;
  } else if (direction === "down") {
    pullbackQuality = c < e20 ? 90 : c < e50 ? 70 : 40;
  }

  // Exhaustion: far from EMA200 + extreme RSI
  const exhaustion = (direction === "up" && rsiVals[last] > 75 && dist > 3) ||
    (direction === "down" && rsiVals[last] < 25 && dist > 3);

  const trend: TrendState = { direction, strength, emaAligned: emaAligned || emaBearAligned, pullbackQuality, exhaustion };

  // Momentum
  const rsiVal = rsiVals[last];
  const macdHist = macdVals.hist[last];
  const macdPrev = macdVals.hist[last - 1] || 0;

  // Divergence detection (simplified)
  let divergence: "bullish" | "bearish" | "none" = "none";
  if (last > 10) {
    const priceUp = closes[last] > closes[last - 5];
    const rsiDown = rsiVals[last] < rsiVals[last - 5];
    if (priceUp && rsiDown) divergence = "bearish";
    const priceDown = closes[last] < closes[last - 5];
    const rsiUp = rsiVals[last] > rsiVals[last - 5];
    if (priceDown && rsiUp) divergence = "bullish";
  }

  // Hidden divergence (trend direction aligned, indicator disagrees)
  let hiddenDivergence: "bullish" | "bearish" | "none" = "none";
  if (direction === "up" && rsiVal < 40 && closes[last] > e50) hiddenDivergence = "bullish";
  if (direction === "down" && rsiVal > 60 && closes[last] < e50) hiddenDivergence = "bearish";

  const momentum: MomentumState = {
    rsi: rsiVal,
    macdHist,
    divergence,
    hiddenDivergence,
    accelerating: Math.abs(macdHist) > Math.abs(macdPrev) * 1.2 && macdHist * macdPrev > 0,
    strength: Math.min(100, Math.abs(macdHist) * 50 + (rsiVal > 50 ? rsiVal - 50 : 50 - rsiVal)),
  };

  // Volatility
  const currentATR = atrVals[last];
  const atr20 = atrVals.slice(-20);
  const atrAvg = atr20.reduce((s, v) => s + v, 0) / atr20.length || 1;
  const atrChange = currentATR / atrAvg;
  const expanding = atrChange > 1.3;
  const contracting = atrChange < 0.7;
  const compression = atrChange < 0.5;

  // Breakout probability from compression
  const recentRange = Math.max(...bars.slice(-20).map(b => b.high)) - Math.min(...bars.slice(-20).map(b => b.low));
  const breakoutProbability = compression
    ? Math.min(100, 30 + (1 / (atrChange || 0.1)) * 10)
    : Math.min(100, expanding ? 60 : 40);

  const volatility: VolatilityState = {
    atr: currentATR,
    expanding,
    contracting,
    compression,
    breakoutProbability,
  };

  return { trend, momentum, volatility, ema20, ema50, ema200, atrValues: atrVals };
}
