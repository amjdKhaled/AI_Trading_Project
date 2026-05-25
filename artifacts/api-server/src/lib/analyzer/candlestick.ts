// ============================================================
// Candlestick Analysis Engine — 50+ Pattern Recognition
// ============================================================

import type { OhlcvBar, PatternDetection } from "./types";

function body(bar: OhlcvBar): number  { return Math.abs(bar.close - bar.open); }
function range(bar: OhlcvBar): number { return bar.high - bar.low; }
function isBullish(bar: OhlcvBar): boolean { return bar.close > bar.open; }
function isBearish(bar: OhlcvBar): boolean { return bar.close < bar.open; }
function upperWick(bar: OhlcvBar): number { return bar.high - Math.max(bar.open, bar.close); }
function lowerWick(bar: OhlcvBar): number { return Math.min(bar.open, bar.close) - bar.low; }
function midPoint(bar: OhlcvBar): number  { return (bar.open + bar.close) / 2; }
function avgRange(bars: OhlcvBar[], end: number, lookback: number): number {
  let sum = 0;
  const start = Math.max(0, end - lookback);
  for (let i = start; i < end; i++) sum += range(bars[i]);
  return sum / (end - start) || 1;
}

// ================================================================
// BULLISH PATTERNS
// ================================================================

function bullishEngulfing(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 1) return null;
  const p = bars[i - 1], c = bars[i];
  if (isBearish(p) && isBullish(c) && c.open <= p.close && c.close >= p.open && body(c) >= body(p) * 0.95) {
    const conf = Math.min(95, 70 + (body(c) / avg) * 10);
    return { name: "Bullish Engulfing", type: "bullish", index: i, confidence: conf };
  }
  return null;
}

function hammer(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  const c = bars[i];
  const r = range(c);
  if (r < avg * 0.3) return null;
  const lw = lowerWick(c), uw = upperWick(c), b = body(c);
  if (lw > b * 2 && uw < b * 0.6 && b < avg * 0.5) {
    return { name: "Hammer", type: "bullish", index: i, confidence: Math.min(90, 65 + (lw / r) * 20) };
  }
  return null;
}

function invertedHammer(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  const c = bars[i];
  const r = range(c);
  if (r < avg * 0.3) return null;
  const uw = upperWick(c), lw = lowerWick(c), b = body(c);
  if (uw > b * 2 && lw < b * 0.6 && b < avg * 0.5) {
    return { name: "Inverted Hammer", type: "bullish", index: i, confidence: Math.min(85, 60 + (uw / r) * 15) };
  }
  return null;
}

function morningStar(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 2) return null;
  const d1 = bars[i - 2], d2 = bars[i - 1], d3 = bars[i];
  if (isBearish(d1) && body(d1) > avg * 0.4 &&
      body(d2) < avg * 0.35 &&
      isBullish(d3) && body(d3) > avg * 0.4 &&
      d3.close > midPoint(d1)) {
    return { name: "Morning Star", type: "bullish", index: i, confidence: 82 };
  }
  return null;
}

function threeWhiteSoldiers(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 2) return null;
  const d1 = bars[i - 2], d2 = bars[i - 1], d3 = bars[i];
  if ([d1, d2, d3].every(isBullish) &&
      d2.close > d1.close && d3.close > d2.close &&
      d2.open > d1.open && d3.open > d2.open &&
      body(d1) > avg * 0.3 && body(d2) > avg * 0.3 && body(d3) > avg * 0.3) {
    return { name: "Three White Soldiers", type: "bullish", index: i, confidence: 87 };
  }
  return null;
}

function piercingPattern(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 1) return null;
  const p = bars[i - 1], c = bars[i];
  if (isBearish(p) && body(p) > avg * 0.4 &&
      isBullish(c) && c.open < p.low &&
      c.close > p.open + (p.close - p.open) * 0.5) {
    return { name: "Piercing Pattern", type: "bullish", index: i, confidence: 74 };
  }
  return null;
}

function bullishHarami(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 1) return null;
  const p = bars[i - 1], c = bars[i];
  if (isBearish(p) && body(p) > avg * 0.5 &&
      isBullish(c) && c.high < p.open && c.low > p.close && body(c) < body(p) * 0.5) {
    return { name: "Bullish Harami", type: "bullish", index: i, confidence: 68 };
  }
  return null;
}

