// ============================================================
// Volume Analysis Engine — RVOL, Spikes, Absorption, Distribution
// ============================================================

import type { OhlcvBar, VolumeAnalysis } from "./types";

export function analyzeVolume(bars: OhlcvBar[], index: number, lookback = 20): VolumeAnalysis {
  const c     = bars[index];
  const start = Math.max(0, index - lookback);
  const window = bars.slice(start, index);

  if (window.length === 0) {
    return { rvol: 1, spike: false, climax: false, absorption: false, breakoutVol: false, distribution: false, accumulation: false };
  }

  const avgVol  = window.reduce((s, b) => s + b.volume, 0) / window.length;
  const rvol    = c.volume / (avgVol || 1);

  // Recent volume trend (last 5 bars before current)
  const recent5 = bars.slice(Math.max(0, index - 5), index);
  const recentAvgVol = recent5.length > 0 ? recent5.reduce((s, b) => s + b.volume, 0) / recent5.length : avgVol;

  // Price position within bar range (0 = low, 1 = high)
  const barRange    = c.high - c.low || 0.0001;
  const closePos    = (c.close - c.low) / barRange; // 0–1
  const bodyRatio   = Math.abs(c.close - c.open) / barRange;

  // Average bar range for breakout detection
  const avgRange = window.reduce((s, b) => s + (b.high - b.low), 0) / window.length || 1;

  // RVOL spike: current bar volume is significantly above average
  const spike = rvol > 2.0;

  // Climax: huge volume + small body (buyers/sellers exhausted)
  const climax = rvol > 3.5 && bodyRatio < 0.25;

  // Absorption: big volume + tiny net movement (one side absorbing the other)
  const absorption = rvol > 2.0 && bodyRatio < 0.15;

  // Breakout volume: wide bar + above-average volume
  const breakoutVol = (c.high - c.low) > avgRange * 1.5 && rvol > 1.8;

  // Distribution: volume rising on down close (selling pressure)
  // Requires: above-avg volume, close in lower half, bar closed down, and recent trend shows rising volume
  const distribution = rvol > 1.5 && closePos < 0.4 && c.close < c.open && recentAvgVol > avgVol * 1.1;

  // Accumulation: above-avg volume, close in upper half, bar closed up, candle has bullish character
  // Fixed: no longer requires recent vol to be BELOW average (contradicted rvol > 1.5)
  const accumulation = rvol > 1.5 && closePos > 0.6 && c.close > c.open && bodyRatio > 0.3;

  return { rvol, spike, climax, absorption, breakoutVol, distribution, accumulation };
}

export function volumeDivergence(bars: OhlcvBar[], lookback = 14): "bullish" | "bearish" | "none" {
  if (bars.length < lookback * 2) return "none";
  const first  = bars.slice(-lookback * 2, -lookback);
  const second = bars.slice(-lookback);

  const price1High = Math.max(...first.map(b => b.high));
  const price2High = Math.max(...second.map(b => b.high));
  const vol1 = first.reduce((s, b) => s + b.volume, 0);
  const vol2 = second.reduce((s, b) => s + b.volume, 0);

  if (price2High > price1High && vol2 < vol1 * 0.85) return "bearish";
  if (price2High < price1High && vol2 > vol1 * 1.15) return "bullish";
  return "none";
}
