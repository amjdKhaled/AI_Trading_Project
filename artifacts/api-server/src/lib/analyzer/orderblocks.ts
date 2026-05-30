// ============================================================
// Order Block Detection
// Bullish OB: last bearish candle immediately before a strong
//             bullish impulse (institutional demand zone).
// Bearish OB: last bullish candle immediately before a strong
//             bearish impulse (institutional supply zone).
// Price returning to the OB zone = high-probability entry.
// ============================================================

import type { OhlcvBar } from "./types";

export interface OrderBlock {
  type:      "bullish" | "bearish";
  high:      number;
  low:       number;
  barIndex:  number;
  strength:  number;  // 0–100
}

const IMPULSE_ATR_MULT = 1.5;
const LOOKBACK         = 30;

function localAtr(bars: OhlcvBar[], end: number, period = 14): number {
  let sum = 0, count = 0;
  for (let i = Math.max(1, end - period); i <= end; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low  - bars[i - 1].close),
    );
    sum += tr; count++;
  }
  return count > 0 ? sum / count : 0;
}

export interface OBResult {
  bullishOB:   OrderBlock | null;
  bearishOB:   OrderBlock | null;
  inBullishOB: boolean;
  inBearishOB: boolean;
}

/**
 * Detect the most-recent valid order block zones within the last LOOKBACK bars.
 * `inBullishOB` / `inBearishOB` are true when current price is inside the zone.
 */
export function detectOrderBlocks(bars: OhlcvBar[], i: number): OBResult {
  const none: OBResult = { bullishOB: null, bearishOB: null, inBullishOB: false, inBearishOB: false };
  if (i < 5) return none;

  const atrVal = localAtr(bars, i);
  if (atrVal === 0) return none;

  const start        = Math.max(1, i - LOOKBACK);
  const currentPrice = bars[i].close;
  let bullishOB: OrderBlock | null = null;
  let bearishOB: OrderBlock | null = null;

  for (let j = start; j < i - 1; j++) {
    const bar  = bars[j];
    const next = bars[j + 1];

    // Bullish OB: bearish candle → next bar is strong bullish impulse
    if (bar.close < bar.open && next.close > next.open) {
      const impulseBody = next.close - next.open;
      if (impulseBody > atrVal * IMPULSE_ATR_MULT) {
        const strength = Math.min(100, (impulseBody / atrVal) * 30);
        if (!bullishOB || j > bullishOB.barIndex) {
          bullishOB = { type: "bullish", high: bar.high, low: bar.low, barIndex: j, strength };
        }
      }
    }

    // Bearish OB: bullish candle → next bar is strong bearish impulse
    if (bar.close > bar.open && next.close < next.open) {
      const impulseBody = next.open - next.close;
      if (impulseBody > atrVal * IMPULSE_ATR_MULT) {
        const strength = Math.min(100, (impulseBody / atrVal) * 30);
        if (!bearishOB || j > bearishOB.barIndex) {
          bearishOB = { type: "bearish", high: bar.high, low: bar.low, barIndex: j, strength };
        }
      }
    }
  }

  // Current price is inside the OB zone (tolerance: 0.2%)
  const inBullishOB = bullishOB !== null
    && currentPrice >= bullishOB.low  * 0.998
    && currentPrice <= bullishOB.high * 1.002;

  const inBearishOB = bearishOB !== null
    && currentPrice >= bearishOB.low  * 0.998
    && currentPrice <= bearishOB.high * 1.002;

  return { bullishOB, bearishOB, inBullishOB, inBearishOB };
}
