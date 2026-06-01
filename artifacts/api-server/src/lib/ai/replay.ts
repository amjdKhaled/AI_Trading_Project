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
  approve:         number;
  wait:            number;
  reject:          number;
  total:           number;
  approveRate:     number;   // 0–1, i.e. approve / total
  avgConf:         number;
  avgRR:           number;
  topLessons:      string[];
  topRejectLessons: string[]; // lessons most frequently cited when memory still said REJECT/WAIT
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
  // Replay the last `limit` *closed* candles with sufficient warmup context.
  // bars[bars.length - 1] may be a live/partial candle — exclude it.
  const WARMUP   = 100;
  const endIdx   = bars.length - 1;                       // last closed bar
  const startIdx = Math.max(WARMUP, endIdx - limit);      // at least 100 bars of warmup
  const total    = endIdx - startIdx;

  // Fetch news once and reuse — avoids per-candle API calls
  const news = await getNewsSentiment(symbol).catch(() => ({
    symbol, sentiment: "neutral" as const, score: 0,
    headlines: [] as string[], summary: "News unavailable",
    cachedAt: Date.now(), stale: true,
  }));

  const candles:           ReplayCandleResult[] = [];
  const noMemConfs:        number[]             = [];
  const withMemConfs:      number[]             = [];
  const noMemRRs:          number[]             = [];
  const withMemRRs:        number[]             = [];
  const noMemClass:        string[]             = [];
  const withMemClass:      string[]             = [];
  const lessonsBag:        string[]             = [];
  const rejectLessonsBag:  string[]             = []; // lessons cited when memory still REJECT/WAIT
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
      const noMemCls  = classify(noMem.decision,   noMem.confidence);
      const memCls    = classify(withMem.decision,  withMem.confidence);
      noMemClass.push(noMemCls);
      withMemClass.push(memCls);
      lessonsBag.push(...withMem.lessons);
      // Track lessons cited when memory-enhanced decision was still REJECT or WAIT
      if (memCls !== "approve" && withMem.memoryUsed) {
        rejectLessonsBag.push(...withMem.lessons);
      }
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

  const topN = (bag: string[], n = 5) => {
    const counts: Record<string, number> = {};
    for (const l of bag) counts[l] = (counts[l] ?? 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n).map(([l]) => l);
  };

  const noMemAvgConf   = avg(noMemConfs);
  const withMemAvgConf = avg(withMemConfs);

  const noMemApprove   = count(noMemClass,   "approve");
  const withMemApprove = count(withMemClass, "approve");
  const noMemTotal     = noMemClass.length;
  const withMemTotal   = withMemClass.length;

  return {
    symbol, timeframe,
    processed: candles.length,
    candles,
    noMem: {
      approve:         noMemApprove,
      wait:            count(noMemClass, "wait"),
      reject:          count(noMemClass, "reject"),
      total:           noMemTotal,
      approveRate:     noMemTotal > 0 ? Math.round((noMemApprove / noMemTotal) * 1000) / 1000 : 0,
      avgConf:         Math.round(noMemAvgConf * 10) / 10,
      avgRR:           avg(noMemRRs),
      topLessons:      [],
      topRejectLessons: [],
    },
    withMem: {
      approve:         withMemApprove,
      wait:            count(withMemClass, "wait"),
      reject:          count(withMemClass, "reject"),
      total:           withMemTotal,
      approveRate:     withMemTotal > 0 ? Math.round((withMemApprove / withMemTotal) * 1000) / 1000 : 0,
      avgConf:         Math.round(withMemAvgConf * 10) / 10,
      avgRR:           avg(withMemRRs),
      topLessons:      topN(lessonsBag),
      topRejectLessons: topN(rejectLessonsBag),
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
