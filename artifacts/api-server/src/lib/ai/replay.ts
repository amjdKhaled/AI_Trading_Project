import { buildMarketContext, findSimilarHistoricalSetups } from "./market-context.js";
import { runCandlePassForReplay } from "./filter.js";
import { getNewsSentiment } from "./news.js";
import { logger } from "../logger.js";
import type { OhlcvBar } from "../analyzer/types.js";

export type CandleDecision = "LONG" | "SHORT" | "WAIT";

export interface ReplayPassResult {
  decision:   CandleDecision;
  confidence: number;
  entry:      number | null;
  stopLoss:   number | null;
  takeProfit: number | null;
  rr:         number | null;
  lessons:    string[];
  memoryUsed: boolean;
}

export interface ReplayCandleResult {
  candleTime: number;
  noMem:   Omit<ReplayPassResult, "lessons" | "memoryUsed">;
  withMem: ReplayPassResult;
}

export interface ReplayPassStats {
  approve:    number;
  wait:       number;
  reject:     number;
  avgConf:    number;
  avgRR:      number;
  topLessons: string[];
}

export interface ReplayResult {
  symbol:    string;
  timeframe: string;
  processed: number;
  candles:   ReplayCandleResult[];
  noMem:     ReplayPassStats;
  withMem:   ReplayPassStats;
  delta: {
    removedByMemory: number;
    addedByMemory:   number;
    avgConfChange:   number;
  };
}

export type OnReplayProgress = (done: number, total: number) => void;

function classify(decision: CandleDecision, confidence: number): "approve" | "wait" | "reject" {
  if (decision === "WAIT") return "wait";
  if (confidence >= 80) return "approve";
  if (confidence >= 65) return "wait";
  return "reject";
}

export async function runReplay(
  bars:        OhlcvBar[],
  htfBars:     OhlcvBar[],
  htfTf:       string,
  symbol:      string,
  timeframe:   string,
  limit:       number,
  onProgress:  OnReplayProgress,
): Promise<ReplayResult> {
  const startIdx = Math.min(100, bars.length - 2);
  const endIdx   = Math.min(startIdx + limit, bars.length - 1);
  const total    = endIdx - startIdx;

  // Fetch news once and reuse — avoids per-candle API calls
  const news = await getNewsSentiment(symbol).catch(() => ({
    symbol, sentiment: "neutral" as const, score: 0,
    headlines: [] as string[], summary: "News unavailable",
    cachedAt: Date.now(), stale: true,
  }));

  const candles:      ReplayCandleResult[] = [];
  const noMemConfs:   number[]             = [];
  const withMemConfs: number[]             = [];
  const noMemRRs:     number[]             = [];
  const withMemRRs:   number[]             = [];
  const noMemClass:   string[]             = [];
  const withMemClass: string[]             = [];
  const lessonsBag:   string[]             = [];
  let   done = 0;

  for (let i = startIdx; i < endIdx; i++) {
    const candleTime = bars[i].time;
    const slice      = bars.slice(0, i + 1);

    try {
      const ctx = buildMarketContext(slice, htfBars, htfTf, symbol, timeframe, candleTime, news);

      const stats = await findSimilarHistoricalSetups(
        symbol, ctx.regime, ctx.indicators.rsi14, ctx.candlestickPatterns,
      ).catch(() => ({
        samples: 0, winRate: 0, avgRR: 0, avgProfit: 0, avgLoss: 1,
        regimeApproveRate: 0, summary: "No historical data.",
      }));

      // Sequential to avoid GPU saturation
      const noMem   = await runCandlePassForReplay(ctx, stats, false);
      const withMem = await runCandlePassForReplay(ctx, stats, true);

      candles.push({
        candleTime,
        noMem: {
          decision: noMem.decision, confidence: noMem.confidence,
          entry: noMem.entry, stopLoss: noMem.stopLoss,
          takeProfit: noMem.takeProfit, rr: noMem.rr,
        },
        withMem,
      });

      noMemConfs.push(noMem.confidence);
      withMemConfs.push(withMem.confidence);
      if (noMem.rr   !== null && noMem.rr   > 0) noMemRRs.push(noMem.rr);
      if (withMem.rr !== null && withMem.rr > 0) withMemRRs.push(withMem.rr);
      noMemClass.push(classify(noMem.decision, noMem.confidence));
      withMemClass.push(classify(withMem.decision, withMem.confidence));
      lessonsBag.push(...withMem.lessons);
    } catch (err) {
      logger.warn({ err, symbol, candleTime }, "replay candle failed — skipping");
    }

    done++;
    onProgress(done, total);
  }

  const avg = (arr: number[]) =>
    arr.length > 0
      ? Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 100) / 100
      : 0;

  const count = (arr: string[], cls: string) => arr.filter(v => v === cls).length;

  // Top lessons by frequency
  const lessonCounts: Record<string, number> = {};
  for (const l of lessonsBag) lessonCounts[l] = (lessonCounts[l] ?? 0) + 1;
  const topLessons = Object.entries(lessonCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([l]) => l);

  const noMemAvgConf   = avg(noMemConfs);
  const withMemAvgConf = avg(withMemConfs);

  return {
    symbol, timeframe,
    processed: candles.length,
    candles,
    noMem: {
      approve:    count(noMemClass,   "approve"),
      wait:       count(noMemClass,   "wait"),
      reject:     count(noMemClass,   "reject"),
      avgConf:    Math.round(noMemAvgConf * 10) / 10,
      avgRR:      avg(noMemRRs),
      topLessons: [],
    },
    withMem: {
      approve:    count(withMemClass, "approve"),
      wait:       count(withMemClass, "wait"),
      reject:     count(withMemClass, "reject"),
      avgConf:    Math.round(withMemAvgConf * 10) / 10,
      avgRR:      avg(withMemRRs),
      topLessons,
    },
    delta: {
      removedByMemory: candles.filter(c =>
        classify(c.noMem.decision,   c.noMem.confidence)   === "approve" &&
        classify(c.withMem.decision, c.withMem.confidence) !== "approve",
      ).length,
      addedByMemory: candles.filter(c =>
        classify(c.noMem.decision,   c.noMem.confidence)   !== "approve" &&
        classify(c.withMem.decision, c.withMem.confidence) === "approve",
      ).length,
      avgConfChange: Math.round((withMemAvgConf - noMemAvgConf) * 10) / 10,
    },
  };
}