function tweezerBottom(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 1) return null;
  const p = bars[i - 1], c = bars[i];
  if (isBearish(p) && isBullish(c) &&
      Math.abs(p.low - c.low) < avg * 0.12 &&
      body(p) > avg * 0.2 && body(c) > avg * 0.2) {
    return { name: "Tweezer Bottom", type: "bullish", index: i, confidence: 67 };
  }
  return null;
}

function risingThreeMethods(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 4) return null;
  const d1 = bars[i - 4], d5 = bars[i];
  if (!isBullish(d1) || !isBullish(d5)) return null;
  if (body(d1) < avg * 0.4 || body(d5) < avg * 0.4) return null;
  if (d5.close <= d1.close) return null;
  for (let j = i - 3; j < i; j++) {
    if (bars[j].close < d1.close || bars[j].open > d5.open) return null;
    if (body(bars[j]) > avg * 0.5) return null;
  }
  return { name: "Rising Three Methods", type: "bullish", index: i, confidence: 78 };
}

function marubozuBullish(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  const c = bars[i];
  if (!isBullish(c)) return null;
  const r = range(c);
  if (r > avg * 0.6 && lowerWick(c) < r * 0.05 && upperWick(c) < r * 0.05) {
    return { name: "Marubozu Bullish", type: "bullish", index: i, confidence: 76 };
  }
  return null;
}

function dragonflyDoji(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  const c = bars[i];
  const r = range(c);
  if (r < avg * 0.2) return null;
  if (body(c) < r * 0.05 && lowerWick(c) > r * 0.65 && upperWick(c) < r * 0.06) {
    return { name: "Dragonfly Doji", type: "bullish", index: i, confidence: 72 };
  }
  return null;
}

function bullishBeltHold(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 1) return null;
  const p = bars[i - 1], c = bars[i];
  if (isBearish(p) && isBullish(c) &&
      Math.abs(c.open - c.low) < avg * 0.03 &&
      body(c) > avg * 0.5) {
    return { name: "Bullish Belt Hold", type: "bullish", index: i, confidence: 72 };
  }
  return null;
}

function bullishKicker(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 1) return null;
  const p = bars[i - 1], c = bars[i];
  if (isBearish(p) && isBullish(c) &&
      c.open > p.open &&
      body(c) > avg * 0.4) {
    return { name: "Bullish Kicker", type: "bullish", index: i, confidence: 86 };
  }
  return null;
}

function matchingLow(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 1) return null;
  const p = bars[i - 1], c = bars[i];
  if (isBearish(p) && Math.abs(c.close - p.close) < avg * 0.08 && Math.abs(c.low - p.low) < avg * 0.10) {
    return { name: "Matching Low", type: "bullish", index: i, confidence: 66 };
  }
  return null;
}

function bullishAbandonedBaby(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 2) return null;
  const d1 = bars[i - 2], d2 = bars[i - 1], d3 = bars[i];
  if (!isBearish(d1) || !isBullish(d3)) return null;
  if (body(d2) > avg * 0.12) return null;
  const d2IsIsolatedLow = d2.high < d1.low && d3.low > d2.high;
  if (d2IsIsolatedLow && body(d3) > avg * 0.35) {
    return { name: "Bullish Abandoned Baby", type: "bullish", index: i, confidence: 84 };
  }
  return null;
}

// ================================================================
// BEARISH PATTERNS
// ================================================================

function bearishEngulfing(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 1) return null;
  const p = bars[i - 1], c = bars[i];
  if (isBullish(p) && isBearish(c) && c.open >= p.close && c.close <= p.open && body(c) >= body(p) * 0.95) {
    const conf = Math.min(95, 70 + (body(c) / avg) * 10);
    return { name: "Bearish Engulfing", type: "bearish", index: i, confidence: conf };
  }
  return null;
}

function shootingStar(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  const c = bars[i];
  const r = range(c);
  if (r < avg * 0.3) return null;
  const uw = upperWick(c), lw = lowerWick(c), b = body(c);
  if (uw > b * 2 && lw < b * 0.6 && b < avg * 0.5) {
    return { name: "Shooting Star", type: "bearish", index: i, confidence: Math.min(90, 65 + (uw / r) * 20) };
  }
  return null;
}

