// ============================================================
// Fair Value Gap (FVG / Imbalance) Detection
// A 3-bar imbalance zone where no trading occurred.
//   Bullish FVG: bars[i-2].high < bars[i].low  — gap upward
//   Bearish FVG: bars[i-2].low  > bars[i].high — gap downward
// Price returning to an unfilled FVG = high-probability setup.
// ============================================================

import type { OhlcvBar } from "./types";

export interface FairValueGap {
  type:     "bullish" | "bearish";
  top:      number;   // upper edge of gap
  bottom:   number;   // lower edge of gap
  barIndex: number;   // index of bar[i] (the third bar of the 3-bar pattern)
  filled:   boolean;
  gapSize:  number;
}

const LOOKBACK          = 40;
const MIN_GAP_ATR_RATIO = 0.25;

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

export interface FVGResult {
  bullishFVG:   FairValueGap | null;
  bearishFVG:   FairValueGap | null;
  inBullishFVG: boolean;
  inBearishFVG: boolean;
}

/**
 * Detect the most-recent unfilled FVG zones and whether current price is inside one.
 * Only unfilled FVGs are returned — once price returns to fill >50% of the gap, it is
 * marked filled and no longer triggers the bonus.
 */
export function detectFVGs(bars: OhlcvBar[], i: number): FVGResult {
  const none: FVGResult = { bullishFVG: null, bearishFVG: null, inBullishFVG: false, inBearishFVG: false };
  if (i < 4) return none;

  const atrVal = localAtr(bars, i);
  const minGap = atrVal * MIN_GAP_ATR_RATIO;
  const start  = Math.max(2, i - LOOKBACK);
  const price  = bars[i].close;

  let bullishFVG: FairValueGap | null = null;
  let bearishFVG: FairValueGap | null = null;

  for (let j = start; j <= i; j++) {
    if (j < 2) continue;
    const p2  = bars[j - 2];
    const cur = bars[j];

    // Bullish FVG: prev-2 bar high < current bar low
    const bullGap = cur.low - p2.high;
    if (bullGap > minGap) {
      let filled = false;
      for (let k = j + 1; k <= i; k++) {
        if (bars[k].low <= p2.high + bullGap * 0.5) { filled = true; break; }
      }
      if (!bullishFVG || j > bullishFVG.barIndex) {
        bullishFVG = { type: "bullish", top: cur.low, bottom: p2.high, barIndex: j, filled, gapSize: bullGap };
      }
    }

    // Bearish FVG: prev-2 bar low > current bar high
    const bearGap = p2.low - cur.high;
    if (bearGap > minGap) {
      let filled = false;
      for (let k = j + 1; k <= i; k++) {
        if (bars[k].high >= p2.low - bearGap * 0.5) { filled = true; break; }
      }
      if (!bearishFVG || j > bearishFVG.barIndex) {
        bearishFVG = { type: "bearish", top: p2.low, bottom: cur.high, barIndex: j, filled, gapSize: bearGap };
      }
    }
  }

  // Only trigger bonus for unfilled FVGs (price entering to fill = setup)
  const inBullishFVG = bullishFVG !== null && !bullishFVG.filled
    && price >= bullishFVG.bottom * 0.998
    && price <= bullishFVG.top    * 1.002;

  const inBearishFVG = bearishFVG !== null && !bearishFVG.filled
    && price >= bearishFVG.bottom * 0.998
    && price <= bearishFVG.top    * 1.002;

  return { bullishFVG, bearishFVG, inBullishFVG, inBearishFVG };
}
