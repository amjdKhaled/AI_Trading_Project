import type { OhlcvBar } from "./finnhub";

// ─── Simple moving indicators for signal engine ──────────────────────────────

export function ema(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const result: number[] = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

export function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function atr(bars: OhlcvBar[], period = 14): number {
  if (bars.length < period + 1) return (bars[bars.length - 1]?.close ?? 500) * 0.002;
  const trs: number[] = [];
  for (let i = bars.length - period; i < bars.length; i++) {
    const prev = bars[i - 1].close;
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - prev),
      Math.abs(bars[i].low - prev),
    );
    trs.push(tr);
  }
  return trs.reduce((a, b) => a + b, 0) / period;
}

export function vwap(bars: OhlcvBar[]): number {
  let cumPV = 0, cumV = 0;
  for (const b of bars) {
    const tp = (b.high + b.low + b.close) / 3;
    cumPV += tp * b.volume;
    cumV += b.volume;
  }
  return cumV > 0 ? cumPV / cumV : bars[bars.length - 1]?.close ?? 0;
}

export function macd(
  closes: number[],
): { macdLine: number; signal: number; histogram: number } {
  const fast = ema(closes, 12);
  const slow = ema(closes, 26);
  if (!fast.length || !slow.length) return { macdLine: 0, signal: 0, histogram: 0 };
  // align lengths
  const offset = slow.length - fast.length; // slow is shorter since period is longer
  const macdLine = fast[fast.length - 1] - slow[slow.length - 1 - Math.max(0, offset)];
  const signalVal = macdLine * 0.9; // simplified
  return { macdLine, signal: signalVal, histogram: macdLine - signalVal };
}

export interface MarketRegime {
  trend: "up" | "down" | "range";
  volatile: boolean;
  choppy: boolean;
}

export function detectRegime(bars: OhlcvBar[]): MarketRegime {
  if (bars.length < 20) return { trend: "range", volatile: false, choppy: false };
  const closes = bars.map((b) => b.close);
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const last9 = ema9[ema9.length - 1];
  const last21 = ema21[ema21.length - 1];
  const price = closes[closes.length - 1];

  // ATR-based volatility
  const atrVal = atr(bars, 14);
  const atrPct = atrVal / price;
  const volatile = atrPct > 0.008;

  // Chop: compare range to ATR
  const recentBars = bars.slice(-10);
  const range = Math.max(...recentBars.map((b) => b.high)) - Math.min(...recentBars.map((b) => b.low));
  const choppy = range < atrVal * 2.5;

  let trend: "up" | "down" | "range" = "range";
  if (last9 > last21 * 1.001 && price > last9) trend = "up";
  else if (last9 < last21 * 0.999 && price < last9) trend = "down";

  return { trend, volatile, choppy };
}

export interface SignalScore {
  side: "long" | "short" | null;
  confidence: number; // 0–100
  pattern: string;
  regime: string;
  atrVal: number;
}

export function scoreSignal(bars: OhlcvBar[]): SignalScore {
  const n = bars.length;
  if (n < 30) return { side: null, confidence: 0, pattern: "insufficient_data", regime: "range", atrVal: 0 };

  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume);
  const last = bars[n - 1];
  const prev = bars[n - 2];

  const rsiVal = rsi(closes);
  const atrVal = atr(bars, 14);
  const vwapVal = vwap(bars.slice(-78)); // session VWAP (approx 6.5h / 5m = 78 bars)
  const { macdLine, histogram } = macd(closes);
  const { trend, volatile, choppy } = detectRegime(bars);
  const ema9Arr = ema(closes, 9);
  const ema21Arr = ema(closes, 21);
  const ema9 = ema9Arr[ema9Arr.length - 1];
  const ema21 = ema21Arr[ema21Arr.length - 1];

  // Volume confirmation
  const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volSurge = last.volume > avgVol * 1.3;

  // Anti-chop filter
  if (choppy && !volatile) return { side: null, confidence: 0, pattern: "chop_filter", regime: trend, atrVal };

  // Pattern detection
  const bullEngulf = last.close > last.open && prev.close < prev.open &&
    last.close > prev.open && last.open < prev.close;
  const bearEngulf = last.close < last.open && prev.close > prev.open &&
    last.close < prev.open && last.open > prev.close;

  const hammerBody = Math.abs(last.close - last.open);
  const lowerWick = Math.min(last.close, last.open) - last.low;
  const upperWick = last.high - Math.max(last.close, last.open);
  const hammer = lowerWick > hammerBody * 2 && upperWick < hammerBody * 0.5;
  const shootingStar = upperWick > hammerBody * 2 && lowerWick < hammerBody * 0.5;

  const vwapBounce = last.low < vwapVal && last.close > vwapVal;
  const vwapReject = last.high > vwapVal && last.close < vwapVal;

  // Score LONG
  let longScore = 0;
  let longPattern = "momentum_long";
  if (trend === "up") longScore += 25;
  if (rsiVal > 45 && rsiVal < 70) longScore += 15;
  if (last.close > ema9 && ema9 > ema21) longScore += 20;
  if (macdLine > 0 && histogram > 0) longScore += 15;
  if (vwapBounce) { longScore += 15; longPattern = "vwap_bounce"; }
  if (bullEngulf) { longScore += 20; longPattern = "bull_engulf"; }
  if (hammer) { longScore += 15; longPattern = "hammer"; }
  if (volSurge) longScore += 10;

  // Score SHORT
  let shortScore = 0;
  let shortPattern = "momentum_short";
  if (trend === "down") shortScore += 25;
  if (rsiVal < 55 && rsiVal > 30) shortScore += 15;
  if (last.close < ema9 && ema9 < ema21) shortScore += 20;
  if (macdLine < 0 && histogram < 0) shortScore += 15;
  if (vwapReject) { shortScore += 15; shortPattern = "vwap_reject"; }
  if (bearEngulf) { shortScore += 20; shortPattern = "bear_engulf"; }
  if (shootingStar) { shortScore += 15; shortPattern = "shooting_star"; }
  if (volSurge) shortScore += 10;

  // Need minimum confidence threshold to emit
  const MIN_CONFIDENCE = 62;
  const regimeStr = `${trend}${volatile ? "_volatile" : ""}`;

  if (longScore >= MIN_CONFIDENCE && longScore > shortScore) {
    return { side: "long", confidence: Math.min(98, longScore), pattern: longPattern, regime: regimeStr, atrVal };
  }
  if (shortScore >= MIN_CONFIDENCE && shortScore > longScore) {
    return { side: "short", confidence: Math.min(98, shortScore), pattern: shortPattern, regime: regimeStr, atrVal };
  }

  return { side: null, confidence: Math.max(longScore, shortScore), pattern: "no_signal", regime: regimeStr, atrVal };
}