function hangingMan(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 3) return null;
  const recent = bars.slice(i - 3, i);
  if (!recent.every(isBullish)) return null;
  const h = hammer(i, bars, avg);
  if (h) return { ...h, name: "Hanging Man", type: "bearish", confidence: h.confidence - 5 };
  return null;
}

function eveningStar(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 2) return null;
  const d1 = bars[i - 2], d2 = bars[i - 1], d3 = bars[i];
  if (isBullish(d1) && body(d1) > avg * 0.4 &&
      body(d2) < avg * 0.35 &&
      isBearish(d3) && body(d3) > avg * 0.4 &&
      d3.close < midPoint(d1)) {
    return { name: "Evening Star", type: "bearish", index: i, confidence: 82 };
  }
  return null;
}

function threeBlackCrows(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 2) return null;
  const d1 = bars[i - 2], d2 = bars[i - 1], d3 = bars[i];
  if ([d1, d2, d3].every(isBearish) &&
      d2.close < d1.close && d3.close < d2.close &&
      d2.open < d1.open && d3.open < d2.open &&
      body(d1) > avg * 0.3 && body(d2) > avg * 0.3 && body(d3) > avg * 0.3) {
    return { name: "Three Black Crows", type: "bearish", index: i, confidence: 87 };
  }
  return null;
}

function darkCloudCover(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 1) return null;
  const p = bars[i - 1], c = bars[i];
  if (isBullish(p) && body(p) > avg * 0.4 &&
      isBearish(c) && c.open > p.high &&
      c.close < p.open + (p.close - p.open) * 0.5) {
    return { name: "Dark Cloud Cover", type: "bearish", index: i, confidence: 74 };
  }
  return null;
}

function bearishHarami(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 1) return null;
  const p = bars[i - 1], c = bars[i];
  if (isBullish(p) && body(p) > avg * 0.5 &&
      isBearish(c) && c.high < p.close && c.low > p.open && body(c) < body(p) * 0.5) {
    return { name: "Bearish Harami", type: "bearish", index: i, confidence: 68 };
  }
  return null;
}

function tweezerTop(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 1) return null;
  const p = bars[i - 1], c = bars[i];
  if (isBullish(p) && isBearish(c) &&
      Math.abs(p.high - c.high) < avg * 0.12 &&
      body(p) > avg * 0.2 && body(c) > avg * 0.2) {
    return { name: "Tweezer Top", type: "bearish", index: i, confidence: 67 };
  }
  return null;
}

function fallingThreeMethods(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 4) return null;
  const d1 = bars[i - 4], d5 = bars[i];
  if (!isBearish(d1) || !isBearish(d5)) return null;
  if (body(d1) < avg * 0.4 || body(d5) < avg * 0.4) return null;
  if (d5.close >= d1.close) return null;
  for (let j = i - 3; j < i; j++) {
    if (bars[j].close > d1.close || bars[j].open < d5.open) return null;
    if (body(bars[j]) > avg * 0.5) return null;
  }
  return { name: "Falling Three Methods", type: "bearish", index: i, confidence: 78 };
}

function marubozuBearish(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  const c = bars[i];
  if (!isBearish(c)) return null;
  const r = range(c);
  if (r > avg * 0.6 && lowerWick(c) < r * 0.05 && upperWick(c) < r * 0.05) {
    return { name: "Bearish Marubozu", type: "bearish", index: i, confidence: 76 };
  }
  return null;
}

function gravestoneDoji(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  const c = bars[i];
  const r = range(c);
  if (r < avg * 0.2) return null;
  if (body(c) < r * 0.05 && upperWick(c) > r * 0.65 && lowerWick(c) < r * 0.06) {
    return { name: "Gravestone Doji", type: "bearish", index: i, confidence: 72 };
  }
  return null;
}

function bearishBeltHold(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 1) return null;
  const p = bars[i - 1], c = bars[i];
  if (isBullish(p) && isBearish(c) &&
      Math.abs(c.open - c.high) < avg * 0.03 &&
      body(c) > avg * 0.5) {
    return { name: "Bearish Belt Hold", type: "bearish", index: i, confidence: 72 };
  }
  return null;
}

