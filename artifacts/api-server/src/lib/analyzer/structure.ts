// ============================================================
// Market Structure Engine — HH, HL, LH, LL, BOS, CHOCH
// ============================================================

import type { OhlcvBar, StructurePoint } from "./types";

/**
 * Find pivot swing highs and lows using a symmetric lookback window.
 * A bar is a swing-high if its high is strictly greater than all bars
 * within `lookback` bars on each side. Same for lows.
 */
function swingHighsLows(bars: OhlcvBar[], lookback = 5): StructurePoint[] {
  const points: StructurePoint[] = [];
  for (let i = lookback; i < bars.length - lookback; i++) {
    const c = bars[i];
    let isHigh = true, isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (bars[i - j].high >= c.high || bars[i + j].high > c.high) isHigh = false;
      if (bars[i - j].low <= c.low  || bars[i + j].low  < c.low)  isLow  = false;
    }
    if (isHigh) points.push({ index: i, time: c.time, price: c.high, type: "swing-high" });
    if (isLow)  points.push({ index: i, time: c.time, price: c.low,  type: "swing-low"  });
  }
  return points;
}

/**
 * Build an alternating high/low chain: consecutive same-type pivots are
 * merged (keeping the more extreme). This prevents double-tops/bottoms
 * from being treated as separate structure points.
 */
function alternateSwings(swings: StructurePoint[]): StructurePoint[] {
  const out: StructurePoint[] = [];
  for (const s of swings) {
    if (out.length === 0) { out.push(s); continue; }
    const last = out[out.length - 1];
    if (last.type === s.type) {
      // Same type: keep the more extreme pivot (highest high / lowest low)
      if (s.type === "swing-high" && s.price > last.price) out[out.length - 1] = s;
      else if (s.type === "swing-low" && s.price < last.price) out[out.length - 1] = s;
    } else {
      out.push(s);
    }
  }
  return out;
}

export function analyzeStructure(bars: OhlcvBar[]): {
  points: StructurePoint[];
  regime: "uptrend" | "downtrend" | "ranging";
  bosCount: number;
  chochCount: number;
  lastBosDir: "bullish" | "bearish" | null;
  lastChochDir: "bullish" | "bearish" | null;
  lastSwingHigh: number;
  lastSwingLow: number;
} {
  const swings   = swingHighsLows(bars, 4);
  const filtered = alternateSwings(swings);

  const points: StructurePoint[] = [];
  let regime: "uptrend" | "downtrend" | "ranging" = "ranging";
  let bosCount   = 0;
  let chochCount = 0;
  let lastBosDir:   "bullish" | "bearish" | null = null;
  let lastChochDir: "bullish" | "bearish" | null = null;

  // Track the most recent swing high and swing low separately.
  // This is the correct way to detect HH/HL/LH/LL:
  //   HH = current swing-high > previous swing-high → bullish BOS
  //   HL = current swing-low  > previous swing-low  → bullish continuation
  //   LH = current swing-high < previous swing-high → potential bearish CHOCH
  //   LL = current swing-low  < previous swing-low  → bearish BOS
  let prevHigh: StructurePoint | null = null;
  let prevLow:  StructurePoint | null = null;

  for (const curr of filtered) {
    if (curr.type === "swing-high") {
      if (prevHigh) {
        if (curr.price > prevHigh.price) {
          // Higher High — bullish BOS
          points.push({ ...curr, type: "HH" });
          bosCount++;
          lastBosDir = "bullish";
          if (regime !== "uptrend") { chochCount++; lastChochDir = "bullish"; }
          regime = "uptrend";
        } else {
          // Lower High — bearish CHOCH signal
          points.push({ ...curr, type: "LH" });
          if (regime === "uptrend") { chochCount++; lastChochDir = "bearish"; }
          regime = "downtrend";
        }
      }
      prevHigh = curr;

    } else {
      // swing-low
      if (prevLow) {
        if (curr.price > prevLow.price) {
          // Higher Low — bullish continuation / structural support
          points.push({ ...curr, type: "HL" });
          if (regime !== "uptrend") { chochCount++; lastChochDir = "bullish"; }
          regime = "uptrend";
        } else {
          // Lower Low — bearish BOS
          points.push({ ...curr, type: "LL" });
          bosCount++;
          lastBosDir = "bearish";
          if (regime === "uptrend") { chochCount++; lastChochDir = "bearish"; }
          regime = "downtrend";
        }
      }
      prevLow = curr;
    }
  }

  // Use raw swing extremes as key levels
  const swingHighs = filtered.filter(p => p.type === "swing-high");
  const swingLows  = filtered.filter(p => p.type === "swing-low");
  const lastSwingHigh = swingHighs.length ? swingHighs[swingHighs.length - 1].price : (bars[bars.length - 1]?.high ?? 0);
  const lastSwingLow  = swingLows.length  ? swingLows[swingLows.length - 1].price   : (bars[bars.length - 1]?.low  ?? 0);

  return { points, regime, bosCount, chochCount, lastBosDir, lastChochDir, lastSwingHigh, lastSwingLow };
}

export function isAtKeyLevel(bar: OhlcvBar, points: StructurePoint[], tolerance: number): boolean {
  for (const p of points) {
    if (Math.abs(bar.high - p.price) < tolerance || Math.abs(bar.low - p.price) < tolerance) return true;
  }
  return false;
}
