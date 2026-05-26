// ============================================================
// Market Regime Classifier — per-bar adaptive context
// ============================================================
// Returns a coarse regime label for each bar so the signal scorer can
// adjust thresholds: high-conviction signals fire in trending or
// vol-expansion regimes; chop regimes require a higher bar.
//
// Inputs are reused from analyzeTrendMomentumVolatility so we don't
// recompute EMAs/ATR here.
// ============================================================

import type { OhlcvBar } from "./types";

export type Regime =
  | "trending-up"
  | "trending-down"
  | "ranging"
  | "chop"
  | "vol-expansion"
  | "vol-compression";

export function classifyRegimes(
  bars: OhlcvBar[],
  ema20: number[],
  ema50: number[],
  ema200: number[],
  atrValues: number[],
): Regime[] {
  const n = bars.length;
  const out: Regime[] = new Array(n).fill("ranging");

  // Rolling 20-bar ATR mean for expansion/compression detection.
  // Precompute prefix sums for O(1) windowed averages.
  const atrPrefix: number[] = new Array(n + 1).fill(0);
  for (let i = 0; i < n; i++) atrPrefix[i + 1] = atrPrefix[i] + atrValues[i];

  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const c = b.close;
    const e20  = ema20[i]   ?? c;
    const e50  = ema50[i]   ?? c;
    const e200 = ema200[i]  ?? c;
    const atr  = atrValues[i] ?? Math.max(b.high - b.low, c * 0.005);

    // Rolling 20-bar ATR avg (lookback only)
    const lb       = Math.min(20, i);
    const atrAvg20 = lb > 0 ? (atrPrefix[i] - atrPrefix[i - lb]) / lb : atr;
    const atrRatio = atrAvg20 > 0 ? atr / atrAvg20 : 1;

    // EMA-stack alignment & spread (in ATR units)
    const stackBull = e20 > e50 && e50 > e200;
    const stackBear = e20 < e50 && e50 < e200;
    const spread    = Math.abs(e20 - e50) / (atr || 1);

    // Distance of price from EMA20 in ATR units (trend strength proxy)
    const distAtr   = Math.abs(c - e20) / (atr || 1);

    // ── Classification priority (most specific first) ─────────────────
    if (atrRatio > 1.6 && distAtr > 1.5) {
      out[i] = "vol-expansion";
    } else if (atrRatio < 0.55) {
      out[i] = "vol-compression";
    } else if (stackBull && c > e50 && spread > 0.4) {
      out[i] = "trending-up";
    } else if (stackBear && c < e50 && spread > 0.4) {
      out[i] = "trending-down";
    } else if (atrRatio < 0.85 && spread < 0.3) {
      // Low volatility + EMAs tightly stacked = chop
      out[i] = "chop";
    } else {
      out[i] = "ranging";
    }
  }
  return out;
}
