// ============================================================
// Market Structure Engine — HH, HL, LH, LL, BOS, CHOCH
// ============================================================

import type { OhlcvBar, StructurePoint } from "./types";

function swingHighsLows(bars: OhlcvBar[], lookback = 5): StructurePoint[] {
  const points: StructurePoint[] = [];
  for (let i = lookback; i < bars.length - lookback; i++) {
    const c = bars[i];
    let isHigh = true, isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (bars[i - j].high >= c.high) isHigh = false;
      if (bars[i - j].low <= c.low) isLow = false;
      if (bars[i + j].high > c.high) isHigh = false;
      if (bars[i + j].low < c.low) isLow = false;
    }
    if (isHigh) points.push({ index: i, time: c.time, price: c.high, type: "swing-high" });
    if (isLow) points.push({ index: i, time: c.time, price: c.low, type: "swing-low" });
  }
  return points;
}

export function analyzeStructure(bars: OhlcvBar[]): {
  points: StructurePoint[];
  regime: "uptrend" | "downtrend" | "ranging";
  bosCount: number;
  chochCount: number;
  lastBosDir: "bullish" | "bearish" | null;
  lastChochDir: "bullish" | "bearish" | null;
} {
  const swings = swingHighsLows(bars, 4);
  const points: StructurePoint[] = [];
  let regime: "uptrend" | "downtrend" | "ranging" = "ranging";
  let bosCount = 0;
  let chochCount = 0;
  let lastBosDir: "bullish" | "bearish" | null = null;
  let lastChochDir: "bullish" | "bearish" | null = null;

  // Filter alternating swing highs/lows
  const filtered: StructurePoint[] = [];
  for (const s of swings) {
    if (filtered.length === 0) { filtered.push(s); continue; }
    const last = filtered[filtered.length - 1];
    if (last.type === s.type) {
      // Same type: keep the more extreme
      if (s.type === "swing-high" && s.price > last.price) filtered[filtered.length - 1] = s;
      else if (s.type === "swing-low" && s.price < last.price) filtered[filtered.length - 1] = s;
    } else {
      filtered.push(s);
    }
  }

  // Classify HH/HL/LH/LL
  for (let i = 1; i < filtered.length; i++) {
    const curr = filtered[i];
    const prev = filtered[i - 1];
    const prevRegime = regime;
    if (curr.type === "swing-high") {
      if (prev.type === "swing-high") {
        if (curr.price > prev.price) {
          points.push({ ...curr, type: "HH" });
          if (prevRegime !== "uptrend") { chochCount++; lastChochDir = "bullish"; }
          regime = "uptrend";
          bosCount++;
          lastBosDir = "bullish";
        } else {
          points.push({ ...curr, type: "LH" });
          if (prevRegime === "uptrend") { chochCount++; lastChochDir = "bearish"; }
          regime = "downtrend";
        }
      }
    } else if (curr.type === "swing-low") {
      if (prev.type === "swing-low") {
        if (curr.price > prev.price) {
          points.push({ ...curr, type: "HL" });
          if (prevRegime !== "uptrend") { chochCount++; lastChochDir = "bullish"; }
          regime = "uptrend";
        } else {
          points.push({ ...curr, type: "LL" });
          if (prevRegime === "uptrend") { chochCount++; lastChochDir = "bearish"; }
          regime = "downtrend";
          bosCount++;
          lastBosDir = "bearish";
        }
      }
    }
  }

  return { points, regime, bosCount, chochCount, lastBosDir, lastChochDir };
}

export function isAtKeyLevel(bar: OhlcvBar, points: StructurePoint[], tolerance: number): boolean {
  for (const p of points) {
    if (Math.abs(bar.high - p.price) < tolerance || Math.abs(bar.low - p.price) < tolerance) {
      return true;
    }
  }
  return false;
}
