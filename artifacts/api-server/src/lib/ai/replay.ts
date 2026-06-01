import { buildMarketContext, findSimilarHistoricalSetups } from "./market-context.js";
import { runCandlePassForReplay } from "./filter.js";
import { getNewsSentiment } from "./news.js";
import { simulateLifecycle } from "../analyzer/lifecycle.js";
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

export interface ReplayDecisionDiff {
  candleTime:     number;
  direction:      "memory_added" | "memory_removed" | "conf_boost" | "conf_drop";
  noMemVerdict:   string;
  withMemVerdict: string;
  noMemConf:      number;
  withMemConf:    number;
  /** Top lesson from the with-memory pass that caused this divergence */
  keyLesson:      string | null;
}

export interface ReplayPassStats {
  approve:          number;
  wait:             number;
  reject:           number;
  total:            number;
  approveRate:      number;
  avgConf:          number;
  avgRR:            number;
  winRate:          number;
  profitFactor:     number;
  maxDrawdown:      number;
  simulated:        number;
  avgTradeGrade:    string;
  topLessons:       string[];
  topRejectLessons: string[];
}

export interface ReplayDelta {
  removedByMemory:  number;
  addedByMemory:    number;
  changedByMemory:  number;
  avgConfChange:    number;
  approveRateDelta: number;
}

export interface ReplayResult {
  symbol:        string;
  timeframe:     string;
  processed:     number;
  candles:       ReplayCandleResult[];
  noMem:         ReplayPassStats;
  withMem:       ReplayPassStats;
  delta:         ReplayDelta;
  learningScore: number;
  decisionDiffs: ReplayDecisionDiff[];
}

export type OnReplayProgress = (done: number, total: number) => void;

function classify(decision: CandleDecision, confidence: number): "approve" | "wait" | "reject" {
  if (decision === "WAIT") return "wait";
  if (confidence >= 80) return "approve";
  if (confidence >= 65) return "wait";
  return "reject";
}

interface TradeAcc {
  wins:     number;
  losses:   number;
  winRRs:   number;
  lossUnits: number;
  equity:   number[];
  running:  number;
}

function newAcc(): TradeAcc {
  return { wins: 0, losses: 0, winRRs: 0, lossUnits: 0, equity: [], running: 0 };
}

function recordOutcome(acc: TradeAcc, state: string, rr: number): void {
  if (state === "tp_hit") {
    acc.wins++;
    acc.winRRs  += rr;
    acc.running += rr;
  } else if (state === "sl_hit") {
    acc.losses++;
    acc.lossUnits += 1;
    acc.running   -= 1;
  } else {
    return; // expired / active — skip
  }
  acc.equity.push(acc.running);
}