function bearishKicker(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 1) return null;
  const p = bars[i - 1], c = bars[i];
  if (isBullish(p) && isBearish(c) &&
      c.open < p.open &&
      body(c) > avg * 0.4) {
    return { name: "Bearish Kicker", type: "bearish", index: i, confidence: 86 };
  }
  return null;
}

function deliberation(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 2) return null;
  const d1 = bars[i - 2], d2 = bars[i - 1], d3 = bars[i];
  if (!isBullish(d1) || !isBullish(d2)) return null;
  if (body(d1) < avg * 0.4 || body(d2) < avg * 0.4) return null;
  if (d2.close <= d1.close) return null;
  if (body(d3) < avg * 0.15 && d3.open >= d2.close * 0.998) {
    return { name: "Deliberation", type: "bearish", index: i, confidence: 70 };
  }
  return null;
}

function bearishAbandonedBaby(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 2) return null;
  const d1 = bars[i - 2], d2 = bars[i - 1], d3 = bars[i];
  if (!isBullish(d1) || !isBearish(d3)) return null;
  if (body(d2) > avg * 0.12) return null;
  const d2IsIsolatedHigh = d2.low > d1.high && d3.high < d2.low;
  if (d2IsIsolatedHigh && body(d3) > avg * 0.35) {
    return { name: "Bearish Abandoned Baby", type: "bearish", index: i, confidence: 84 };
  }
  return null;
}

// ================================================================
// NEUTRAL PATTERNS
// ================================================================

function doji(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  const c = bars[i];
  const r = range(c);
  if (r > avg * 0.15 && body(c) < r * 0.07) {
    return { name: "Doji", type: "neutral", index: i, confidence: 55 };
  }
  return null;
}

function longLeggedDoji(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  const c = bars[i];
  const r = range(c);
  if (r > avg * 0.5 && body(c) < r * 0.05 && lowerWick(c) > r * 0.4 && upperWick(c) > r * 0.4) {
    return { name: "Long-Legged Doji", type: "neutral", index: i, confidence: 55 };
  }
  return null;
}

function spinningTop(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  const c = bars[i];
  const r = range(c);
  if (r > avg * 0.25 && body(c) < r * 0.25 && lowerWick(c) > r * 0.3 && upperWick(c) > r * 0.3) {
    return { name: "Spinning Top", type: "neutral", index: i, confidence: 52 };
  }
  return null;
}

function highWave(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  const c = bars[i];
  const r = range(c);
  if (r < avg * 0.8) return null;
  const lw = lowerWick(c), uw = upperWick(c), b = body(c);
  if (lw > r * 0.3 && uw > r * 0.3 && b < r * 0.3) {
    return { name: "High Wave", type: "neutral", index: i, confidence: 50 };
  }
  return null;
}

function rickshawMan(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  const c = bars[i];
  const r = range(c);
  if (r < avg * 0.5) return null;
  const lw = lowerWick(c), uw = upperWick(c), b = body(c);
  if (b < r * 0.05 && Math.abs(lw - uw) < r * 0.15 && lw > r * 0.35) {
    return { name: "Rickshaw Man", type: "neutral", index: i, confidence: 50 };
  }
  return null;
}

// ================================================================
// MOMENTUM / ADVANCED CANDLE ANALYSIS
// ================================================================

function strongMomentum(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  const c = bars[i];
  const r = range(c);
  if (r > avg * 1.6 && body(c) > r * 0.75) {
    const type = isBullish(c) ? "bullish" : "bearish";
    return { name: "Momentum Candle", type, index: i, confidence: 62 };
  }
  return null;
}

function breakoutCandle(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 5) return null;
  const c = bars[i];
  const r = range(c);
  const window = bars.slice(i - 5, i);
  const windowHigh = Math.max(...window.map(b => b.high));
  const windowLow  = Math.min(...window.map(b => b.low));
  if (r > avg * 1.2 && c.close > windowHigh && isBullish(c)) {
    return { name: "Breakout Candle", type: "bullish", index: i, confidence: 68 };
  }
  if (r > avg * 1.2 && c.close < windowLow && isBearish(c)) {
    return { name: "Breakout Candle", type: "bearish", index: i, confidence: 68 };
  }
  return null;
}

