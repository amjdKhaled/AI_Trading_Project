// ──────────────────────────────────────────────────────────────────────────
// Live Opportunity Scorer
// Pure frontend computation — no LLM, no server call.
// Runs indicator checks on already-loaded bars + live price tick to produce
// a 0–100 opportunity score and direction for the currently-forming candle.
// ──────────────────────────────────────────────────────────────────────────

import type { OhlcvBar } from "@/pages/ChartPage";

export interface CachedMemoryContext {
  symbol:    string;
  winRate:   number | null;
  fetchedAt: number;
  /** Per-direction win rates (LONG / SHORT) computed from trade history.
   *  More precise than the overall symbol win rate for dampening. */
  directionWinRate?: {
    LONG:  number | null;
    SHORT: number | null;
  };
}

export interface OpportunityScore {
  score:      number;       // 0–100 (always returned, even below pre-signal threshold)
  direction:  "LONG" | "SHORT" | "NONE";
  confidence: number;       // mirrors score for API consistency
  setupLabel: string;
  factors:    string[];     // active confirmations shown in panel
  dampened:   boolean;      // true when memory lowered the score
}

// ── Internal indicator helpers ────────────────────────────────────────────

function emaArr(values: number[], period: number): number[] {
  const k   = 2 / (period + 1);
  const out = new Array<number>(values.length).fill(0);
  out[0] = values[0];
  for (let i = 1; i < values.length; i++) out[i] = values[i] * k + out[i - 1] * (1 - k);
  return out;
}

function rsiArr(closes: number[], period = 14): number[] {
  const out = new Array<number>(closes.length).fill(50);
  if (closes.length <= period) return out;
  let avgG = 0, avgL = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgG += d; else avgL -= d;
  }
  avgG /= period; avgL /= period;
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

function atrArr(bars: OhlcvBar[], period = 14): number[] {
  const out = new Array<number>(bars.length).fill(0);
  if (bars.length === 0) return out;
  out[0] = bars[0].high - bars[0].low;
  let sum = out[0];
  for (let i = 1; i < Math.min(period, bars.length); i++) {
    const tr = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i-1].close), Math.abs(bars[i].low - bars[i-1].close));
    out[i] = tr; sum += tr;
  }
  if (bars.length >= period) out[period - 1] = sum / period;
  for (let i = period; i < bars.length; i++) {
    const tr = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i-1].close), Math.abs(bars[i].low - bars[i-1].close));
    out[i] = (out[i - 1] * (period - 1) + tr) / period;
  }
  return out;
}

function efficiencyRatio(bars: OhlcvBar[], idx: number, n = 15): number {
  if (idx < n) return 0.5;
  const net = Math.abs(bars[idx].close - bars[idx - n].close);
  let path = 0;
  for (let j = idx - n + 1; j <= idx; j++) path += Math.abs(bars[j].close - bars[j - 1].close);
  return path > 0 ? Math.min(1, net / path) : 0.5;
}

// ── Public API ────────────────────────────────────────────────────────────

const NONE: OpportunityScore = {
  score: 0, direction: "NONE", confidence: 0,
  setupLabel: "No Setup", factors: [], dampened: false,
};

/**
 * Compute a 0–100 opportunity score for the currently-forming candle.
 * Runs entirely on the frontend using already-loaded historical bars.
 *
 * Always returns the real computed score — even below the 65-point
 * pre-signal threshold — so the badge can show green/amber/red bands.
 * The chart marker is gated in the caller (score >= 65 && direction !== NONE).
 *
 * @param bars         Full bar history already loaded on the chart page
 * @param lastPrice    Live tick price (replaces the forming candle's close)
 * @param cachedMemory Optional cached symbol win-rate for memory dampening
 */
