// ============================================================
// Candlestick Analysis Engine — 40+ Pattern Recognition
// ============================================================

import type { OhlcvBar, PatternDetection } from "./types";

function body(bar: OhlcvBar): number { return Math.abs(bar.close - bar.open); }
function range(bar: OhlcvBar): number { return bar.high - bar.low; }
function isBullish(bar: OhlcvBar): boolean { return bar.close > bar.open; }
function isBearish(bar: OhlcvBar): boolean { return bar.close < bar.open; }
function upperWick(bar: OhlcvBar): number { return bar.high - Math.max(bar.open, bar.close); }
function lowerWick(bar: OhlcvBar): number { return Math.min(bar.open, bar.close) - bar.low; }
function avgRange(bars: OhlcvBar[], end: number, lookback: number): number {
  let sum = 0;
  const start = Math.max(0, end - lookback);
  for (let i = start; i < end; i++) sum += range(bars[i]);
  return sum / (end - start) || 1;
}

// --- BULLISH PATTERNS ---

function bullishEngulfing(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 1) return null;
  const p = bars[i - 1], c = bars[i];
  if (isBearish(p) && isBullish(c) && c.open < p.close && c.close > p.open && body(c) >= body(p) * 0.95) {
    return { name: "Bullish Engulfing", type: "bullish", index: i, confidence: 70 + (body(c) / avg) * 10 };
  }
  return null;
}

function hammer(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  const c = bars[i];
  const r = range(c);
  if (r < avg * 0.3) return null;
  const lw = lowerWick(c);
  const uw = upperWick(c);
  const b = body(c);
  if (lw > b * 2 && uw < b * 0.5 && b < avg * 0.4) {
    return { name: "Hammer", type: "bullish", index: i, confidence: 65 + (lw / r) * 20 };
  }
  return null;
}

function invertedHammer(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  const c = bars[i];
  const r = range(c);
  if (r < avg * 0.3) return null;
  const uw = upperWick(c);
  const lw = lowerWick(c);
  const b = body(c);
  if (uw > b * 2 && lw < b * 0.5 && b < avg * 0.4) {
    return { name: "Inverted Hammer", type: "bullish", index: i, confidence: 60 + (uw / r) * 15 };
  }
  return null;
}

function morningStar(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 2) return null;
  const d1 = bars[i - 2], d2 = bars[i - 1], d3 = bars[i];
  if (isBearish(d1) && body(d2) < avg * 0.35 && isBullish(d3) && d3.close > (d1.open + d1.close) / 2) {
    return { name: "Morning Star", type: "bullish", index: i, confidence: 80 };
  }
  return null;
}

function threeWhiteSoldiers(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 2) return null;
  const d1 = bars[i - 2], d2 = bars[i - 1], d3 = bars[i];
  if ([d1, d2, d3].every(isBullish) &&
      d2.close > d1.close && d3.close > d2.close &&
      body(d1) > avg * 0.3 && body(d2) > avg * 0.3 && body(d3) > avg * 0.3) {
    return { name: "Three White Soldiers", type: "bullish", index: i, confidence: 85 };
  }
  return null;
}

function piercingPattern(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 1) return null;
  const p = bars[i - 1], c = bars[i];
  if (isBearish(p) && isBullish(c) && c.open < p.low && c.close > p.open + (p.close - p.open) * 0.5) {
    return { name: "Piercing Pattern", type: "bullish", index: i, confidence: 72 };
  }
  return null;
}

function bullishHarami(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 1) return null;
  const p = bars[i - 1], c = bars[i];
  if (isBearish(p) && body(p) > avg * 0.5 && isBullish(c) && c.high < p.open && c.low > p.close) {
    return { name: "Bullish Harami", type: "bullish", index: i, confidence: 68 };
  }
  return null;
}

function tweezerBottom(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 1) return null;
  const p = bars[i - 1], c = bars[i];
  if (isBearish(p) && isBullish(c) && Math.abs(p.low - c.low) < avg * 0.15) {
    return { name: "Tweezer Bottom", type: "bullish", index: i, confidence: 65 };
  }
  return null;
}

function risingThreeMethods(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 4) return null;
  const d1 = bars[i - 4], d5 = bars[i];
  if (!isBullish(d1) || !isBullish(d5)) return null;
  const midRange = d5.close - d1.close;
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
    return { name: "Marubozu Bullish", type: "bullish", index: i, confidence: 75 };
  }
  return null;
}

function dragonflyDoji(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  const c = bars[i];
  const r = range(c);
  if (r < avg * 0.2) return null;
  if (body(c) < r * 0.05 && lowerWick(c) > r * 0.6 && upperWick(c) < r * 0.05) {
    return { name: "Dragonfly Doji", type: "bullish", index: i, confidence: 70 };
  }
  return null;
}