function exhaustionCandle(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 3) return null;
  const c = bars[i], p1 = bars[i - 1], p2 = bars[i - 2], p3 = bars[i - 3];
  if ([p1, p2, p3].every(isBullish) && isBearish(c) && c.close < p1.open && range(c) > avg * 1.3) {
    return { name: "Exhaustion Candle", type: "bearish", index: i, confidence: 65 };
  }
  if ([p1, p2, p3].every(isBearish) && isBullish(c) && c.close > p1.open && range(c) > avg * 1.3) {
    return { name: "Exhaustion Candle", type: "bullish", index: i, confidence: 65 };
  }
  return null;
}

function climaxCandle(i: number, bars: OhlcvBar[], avgR: number, avgV: number): PatternDetection | null {
  const c = bars[i];
  if (range(c) < avgR * 1.5 || c.volume < avgV * 2.5) return null;
  const type = isBullish(c) ? "bullish" : "bearish";
  return { name: "Climax Candle", type, index: i, confidence: 60 };
}

function rejectionCandle(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  const c = bars[i];
  const r = range(c);
  if (r < avg * 0.8) return null;
  if (isBullish(c) && upperWick(c) > body(c) * 1.8) {
    return { name: "Upper Rejection", type: "bearish", index: i, confidence: 60 };
  }
  if (isBearish(c) && lowerWick(c) > body(c) * 1.8) {
    return { name: "Lower Rejection", type: "bullish", index: i, confidence: 60 };
  }
  return null;
}

function imbalanceCandle(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 1 || i >= bars.length - 1) return null;
  const prev = bars[i - 1], curr = bars[i], next = bars[i + 1];
  const r = range(curr);
  if (r < avg * 1.5) return null;
  if (isBullish(curr) && curr.low > prev.high && next.open >= curr.close * 0.998) {
    return { name: "Bullish Imbalance", type: "bullish", index: i, confidence: 65 };
  }
  if (isBearish(curr) && curr.high < prev.low && next.open <= curr.close * 1.002) {
    return { name: "Bearish Imbalance", type: "bearish", index: i, confidence: 65 };
  }
  return null;
}

// ================================================================
// MAIN ENTRYPOINT
// ================================================================

export function detectAllPatterns(bars: OhlcvBar[]): PatternDetection[] {
  const patterns: PatternDetection[] = [];
  const vols = bars.map(b => b.volume);
  const avgVols: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const start = Math.max(0, i - 20);
    const slice = vols.slice(start, i);
    avgVols.push(slice.length > 0 ? slice.reduce((a, b) => a + b, 0) / slice.length : 1);
  }

  for (let i = 0; i < bars.length; i++) {
    const avgR = avgRange(bars, i, 20);

    const bullishDetectors = [
      bullishEngulfing, hammer, invertedHammer, morningStar, threeWhiteSoldiers,
      piercingPattern, bullishHarami, tweezerBottom, risingThreeMethods,
      marubozuBullish, dragonflyDoji, bullishBeltHold, bullishKicker,
      matchingLow, bullishAbandonedBaby,
    ];
    for (const fn of bullishDetectors) {
      const p = fn(i, bars, avgR);
      if (p) patterns.push(p);
    }

    const bearishDetectors = [
      bearishEngulfing, shootingStar, hangingMan, eveningStar, threeBlackCrows,
      darkCloudCover, bearishHarami, tweezerTop, fallingThreeMethods,
      marubozuBearish, gravestoneDoji, bearishBeltHold, bearishKicker,
      deliberation, bearishAbandonedBaby,
    ];
    for (const fn of bearishDetectors) {
      const p = fn(i, bars, avgR);
      if (p) patterns.push(p);
    }

    const neutralDetectors = [doji, longLeggedDoji, spinningTop, highWave, rickshawMan];
    for (const fn of neutralDetectors) {
      const p = fn(i, bars, avgR);
      if (p) patterns.push(p);
    }

    const advDetectors: Array<PatternDetection | null> = [
      strongMomentum(i, bars, avgR),
      breakoutCandle(i, bars, avgR),
      exhaustionCandle(i, bars, avgR),
      climaxCandle(i, bars, avgR, avgVols[i]),
      rejectionCandle(i, bars, avgR),
      imbalanceCandle(i, bars, avgR),
    ];
    for (const p of advDetectors) if (p) patterns.push(p);
  }

  const seen = new Set<string>();
  return patterns.filter(p => {
    const key = `${p.index}:${p.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
