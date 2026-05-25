// ============================================================
// Chart Pattern Recognition Engine — Flags, Triangles, H&S, etc.
// ============================================================

import type { OhlcvBar, PatternDetection } from "./types";

// --- Utility ---
function avgRange(bars: OhlcvBar[], end: number, lookback: number): number {
  let sum = 0;
  const start = Math.max(0, end - lookback);
  for (let i = start; i < end; i++) sum += bars[i].high - bars[i].low;
  return sum / (end - start) || 1;
}

function linregSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-10) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

function isParallelish(s1: number, s2: number, tolerance = 0.3): boolean {
  return Math.abs(s1 - s2) / (Math.abs(s1) + Math.abs(s2) + 1e-10) < tolerance;
}

function isConverging(s1: number, s2: number): boolean {
  return (s1 > 0 && s2 < 0) || (s1 < 0 && s2 > 0);
}

// --- BULL FLAG ---
function bullFlag(i: number, bars: OhlcvBar[]): PatternDetection | null {
  if (i < 10) return null;
  const poleStart = bars[i - 10];
  const poleEnd = bars[i - 5];
  const flagStart = i - 5;
  const flagEnd = i;
  // Strong pole
  if ((poleEnd.close - poleStart.close) / (poleStart.close || 1) < 0.03) return null;
  // Consolidation
  const flagBars = bars.slice(flagStart, flagEnd);
  const flagHighs = flagBars.map(b => b.high);
  const flagLows = flagBars.map(b => b.low);
  const highsSlope = linregSlope(flagHighs);
  const lowsSlope = linregSlope(flagLows);
  // Parallel downsloping or flat
  if (!isParallelish(highsSlope, lowsSlope, 0.5)) return null;
  if (highsSlope > 0.001) return null; // flag should be down or flat
  return { name: "Bull Flag", type: "bullish", index: i, confidence: 70 };
}

// --- BEAR FLAG ---
function bearFlag(i: number, bars: OhlcvBar[]): PatternDetection | null {
  if (i < 10) return null;
  const poleStart = bars[i - 10];
  const poleEnd = bars[i - 5];
  if ((poleStart.close - poleEnd.close) / (poleStart.close || 1) < 0.03) return null;
  const flagBars = bars.slice(i - 5, i);
  const highsSlope = linregSlope(flagBars.map(b => b.high));
  const lowsSlope = linregSlope(flagBars.map(b => b.low));
  if (!isParallelish(highsSlope, lowsSlope, 0.5)) return null;
  if (lowsSlope < -0.001) return null;
  return { name: "Bear Flag", type: "bearish", index: i, confidence: 70 };
}

// --- ASCENDING TRIANGLE ---
function ascendingTriangle(i: number, bars: OhlcvBar[]): PatternDetection | null {
  if (i < 8) return null;
  const window = bars.slice(i - 8, i);
  const highs = window.map(b => b.high);
  const lows = window.map(b => b.low);
  const highSlope = linregSlope(highs);
  const lowSlope = linregSlope(lows);
  // Flat top, rising bottom
  if (Math.abs(highSlope) > 0.001) return null;
  if (lowSlope < 0.0005) return null;
  return { name: "Ascending Triangle", type: "bullish", index: i, confidence: 68 };
}

// --- DESCENDING TRIANGLE ---
function descendingTriangle(i: number, bars: OhlcvBar[]): PatternDetection | null {
  if (i < 8) return null;
  const window = bars.slice(i - 8, i);
  const highs = window.map(b => b.high);
  const lows = window.map(b => b.low);
  const highSlope = linregSlope(highs);
  const lowSlope = linregSlope(lows);
  if (Math.abs(lowSlope) > 0.001) return null;
  if (highSlope > -0.0005) return null;
  return { name: "Descending Triangle", type: "bearish", index: i, confidence: 68 };
}

// --- SYMMETRICAL TRIANGLE ---
function symmetricalTriangle(i: number, bars: OhlcvBar[]): PatternDetection | null {
  if (i < 10) return null;
  const window = bars.slice(i - 10, i);
  const highs = window.map(b => b.high);
  const lows = window.map(b => b.low);
  const highSlope = linregSlope(highs);
  const lowSlope = linregSlope(lows);
  if (!isConverging(highSlope, lowSlope)) return null;
  if (Math.abs(highSlope) < 0.0003 || Math.abs(lowSlope) < 0.0003) return null;
  return { name: "Symmetrical Triangle", type: "neutral", index: i, confidence: 55 };
}