export function computeOpportunityScore(
  bars:         OhlcvBar[],
  lastPrice:    number,
  cachedMemory?: CachedMemoryContext | null,
): OpportunityScore {
  if (bars.length < 55 || lastPrice <= 0) return NONE;

  // Build a working slice where the forming candle reflects the live price
  const slice  = bars.slice(-62);
  const last   = slice[slice.length - 1];
  const liveBar: OhlcvBar = {
    ...last,
    close:  lastPrice,
    high:   Math.max(last.high, lastPrice),
    low:    Math.min(last.low,  lastPrice),
    volume: last.volume,
  };
  const work   = [...slice.slice(0, -1), liveBar];
  const closes = work.map(b => b.close);
  const n      = work.length;
  const i      = n - 1;

  const e20  = emaArr(closes, 20)[i];
  const e50  = emaArr(closes, 50)[i];
  const rsiV = rsiArr(closes, 14)[i];
  const atrV = atrArr(work, 14)[i] || (work[i].high - work[i].low) || lastPrice * 0.005;
  const efr  = efficiencyRatio(work, i, 15);

  const avgVol   = work.slice(-20, -1).reduce((s, b) => s + b.volume, 0) / 19;
  const volRatio = avgVol > 0 ? work[i].volume / avgVol : 1;

  const strongUp   = lastPrice > e20 && e20 > e50;
  const strongDown = lastPrice < e20 && e20 < e50;

  // Require trend alignment; skip exhausted or purely choppy markets.
  // These return score 0 / direction NONE — badge shows red "0".
  if (!strongUp && !strongDown)  return NONE;
  if (rsiV > 80 && strongUp)    return NONE;
  if (rsiV < 20 && strongDown)  return NONE;
  if (efr < 0.15)               return NONE;

  const direction: "LONG" | "SHORT" = strongUp ? "LONG" : "SHORT";
  const factors: string[] = [];
  let score = 0;

  // 1. Trend strength: 0–30
  const trendScore = 20 + (direction === "LONG" ? (e20 > e50 ? 10 : 0) : (e20 < e50 ? 10 : 0));
  score += trendScore;
  if (trendScore >= 20) factors.push("EMA aligned");

  // 2. RSI momentum: 0–20
  const rsiFit  = direction === "LONG" ? (rsiV >= 45 && rsiV <= 72) : (rsiV >= 28 && rsiV <= 55);
  const rsiOver = direction === "LONG" ? rsiV > 72 : rsiV < 28;
  const rsiScore = rsiFit ? 20 : rsiOver ? 8 : 13;
  score += rsiScore;
  if (rsiFit) factors.push("RSI momentum");

  // 3. Volume expansion: 0–20
  const volScore = Math.min(20, Math.round(Math.min(volRatio, 2) * 10));
  score += volScore;
  if (volRatio > 1.3) factors.push("Volume surge");

  // 4. Pullback quality (proximity to EMA20): 0–20
  const pullbackDist = Math.abs(lastPrice - e20) / atrV;
  const nearEma20   = pullbackDist < 0.6;
  const pullScore   = nearEma20 ? 20 : pullbackDist < 1.2 ? 10 : 0;
  score += pullScore;
  if (nearEma20) factors.push("Near EMA20");

  // 5. Trend cleanliness (efficiency ratio): 0–10
  const erScore = Math.min(10, Math.round(efr * 12));
  score += erScore;
  if (efr > 0.40) factors.push("Clean trend");

  score = Math.min(100, Math.round(score));

  // Setup label (computed before dampening so it's always accurate)
  let setupLabel = "Developing";
  if (nearEma20) {
    setupLabel = direction === "LONG" ? "EMA20 Pullback" : "EMA20 Rejection";
  } else if (volRatio > 1.5 && efr > 0.40) {
    setupLabel = direction === "LONG" ? "Momentum Long" : "Momentum Short";
  } else if (efr > 0.45) {
    setupLabel = "Trend Continuation";
  }

  // ── Memory dampening (direction-aware) ──────────────────────────────────
  // Prefer direction-specific win rate; fall back to overall symbol win rate.
  // Max 20pt penalty when direction win-rate < 40% (repeated failures for
  // the current setup type tells us memory has learned this direction loses).
  let dampened = false;
  const dirWR = cachedMemory?.directionWinRate?.[direction] ?? null;
  const wr    = dirWR ?? cachedMemory?.winRate ?? null;

  if (wr !== null && wr < 0.40 && wr >= 0) {
    const penalty = Math.round(((0.40 - wr) / 0.40) * 20);
    if (penalty > 0) {
      score    = Math.max(0, score - penalty);
      dampened = true;
      const label = dirWR !== null ? `${direction} ` : "";
      factors.push(`Mem⚠ ${label}${Math.round(wr * 100)}% WR`);
    }
  }

  // NOTE: No threshold gate here — always return the real score.
  // The pre-signal chart marker is gated in ChartPage (score >= 65 && direction !== NONE).
  return { score, direction, confidence: score, setupLabel, factors, dampened };
}