function passStats(
  acc: TradeAcc,
): { winRate: number; profitFactor: number; maxDrawdown: number; simulated: number; avgTradeGrade: string } {
  const closed = acc.wins + acc.losses;
  const winRate = closed > 0 ? Math.round((acc.wins / closed) * 1000) / 1000 : 0;
  const profitFactor =
    acc.lossUnits > 0
      ? Math.min(Math.round((acc.winRRs / acc.lossUnits) * 100) / 100, 9.99)
      : acc.winRRs > 0 ? 9.99 : 0;

  let peak = 0;
  let maxDrawdown = 0;
  for (const eq of acc.equity) {
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  return {
    winRate,
    profitFactor,
    maxDrawdown:   Math.round(maxDrawdown * 100) / 100,
    simulated:     acc.wins + acc.losses,
    avgTradeGrade: tradeGrade(winRate, profitFactor),
  };
}

/**
 * 0–100 composite learning effectiveness score using the spec-defined weights:
 *   40 pts — Win Rate improvement %  (each +0.1% WR improvement = 4 pts; +10% = 40 pts max)
 *   30 pts — R:R improvement %       (each +10% relative RR gain = 3 pts; +100% = 30 pts max)
 *   20 pts — Loss avoidance count    (each memory-removed signal = 2 pts; 10 removals = 20 pts max)
 *   10 pts — Confidence improvement  (each +1 conf point = 1 pt; +10 = 10 pts max)
 */
function computeLearningScore(
  noMem:        Pick<ReplayPassStats, "winRate" | "avgConf" | "avgRR">,
  withMem:      Pick<ReplayPassStats, "winRate" | "avgConf" | "avgRR">,
  lossesAvoided: number,
): number {
  // WR improvement: +10pp WR improvement = 40 pts
  const wrDelta = withMem.winRate - noMem.winRate;
  const wrPts   = Math.max(0, Math.min(40, Math.round(wrDelta * 400)));

  // RR improvement %: +100% relative RR gain = 30 pts
  const rrDelta = withMem.avgRR - noMem.avgRR;
  const rrPct   = noMem.avgRR > 0 ? rrDelta / noMem.avgRR : (rrDelta > 0 ? 0.2 : 0);
  const rrPts   = Math.max(0, Math.min(30, Math.round(rrPct * 30)));

  // Losses avoided by memory: each removal = 2 pts, max 20
  const lossAvoidPts = Math.max(0, Math.min(20, lossesAvoided * 2));

  // Confidence improvement: each +1 conf point = 1 pt, max 10
  const confDelta = withMem.avgConf - noMem.avgConf;
  const confPts   = Math.max(0, Math.min(10, Math.round(confDelta)));

  return Math.max(0, Math.min(100, wrPts + rrPts + lossAvoidPts + confPts));
}

function tradeGrade(winRate: number, profitFactor: number): string {
  if (profitFactor >= 2.0 && winRate >= 0.55) return "A";
  if (profitFactor >= 1.5 && winRate >= 0.50) return "B";
  if (profitFactor >= 1.2 && winRate >= 0.40) return "C";
  if (profitFactor >= 1.0)                    return "D";
  return "F";
}

export async function runReplay(
  bars:       OhlcvBar[],
  htfBars:    OhlcvBar[],
  htfTf:      string,
  symbol:     string,
  timeframe:  string,
  limit:      number,
  onProgress: OnReplayProgress,
): Promise<ReplayResult> {
  const WARMUP   = 100;
  const endIdx   = bars.length - 1;
  const startIdx = Math.max(WARMUP, endIdx - limit);
  const total    = endIdx - startIdx;

  const news = await getNewsSentiment(symbol).catch(() => ({
    symbol, sentiment: "neutral" as const, score: 0,
    headlines: [] as string[], summary: "News unavailable",
    cachedAt: Date.now(), stale: true,
  }));

  const candles:          ReplayCandleResult[] = [];
  const noMemConfs:       number[]             = [];
  const withMemConfs:     number[]             = [];
  const noMemRRs:         number[]             = [];
  const withMemRRs:       number[]             = [];
  const noMemClass:       string[]             = [];
  const withMemClass:     string[]             = [];
  const lessonsBag:       string[]             = [];
  const rejectLessonsBag: string[]             = [];
  const decisionDiffs:    ReplayDecisionDiff[] = [];

  const noMemAcc   = newAcc();
  const withMemAcc = newAcc();

  let done = 0;

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

      const noMemCls = classify(noMem.decision,   noMem.confidence);
      const memCls   = classify(withMem.decision, withMem.confidence);
      noMemClass.push(noMemCls);
      withMemClass.push(memCls);
      lessonsBag.push(...withMem.lessons);
      if (memCls !== "approve" && withMem.memoryUsed) {
        rejectLessonsBag.push(...withMem.lessons);
      }

      // Collect decision diffs
      if (noMemCls !== memCls) {
        let direction: ReplayDecisionDiff["direction"];
        if (noMemCls !== "approve" && memCls === "approve")      direction = "memory_added";
        else if (noMemCls === "approve" && memCls !== "approve") direction = "memory_removed";
        else direction = withMem.confidence > noMem.confidence ? "conf_boost" : "conf_drop";

        decisionDiffs.push({
          candleTime,
          direction,
          noMemVerdict:   noMemCls,
          withMemVerdict: memCls,
          noMemConf:      noMem.confidence,
          withMemConf:    withMem.confidence,
          keyLesson:      (direction === "memory_added" || direction === "conf_boost")
                            ? (withMem.lessons[0] ?? null)
                            : null,
        });
      }

      // Lifecycle simulation — noMem approved signals
      const noMemSide = noMem.decision === "LONG" ? "long" : noMem.decision === "SHORT" ? "short" : null;
      if (
        noMemCls === "approve" && noMemSide &&
        noMem.entry != null && noMem.stopLoss != null && noMem.takeProfit != null
      ) {
        try {
          const lc = simulateLifecycle(
            bars, i, noMemSide as "long" | "short",
            noMem.entry, noMem.stopLoss, noMem.takeProfit,
          );
          recordOutcome(noMemAcc, lc.state, noMem.rr ?? 1.5);
        } catch { /* skip */ }
      }

      // Lifecycle simulation — withMem approved signals
      const withSide = withMem.decision === "LONG" ? "long" : withMem.decision === "SHORT" ? "short" : null;
      if (
        memCls === "approve" && withSide &&
        withMem.entry != null && withMem.stopLoss != null && withMem.takeProfit != null
      ) {
        try {
          const lc = simulateLifecycle(
            bars, i, withSide as "long" | "short",
            withMem.entry, withMem.stopLoss, withMem.takeProfit,
          );
          recordOutcome(withMemAcc, lc.state, withMem.rr ?? 1.5);
        } catch { /* skip */ }
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

  const noMemSim   = passStats(noMemAcc);
  const withMemSim = passStats(withMemAcc);

  const noMemStats: ReplayPassStats = {
    approve:          noMemApprove,
    wait:             count(noMemClass, "wait"),
    reject:           count(noMemClass, "reject"),
    total:            noMemTotal,
    approveRate:      noMemTotal > 0 ? Math.round((noMemApprove / noMemTotal) * 1000) / 1000 : 0,
    avgConf:          Math.round(noMemAvgConf * 10) / 10,
    avgRR:            avg(noMemRRs),
    winRate:          noMemSim.winRate,
    profitFactor:     noMemSim.profitFactor,
    maxDrawdown:      noMemSim.maxDrawdown,
    simulated:        noMemSim.simulated,
    avgTradeGrade:    noMemSim.avgTradeGrade,
    topLessons:       [],
    topRejectLessons: [],
  };

  const withMemStats: ReplayPassStats = {
    approve:          withMemApprove,
    wait:             count(withMemClass, "wait"),
    reject:           count(withMemClass, "reject"),
    total:            withMemTotal,
    approveRate:      withMemTotal > 0 ? Math.round((withMemApprove / withMemTotal) * 1000) / 1000 : 0,
    avgConf:          Math.round(withMemAvgConf * 10) / 10,
    avgRR:            avg(withMemRRs),
    winRate:          withMemSim.winRate,
    profitFactor:     withMemSim.profitFactor,
    maxDrawdown:      withMemSim.maxDrawdown,
    simulated:        withMemSim.simulated,
    avgTradeGrade:    withMemSim.avgTradeGrade,
    topLessons:       topN(lessonsBag),
    topRejectLessons: topN(rejectLessonsBag),
  };

  const removedByMem = decisionDiffs.filter(d => d.direction === "memory_removed").length;
  const addedByMem   = decisionDiffs.filter(d => d.direction === "memory_added").length;
  const changedByMem = decisionDiffs.filter(d => d.direction === "conf_boost" || d.direction === "conf_drop").length;

  const learningScore = computeLearningScore(noMemStats, withMemStats, removedByMem);

  return {
    symbol, timeframe,
    processed: candles.length,
    candles,
    noMem:    noMemStats,
    withMem:  withMemStats,
    delta: {
      removedByMemory:  removedByMem,
      addedByMemory:    addedByMem,
      changedByMemory:  changedByMem,
      avgConfChange: Math.round((withMemAvgConf - noMemAvgConf) * 10) / 10,
      approveRateDelta: Math.round(
        ((withMemTotal > 0 ? withMemApprove / withMemTotal : 0) -
         (noMemTotal   > 0 ? noMemApprove   / noMemTotal   : 0)) * 1000,
      ) / 1000,
    },
    learningScore,
    decisionDiffs,
  };
}