// --- WEDGE (Rising) ---
function risingWedge(i: number, bars: OhlcvBar[]): PatternDetection | null {
  if (i < 10) return null;
  const window = bars.slice(i - 10, i);
  const highs = window.map(b => b.high);
  const lows = window.map(b => b.low);
  const highSlope = linregSlope(highs);
  const lowSlope = linregSlope(lows);
  if (highSlope < 0.0005 || lowSlope < 0.0005) return null;
  if (!isConverging(highSlope, lowSlope)) return null;
  return { name: "Rising Wedge", type: "bearish", index: i, confidence: 72 };
}

// --- WEDGE (Falling) ---
function fallingWedge(i: number, bars: OhlcvBar[]): PatternDetection | null {
  if (i < 10) return null;
  const window = bars.slice(i - 10, i);
  const highs = window.map(b => b.high);
  const lows = window.map(b => b.low);
  const highSlope = linregSlope(highs);
  const lowSlope = linregSlope(lows);
  if (highSlope > -0.0005 || lowSlope > -0.0005) return null;
  if (!isConverging(highSlope, lowSlope)) return null;
  return { name: "Falling Wedge", type: "bullish", index: i, confidence: 72 };
}

// --- DOUBLE TOP ---
function doubleTop(i: number, bars: OhlcvBar[]): PatternDetection | null {
  if (i < 15) return null;
  // Find two highs with a valley in between
  const window = bars.slice(i - 15, i);
  const highs = window.map((b, idx) => ({ price: b.high, idx: idx + i - 15 }));
  const sorted = [...highs].sort((a, b) => b.price - a.price).slice(0, 3);
  if (sorted.length < 2) return null;
  const top1 = sorted[0], top2 = sorted[1];
  const gap = Math.abs(top1.idx - top2.idx);
  if (gap < 4 || gap > 12) return null;
  const tolerance = avgRange(bars, i, 10) * 0.3;
  if (Math.abs(top1.price - top2.price) > tolerance) return null;
  // Valley between them
  const valleyIdx = Math.min(top1.idx, top2.idx) + Math.floor(gap / 2);
  const valley = Math.min(...bars.slice(Math.min(top1.idx, top2.idx), Math.max(top1.idx, top2.idx)).map(b => b.low));
  if (bars[valleyIdx]?.low > valley * 0.98) return null;
  return { name: "Double Top", type: "bearish", index: i, confidence: 75 };
}

// --- DOUBLE BOTTOM ---
function doubleBottom(i: number, bars: OhlcvBar[]): PatternDetection | null {
  if (i < 15) return null;
  const window = bars.slice(i - 15, i);
  const lows = window.map((b, idx) => ({ price: b.low, idx: idx + i - 15 }));
  const sorted = [...lows].sort((a, b) => a.price - b.price).slice(0, 3);
  if (sorted.length < 2) return null;
  const bot1 = sorted[0], bot2 = sorted[1];
  const gap = Math.abs(bot1.idx - bot2.idx);
  if (gap < 4 || gap > 12) return null;
  const tolerance = avgRange(bars, i, 10) * 0.3;
  if (Math.abs(bot1.price - bot2.price) > tolerance) return null;
  return { name: "Double Bottom", type: "bullish", index: i, confidence: 75 };
}

// --- CHANNEL ---
function channel(i: number, bars: OhlcvBar[]): PatternDetection | null {
  if (i < 12) return null;
  const window = bars.slice(i - 12, i);
  const highs = window.map(b => b.high);
  const lows = window.map(b => b.low);
  const highSlope = linregSlope(highs);
  const lowSlope = linregSlope(lows);
  if (!isParallelish(highSlope, lowSlope, 0.4)) return null;
  if (Math.abs(highSlope) < 0.0002) return null;
  const type = highSlope > 0 ? "bullish" : "bearish";
  return { name: "Channel", type, index: i, confidence: 60 };
}

