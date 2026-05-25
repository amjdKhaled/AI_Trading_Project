// ============================================================
// Trend & Momentum Engine — EMA, RSI, MACD, ATR (all per-bar arrays)
// ============================================================

import type { OhlcvBar, TrendState, MomentumState, VolatilityState } from "./types";

export function emaArray(values: number[], period: number): number[] {
  const result: number[] = [];
  const k = 2 / (period + 1);
  let prev = values[0] ?? 0;
  for (let i = 0; i < values.length; i++) {
    if (i === 0) { result.push(values[0] ?? 0); continue; }
    const v = (values[i] ?? prev) * k + prev * (1 - k);
    result.push(v);
    prev = v;
  }
  return result;
}

export function rsiArray(closes: number[], period = 14): number[] {
  const result: number[] = [];
  let gain = 0, loss = 0;
  const n = closes.length;

  for (let i = 1; i <= Math.min(period, n - 1); i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gain += change;
    else loss -= change;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = 0; i < Math.min(period, n); i++) result.push(50);

  for (let i = period; i < n; i++) {
    const change = closes[i] - closes[i - 1];
    const g = change > 0 ? change : 0;
    const l = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    const rs = avgGain / (avgLoss || 0.0001);
    result.push(100 - 100 / (1 + rs));
  }
  return result;
}

function macdArrays(closes: number[]): { hist: number[] } {
  const ema12 = emaArray(closes, 12);
  const ema26 = emaArray(closes, 26);
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signal = emaArray(macdLine, 9);
  const hist = macdLine.map((v, i) => v - signal[i]);
  return { hist };
}

function atrArray(bars: OhlcvBar[], period = 14): number[] {
  const tr: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i === 0) { tr.push(bars[i].high - bars[i].low); continue; }
    const h = bars[i].high, l = bars[i].low, p = bars[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - p), Math.abs(l - p)));
  }
  return emaArray(tr, period);
}

export function analyzeTrendMomentumVolatility(bars: OhlcvBar[]): {
  trend: TrendState;
  momentum: MomentumState;
  volatility: VolatilityState;
  ema20: number[];
  ema50: number[];
  ema200: number[];
  atrValues: number[];
  rsiValues: number[];
  macdHist: number[];
} {
  const closes = bars.map(b => b.close);
  const ema20   = emaArray(closes, 20);
  const ema50   = emaArray(closes, 50);
  const ema200  = emaArray(closes, 200);
  const rsiVals = rsiArray(closes, 14);
  const { hist: macdHistArr } = macdArrays(closes);
  const atrVals = atrArray(bars, 14);

  const last = bars.length - 1;
  const c = closes[last];
  const e20 = ema20[last];
  const e50 = ema50[last];
  const e200 = ema200[last];

  const emaAligned     = c > e20 && e20 > e50 && e50 > e200;
  const emaBearAligned = c < e20 && e20 < e50 && e50 < e200;

  let direction: "up" | "down" | "sideways" = "sideways";
  if (emaAligned) direction = "up";
  else if (emaBearAligned) direction = "down";
  else if (c > e50) direction = "up";
  else if (c < e50) direction = "down";

  const dist = Math.abs(c - e20) / (atrVals[last] || 1);
  const strength = Math.min(100, dist * 25);

  let pullbackQuality = 50;
  if (direction === "up")        pullbackQuality = c > e20 ? 90 : c > e50 ? 70 : 40;
  else if (direction === "down") pullbackQuality = c < e20 ? 90 : c < e50 ? 70 : 40;

  const exhaustion = (direction === "up"   && rsiVals[last] > 78 && dist > 3) ||
                     (direction === "down"  && rsiVals[last] < 22 && dist > 3);

  const trend: TrendState = { direction, strength, emaAligned: emaAligned || emaBearAligned, pullbackQuality, exhaustion };

  const rsiVal   = rsiVals[last];
  const macdHist = macdHistArr[last];
  const macdPrev = macdHistArr[last - 1] ?? 0;

  let divergence: "bullish" | "bearish" | "none" = "none";
  if (last > 10) {
    if (closes[last] > closes[last - 5] && rsiVals[last] < rsiVals[last - 5]) divergence = "bearish";
    if (closes[last] < closes[last - 5] && rsiVals[last] > rsiVals[last - 5]) divergence = "bullish";
  }

  let hiddenDivergence: "bullish" | "bearish" | "none" = "none";
  if (direction === "up"   && rsiVal < 40 && c > e50)  hiddenDivergence = "bullish";
  if (direction === "down" && rsiVal > 60 && c < e50)  hiddenDivergence = "bearish";

  const momentum: MomentumState = {
    rsi: rsiVal,
    macdHist,
    divergence,
    hiddenDivergence,
    accelerating: Math.abs(macdHist) > Math.abs(macdPrev) * 1.2 && macdHist * macdPrev > 0,
    strength: Math.min(100, Math.abs(macdHist) * 50 + (rsiVal > 50 ? rsiVal - 50 : 50 - rsiVal)),
  };

  const currentATR = atrVals[last];
  const atr20Slice = atrVals.slice(-20);
  const atrAvg     = atr20Slice.reduce((s, v) => s + v, 0) / atr20Slice.length || 1;
  const atrChange  = currentATR / atrAvg;

  const volatility: VolatilityState = {
    atr: currentATR,
    expanding:   atrChange > 1.3,
    contracting: atrChange < 0.7,
    compression: atrChange < 0.5,
    breakoutProbability: atrChange < 0.5
      ? Math.min(100, 30 + (1 / (atrChange || 0.1)) * 10)
      : Math.min(100, atrChange > 1.3 ? 60 : 40),
  };

  return { trend, momentum, volatility, ema20, ema50, ema200, atrValues: atrVals, rsiValues: rsiVals, macdHist: macdHistArr };
}