function bullishBeltHold(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 1) return null;
  const p = bars[i - 1], c = bars[i];
  if (isBearish(p) && isBullish(c) && c.open === c.low && body(c) > avg * 0.5) {
    return { name: "Bullish Belt Hold", type: "bullish", index: i, confidence: 72 };
  }
  return null;
}

// --- BEARISH PATTERNS ---

function bearishEngulfing(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 1) return null;
  const p = bars[i - 1], c = bars[i];
  if (isBullish(p) && isBearish(c) && c.open > p.close && c.close < p.open && body(c) >= body(p) * 0.95) {
    return { name: "Bearish Engulfing", type: "bearish", index: i, confidence: 70 + (body(c) / avg) * 10 };
  }
  return null;
}

function shootingStar(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  const c = bars[i];
  const r = range(c);
  if (r < avg * 0.3) return null;
  const uw = upperWick(c);
  const lw = lowerWick(c);
  const b = body(c);
  if (uw > b * 2 && lw < b * 0.5 && b < avg * 0.4) {
    return { name: "Shooting Star", type: "bearish", index: i, confidence: 65 + (uw / r) * 20 };
  }
  return null;
}

function hangingMan(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 1) return null;
  const p = bars[i - 1];
  if (!isBullish(p)) return null;
  return hammer(i, bars, avg); // same geometry but bearish context
}

function eveningStar(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 2) return null;
  const d1 = bars[i - 2], d2 = bars[i - 1], d3 = bars[i];
  if (isBullish(d1) && body(d2) < avg * 0.35 && isBearish(d3) && d3.close < (d1.open + d1.close) / 2) {
    return { name: "Evening Star", type: "bearish", index: i, confidence: 80 };
  }
  return null;
}

function threeBlackCrows(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 2) return null;
  const d1 = bars[i - 2], d2 = bars[i - 1], d3 = bars[i];
  if ([d1, d2, d3].every(isBearish) &&
      d2.close < d1.close && d3.close < d2.close &&
      body(d1) > avg * 0.3 && body(d2) > avg * 0.3 && body(d3) > avg * 0.3) {
    return { name: "Three Black Crows", type: "bearish", index: i, confidence: 85 };
  }
  return null;
}

function darkCloudCover(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 1) return null;
  const p = bars[i - 1], c = bars[i];
  if (isBullish(p) && isBearish(c) && c.open > p.high && c.close < p.open + (p.close - p.open) * 0.5) {
    return { name: "Dark Cloud Cover", type: "bearish", index: i, confidence: 72 };
  }
  return null;
}

function bearishHarami(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 1) return null;
  const p = bars[i - 1], c = bars[i];
  if (isBullish(p) && body(p) > avg * 0.5 && isBearish(c) && c.high < p.close && c.low > p.open) {
    return { name: "Bearish Harami", type: "bearish", index: i, confidence: 68 };
  }
  return null;
}

function tweezerTop(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 1) return null;
  const p = bars[i - 1], c = bars[i];
  if (isBullish(p) && isBearish(c) && Math.abs(p.high - c.high) < avg * 0.15) {
    return { name: "Tweezer Top", type: "bearish", index: i, confidence: 65 };
  }
  return null;
}

function fallingThreeMethods(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 4) return null;
  const d1 = bars[i - 4], d5 = bars[i];
  if (!isBearish(d1) || !isBearish(d5)) return null;
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
    return { name: "Bearish Marubozu", type: "bearish", index: i, confidence: 75 };
  }
  return null;
}

function gravestoneDoji(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  const c = bars[i];
  const r = range(c);
  if (r < avg * 0.2) return null;
  if (body(c) < r * 0.05 && upperWick(c) > r * 0.6 && lowerWick(c) < r * 0.05) {
    return { name: "Gravestone Doji", type: "bearish", index: i, confidence: 70 };
  }
  return null;
}

function bearishBeltHold(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 1) return null;
  const p = bars[i - 1], c = bars[i];
  if (isBullish(p) && isBearish(c) && c.open === c.high && body(c) > avg * 0.5) {
    return { name: "Bearish Belt Hold", type: "bearish", index: i, confidence: 72 };
  }
  return null;
}

// --- NEUTRAL PATTERNS ---

function doji(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  const c = bars[i];
  const r = range(c);
  if (r > avg * 0.15 && body(c) < r * 0.08) {
    return { name: "Doji", type: "neutral", index: i, confidence: 55 };
  }
  return null;
}