// --- HEAD AND SHOULDERS ---
function headAndShoulders(i: number, bars: OhlcvBar[]): PatternDetection | null {
  if (i < 20) return null;
  const window = bars.slice(i - 20, i);
  const highs = window.map(b => b.high);
  // Find 3 peaks: left shoulder < head > right shoulder
  const peaks: number[] = [];
  for (let j = 2; j < highs.length - 2; j++) {
    if (highs[j] > highs[j - 1] && highs[j] > highs[j - 2] && highs[j] > highs[j + 1] && highs[j] > highs[j + 2]) {
      peaks.push(j);
    }
  }
  if (peaks.length < 3) return null;
  for (let a = 0; a < peaks.length - 2; a++) {
    for (let b = a + 1; b < peaks.length - 1; b++) {
      for (let c = b + 1; c < peaks.length; c++) {
        const ls = highs[peaks[a]], h = highs[peaks[b]], rs = highs[peaks[c]];
        const tol = avgRange(bars, i, 10) * 0.35;
        if (h > ls && h > rs && Math.abs(ls - rs) < tol && peaks[b] - peaks[a] > 3 && peaks[c] - peaks[b] > 3) {
          return { name: "Head and Shoulders", type: "bearish", index: i, confidence: 78 };
        }
      }
    }
  }
  return null;
}

// --- INVERSE HEAD AND SHOULDERS ---
function inverseHeadAndShoulders(i: number, bars: OhlcvBar[]): PatternDetection | null {
  if (i < 20) return null;
  const window = bars.slice(i - 20, i);
  const lows = window.map(b => b.low);
  const troughs: number[] = [];
  for (let j = 2; j < lows.length - 2; j++) {
    if (lows[j] < lows[j - 1] && lows[j] < lows[j - 2] && lows[j] < lows[j + 1] && lows[j] < lows[j + 2]) {
      troughs.push(j);
    }
  }
  if (troughs.length < 3) return null;
  for (let a = 0; a < troughs.length - 2; a++) {
    for (let b = a + 1; b < troughs.length - 1; b++) {
      for (let c = b + 1; c < troughs.length; c++) {
        const ls = lows[troughs[a]], h = lows[troughs[b]], rs = lows[troughs[c]];
        const tol = avgRange(bars, i, 10) * 0.35;
        if (h < ls && h < rs && Math.abs(ls - rs) < tol && troughs[b] - troughs[a] > 3 && troughs[c] - troughs[b] > 3) {
          return { name: "Inverse H&S", type: "bullish", index: i, confidence: 78 };
        }
      }
    }
  }
  return null;
}

// --- CUP AND HANDLE ---
function cupAndHandle(i: number, bars: OhlcvBar[]): PatternDetection | null {
  if (i < 20) return null;
  const window = bars.slice(i - 20, i);
  const half = Math.floor(window.length / 2);
  const left = window.slice(0, half);
  const right = window.slice(half, window.length - 3);
  if (right.length < 3) return null;
  // U-shape: both sides similar height, bottom in middle
  const leftAvg = left.reduce((s, b) => s + b.close, 0) / left.length;
  const rightAvg = right.reduce((s, b) => s + b.close, 0) / right.length;
  const midLow = Math.min(...window.map(b => b.low));
  const midHigh = Math.max(...window.map(b => b.high));
  const tol = (midHigh - midLow) * 0.2;
  if (Math.abs(leftAvg - rightAvg) < tol && midLow < Math.min(leftAvg, rightAvg)) {
    // Handle: small pullback/consolidation at the end
    const handle = window.slice(-5);
    const handleRange = Math.max(...handle.map(b => b.high)) - Math.min(...handle.map(b => b.low));
    if (handleRange < (midHigh - midLow) * 0.35) {
      return { name: "Cup and Handle", type: "bullish", index: i, confidence: 74 };
    }
  }
  return null;
}

// --- MAIN ENTRYPOINT ---

const PATTERN_DETECTORS = [
  bullFlag, bearFlag, ascendingTriangle, descendingTriangle,
  symmetricalTriangle, risingWedge, fallingWedge,
  doubleTop, doubleBottom, channel,
  headAndShoulders, inverseHeadAndShoulders,
  cupAndHandle,
];

export function detectChartPatterns(bars: OhlcvBar[]): PatternDetection[] {
  const results: PatternDetection[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < bars.length; i++) {
    for (const fn of PATTERN_DETECTORS) {
      try {
        const p = fn(i, bars);
        if (p) {
          const key = `${p.index}:${p.name}`;
          if (!seen.has(key)) { seen.add(key); results.push(p); }
        }
      } catch { /* skip on edge cases */ }
    }
  }
  return results;
}
