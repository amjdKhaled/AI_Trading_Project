import type { OhlcvBar } from "./types.js";

export interface TradeHealthBreakdown {
  emaTrend:         number;
  momentum:         number;
  volume:           number;
  priceProgress:    number;
  patternIntegrity: number;
  memoryAlignment:  number;
}

export interface TradeHealth {
  score:     number;
  breakdown: TradeHealthBreakdown;
  direction: "improving" | "deteriorating" | "neutral";
  summary:   string;
}

export interface TradeDecisionContext {
  side:               "long" | "short";
  entryPrice:         number;
  slPrice:            number;
  tpPrice:            number;
  confidence:         number;
  regime:             string;
  patterns:           string[];
  memoryImpactScore?: number;
}

function emaLast(bars: OhlcvBar[], period: number): number {
  if (bars.length === 0) return 0;
  const k = 2 / (period + 1);
  let val = bars[0].close;
  for (let i = 1; i < bars.length; i++) {
    val = bars[i].close * k + val * (1 - k);
  }
  return val;
}

function rsi14(bars: OhlcvBar[]): number {
  const period = 14;
  if (bars.length < period + 1) return 50;
  const closes = bars.map((b) => b.close);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0,  d)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export function computeTradeHealth(
  bars: OhlcvBar[],
  decision: TradeDecisionContext,
): TradeHealth {
  if (bars.length < 20) {
    return {
      score: 50,
      breakdown: { emaTrend: 12, momentum: 10, volume: 7, priceProgress: 12, patternIntegrity: 5, memoryAlignment: 4 },
      direction: "neutral",
      summary: "Insufficient bars for full analysis.",
    };
  }

  const { side, entryPrice, slPrice, tpPrice, memoryImpactScore } = decision;
  const isLong       = side === "long";
  const lastBar      = bars[bars.length - 1];
  const currentPrice = lastBar.close;

  // ── 1. EMA Trend Alignment (0–25) ────────────────────────────────────────
  const ema20 = emaLast(bars.slice(-Math.min(bars.length, 60)), 20);
  const ema50 = emaLast(bars.slice(-Math.min(bars.length, 100)), 50);
  let emaTrend = 0;
  if (isLong) {
    if (currentPrice > ema20) emaTrend += 9;
    if (currentPrice > ema50) emaTrend += 9;
    if (ema20 > ema50)        emaTrend += 7;
  } else {
    if (currentPrice < ema20) emaTrend += 9;
    if (currentPrice < ema50) emaTrend += 9;
    if (ema20 < ema50)        emaTrend += 7;
  }

  // ── 2. RSI Momentum (0–20) ────────────────────────────────────────────────
  const rsiVal = rsi14(bars.slice(-Math.min(bars.length, 30)));
  let momentum = 0;
  if (isLong) {
    if      (rsiVal >= 45 && rsiVal <= 65) momentum = 20;
    else if (rsiVal >= 35 && rsiVal <  45) momentum = 14;
    else if (rsiVal >  65 && rsiVal <= 75) momentum = 14;
    else if (rsiVal >= 25 && rsiVal <  35) momentum = 7;
    else if (rsiVal >  75 && rsiVal <= 82) momentum = 7;
  } else {
    if      (rsiVal >= 35 && rsiVal <= 55) momentum = 20;
    else if (rsiVal >= 25 && rsiVal <  35) momentum = 14;
    else if (rsiVal >  55 && rsiVal <= 65) momentum = 14;
    else if (rsiVal >= 18 && rsiVal <  25) momentum = 7;
    else if (rsiVal >  65 && rsiVal <= 75) momentum = 7;
  }

  // ── 3. Volume Confirmation (0–15) ─────────────────────────────────────────
  const volSlice = bars.slice(-21, -1);
  const avgVol   = volSlice.length > 0
    ? volSlice.reduce((s, b) => s + b.volume, 0) / volSlice.length
    : 1;
  const relVol = avgVol > 0 ? lastBar.volume / avgVol : 1;
  const volume = Math.min(15, Math.round(relVol * 8));

  // ── 4. Price Progress toward TP (0–25) ────────────────────────────────────
  const totalRange = Math.abs(tpPrice - slPrice);
  let progress = 0.5;
  if (totalRange > 0) {
    progress = isLong
      ? (currentPrice - slPrice) / totalRange
      : (slPrice - currentPrice) / totalRange;
  }
  const priceProgress = Math.max(0, Math.min(25, Math.round(progress * 25)));

  // ── 5. Pattern / Setup Integrity (0–10) ───────────────────────────────────
  let patternIntegrity = 5;
  if (isLong) {
    if      (currentPrice > entryPrice)           patternIntegrity = 10;
    else if (currentPrice < slPrice * 1.002)      patternIntegrity = 0;
  } else {
    if      (currentPrice < entryPrice)           patternIntegrity = 10;
    else if (currentPrice > slPrice * 0.998)      patternIntegrity = 0;
  }

  // ── 6. Memory Alignment (0–5) ─────────────────────────────────────────────
  let memoryAlignment = 3;
  if (memoryImpactScore != null && isFinite(memoryImpactScore)) {
    memoryAlignment = Math.min(5, Math.max(0, Math.round((memoryImpactScore / 100) * 5)));
  }

  const breakdown: TradeHealthBreakdown = {
    emaTrend, momentum, volume, priceProgress, patternIntegrity, memoryAlignment,
  };
  const score = emaTrend + momentum + volume + priceProgress + patternIntegrity + memoryAlignment;

  // ── Direction ─────────────────────────────────────────────────────────────
  const lookback = Math.min(5, bars.length - 1);
  const prevBar  = bars[bars.length - 1 - lookback];
  const priceDiff = currentPrice - prevBar.close;
  const threshold = Math.abs(tpPrice - entryPrice) * 0.08;
  let direction: "improving" | "deteriorating" | "neutral" = "neutral";
  if (isLong) {
    if      (priceDiff >  threshold) direction = "improving";
    else if (priceDiff < -threshold) direction = "deteriorating";
  } else {
    if      (priceDiff < -threshold) direction = "improving";
    else if (priceDiff >  threshold) direction = "deteriorating";
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const parts: string[] = [];
  if (emaTrend >= 18)                               parts.push("EMAs aligned");
  else if (emaTrend <= 8)                           parts.push("EMA misaligned");
  if (isLong  && rsiVal >= 45 && rsiVal <= 65)      parts.push("RSI bullish zone");
  if (!isLong && rsiVal >= 35 && rsiVal <= 55)      parts.push("RSI bearish zone");
  if ((isLong && rsiVal > 75) || (!isLong && rsiVal < 25)) parts.push("RSI extreme");
  if (progress > 0.5) parts.push(`${Math.round(progress * 100)}% toward TP`);
  else if (progress < 0.15) parts.push("near entry/SL zone");
  if (relVol > 1.5)                                 parts.push("strong volume");
  const summary = parts.length > 0
    ? parts.join(". ") + "."
    : `Score ${score}/100 — trade ${direction}.`;

  return { score, breakdown, direction, summary };
}