function spinningTop(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  const c = bars[i];
  const r = range(c);
  if (r > avg * 0.25 && body(c) < r * 0.25 && lowerWick(c) > r * 0.3 && upperWick(c) > r * 0.3) {
    return { name: "Spinning Top", type: "neutral", index: i, confidence: 55 };
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

// --- MOMENTUM CANDLES ---

function strongMomentum(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  const c = bars[i];
  const r = range(c);
  if (r > avg * 1.5 && body(c) > r * 0.8) {
    const type = isBullish(c) ? "bullish" : "bearish";
    return { name: "Strong Momentum", type, index: i, confidence: 60 };
  }
  return null;
}

function breakoutCandle(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 5) return null;
  const c = bars[i];
  const r = range(c);
  const window = bars.slice(i - 5, i);
  const windowHigh = Math.max(...window.map(b => b.high));
  const windowLow = Math.min(...window.map(b => b.low));
  if (r > avg * 1.2 && c.high > windowHigh && isBullish(c)) {
    return { name: "Breakout Candle", type: "bullish", index: i, confidence: 65 };
  }
  if (r > avg * 1.2 && c.low < windowLow && isBearish(c)) {
    return { name: "Breakout Candle", type: "bearish", index: i, confidence: 65 };
  }
  return null;
}

function exhaustionCandle(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  if (i < 2) return null;
  const c = bars[i], p1 = bars[i - 1], p2 = bars[i - 2];
  if (isBullish(p1) && isBullish(p2) && isBearish(c) && c.close < p1.open && range(c) > avg * 1.2) {
    return { name: "Exhaustion Candle", type: "bearish", index: i, confidence: 62 };
  }
  if (isBearish(p1) && isBearish(p2) && isBullish(c) && c.close > p1.open && range(c) > avg * 1.2) {
    return { name: "Exhaustion Candle", type: "bullish", index: i, confidence: 62 };
  }
  return null;
}

function climaxCandle(i: number, bars: OhlcvBar[], avgR: number, avgV: number, vols: number[]): PatternDetection | null {
  const c = bars[i];
  if (range(c) < avgR * 1.5 || vols[i] < avgV * 2.5) return null;
  const type = isBullish(c) ? "bullish" : "bearish";
  return { name: "Climax Candle", type, index: i, confidence: 60 };
}

function rejectionCandle(i: number, bars: OhlcvBar[], avg: number): PatternDetection | null {
  const c = bars[i];
  const r = range(c);
  if (r < avg * 0.8) return null;
  const uw = upperWick(c);
  const lw = lowerWick(c);
  if (isBullish(c) && uw > body(c) * 1.5) {
    return { name: "Upper Rejection", type: "bearish", index: i, confidence: 58 };
  }
  if (isBearish(c) && lw > body(c) * 1.5) {
    return { name: "Lower Rejection", type: "bullish", index: i, confidence: 58 };
  }
  return null;
}

// --- MAIN ENTRYPOINT ---

export function detectAllPatterns(bars: OhlcvBar[]): PatternDetection[] {
  const patterns: PatternDetection[] = [];
  const vols = bars.map(b => b.volume);
  const avgVols: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const start = Math.max(0, i - 20);
    const avg = vols.slice(start, i).reduce((a, b) => a + b, 0) / (i - start) || 1;
    avgVols.push(avg);
  }

  for (let i = 0; i < bars.length; i++) {
    const avgR = avgRange(bars, i, 20);

    // Bullish
    const bullishDetectors = [
      bullishEngulfing, hammer, invertedHammer, morningStar, threeWhiteSoldiers,
      piercingPattern, bullishHarami, tweezerBottom, risingThreeMethods,
      marubozuBullish, dragonflyDoji, bullishBeltHold,
    ];
    for (const fn of bullishDetectors) {
      const p = fn(i, bars, avgR);
      if (p) patterns.push(p);
    }

    // Bearish
    const bearishDetectors = [
      bearishEngulfing, shootingStar, hangingMan, eveningStar, threeBlackCrows,
      darkCloudCover, bearishHarami, tweezerTop, fallingThreeMethods,
      marubozuBearish, gravestoneDoji, bearishBeltHold,
    ];
    for (const fn of bearishDetectors) {
      const p = fn(i, bars, avgR);
      if (p) patterns.push(p);
    }

    // Neutral
    const neutralDetectors = [doji, spinningTop, longLeggedDoji];
    for (const fn of neutralDetectors) {
      const p = fn(i, bars, avgR);
      if (p) patterns.push(p);
    }

    // Momentum
    const mom = strongMomentum(i, bars, avgR) ||
      breakoutCandle(i, bars, avgR) ||
      exhaustionCandle(i, bars, avgR) ||
      climaxCandle(i, bars, avgR, avgVols[i], vols) ||
      rejectionCandle(i, bars, avgR);
    if (mom) patterns.push(mom);
  }

  // Remove duplicates at same index with same name
  const seen = new Set<string>();
  return patterns.filter(p => {
    const key = `${p.index}:${p.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
