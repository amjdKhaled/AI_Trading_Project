// ============================================================
// Volume Analysis Engine — RVOL, Spikes, Absorption, Distribution
// ============================================================

import type { OhlcvBar, VolumeAnalysis } from "./types";

export function analyzeVolume(bars: OhlcvBar[], index: number, lookback = 20): VolumeAnalysis {
  const c = bars[index];
  const start = Math.max(0, index - lookback);
  const window = bars.slice(start, index);
  const avgVol = window.reduce((s, b) => s + b.volume, 0) / window.length || 1;
  const rvol = c.volume / avgVol;

  // Trend of recent volume
  const volTrend = index > 5
    ? bars.slice(index - 5, index).reduce((s, b) => s + b.volume, 0) / 5
    : avgVol;

  const spike = rvol > 2.0;
  const climax = rvol > 3.5 && (c.close - c.open) / (c.high - c.low || 1) < 0.3;
  const absorption = rvol > 2.0 && Math.abs(c.close - c.open) < (c.high - c.low) * 0.15;

  // Breakout volume: big range + big volume
  const avgRange = window.reduce((s, b) => s + (b.high - b.low), 0) / window.length || 1;
  const breakoutVol = (c.high - c.low) > avgRange * 1.5 && rvol > 1.8;

  // Distribution vs accumulation (simplified)
  const distribution = rvol > 1.5 && c.close < (c.high + c.low) / 2 && volTrend > avgVol * 1.3;
  const accumulation = rvol > 1.5 && c.close > (c.high + c.low) / 2 && volTrend < avgVol * 0.8;

  return { rvol, spike, climax, absorption, breakoutVol, distribution, accumulation };
}

export function volumeDivergence(bars: OhlcvBar[], lookback = 14): "bullish" | "bearish" | "none" {
  if (bars.length < lookback * 2) return "none";
  const first = bars.slice(-lookback * 2, -lookback);
  const second = bars.slice(-lookback);

  const price1High = Math.max(...first.map(b => b.high));
  const price2High = Math.max(...second.map(b => b.high));
  const vol1 = first.reduce((s, b) => s + b.volume, 0);
  const vol2 = second.reduce((s, b) => s + b.volume, 0);

  if (price2High > price1High && vol2 < vol1 * 0.85) return "bearish";
  if (price2High < price1High && vol2 > vol1 * 1.15) return "bullish";
  return "none";
}
