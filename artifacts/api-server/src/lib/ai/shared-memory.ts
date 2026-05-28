// ============================================================
// Shared Memory — DB-backed institutional memory layer
// Reads/writes ai_lessons, ai_patterns, ai_market_regimes tables.
// Preserves the same surface as memory.ts so callers need minimal changes.
// The JSON file is kept as a read-only fallback for the import/bootstrap flow.
// ============================================================

import { db, aiLessonsTable, aiPatternsTable } from "@workspace/db";
import { eq, desc, and, or } from "drizzle-orm";
import { logger } from "../logger.js";
import type { TradeMemoryEntry, MemoryStore } from "./types.js";

// ── JSON fallback (read-only) ─────────────────────────────────
import fs from "fs";
import path from "path";

const MEMORY_PATH = path.resolve(process.cwd(), "../../memory/trades.json");

function readJsonFallback(): MemoryStore {
  const EMPTY: MemoryStore = {
    version: 1,
    updatedAt: "",
    totalTrades: 0,
    trades: [],
    regimeStats: {},
    strategyStats: {},
    symbolStats: {},
    recentLessons: [],
  };
  try {
    const text = fs.readFileSync(MEMORY_PATH, "utf-8");
    return JSON.parse(text) as MemoryStore;
  } catch {
    return structuredClone(EMPTY);
  }
}

// ── DB helpers ────────────────────────────────────────────────

function inferFailureCategory(trade: TradeMemoryEntry): typeof import("@workspace/db").aiLessonsTable.$inferInsert.failureCategory {
  const outcome = trade.outcome;
  if (outcome === "tp_hit") return "unknown";
  if (trade.trapType === "fake_breakout" || trade.trapType === "false_breakout") return "false_breakout";
  if (trade.trapType === "liquidity_sweep") return "weak_volume";
  if (trade.trapType === "counter_trend") return "trend_reversal";
  const lesson = (trade.lesson ?? "").toLowerCase();
  if (lesson.includes("news")) return "news_issue";
  if (lesson.includes("entry")) return "bad_entry";
  if (lesson.includes("risk")) return "poor_risk";
  if (lesson.includes("volume")) return "weak_volume";
  if (lesson.includes("pattern")) return "pattern_failure";
  if (lesson.includes("regime")) return "regime_mismatch";
  if (lesson.includes("confidence")) return "incorrect_confidence";
  return "unknown";
}

// ── Public API — write ────────────────────────────────────────

export async function appendTradeToDb(entry: TradeMemoryEntry): Promise<void> {
  try {
    await db.insert(aiLessonsTable).values({
      signalId:                entry.id,
      symbol:                  entry.symbol,
      side:                    entry.side,
      strategy:                entry.strategy,
      regime:                  entry.regime,
      session:                 entry.session,
      htfBias:                 entry.htfBias,
      outcome:                 entry.outcome,
      lesson:                  entry.lesson ?? `${entry.strategy} ${entry.side} in ${entry.regime}: ${entry.outcome}`,
      weaknesses:              entry.weaknesses ?? [],
      failureCategory:         entry.failureCategory ?? inferFailureCategory(entry),
      trapType:                entry.trapType ?? null,
      continuationProbability: entry.continuationProbability ?? 0.5,
      reasoning:               "",
      confidence:              entry.confidence,
      grade:                   entry.grade,
      rrRatio:                 entry.rrRatio,
      entryPrice:              entry.entryPrice,
      exitPrice:               entry.exitPrice ?? null,
    });

    await db.insert(aiPatternsTable).values({
      signalId:       entry.id,
      symbol:         entry.symbol,
      regime:         entry.regime,
      side:           entry.side,
      strategy:       entry.strategy,
      patternTags:    entry.patterns,
      session:        entry.session,
      htfBias:        entry.htfBias,
      outcome:        entry.outcome,
      confidence:     entry.confidence,
      rrRatio:        entry.rrRatio,
      entryPrice:     entry.entryPrice,
      exitPrice:      entry.exitPrice ?? null,
      atrPct:         entry.atrPct ?? null,
      volumeState:    entry.volumeState,
      structureState: entry.structureState,
    });

    logger.info({ signalId: entry.id, outcome: entry.outcome }, "Shared memory updated (DB)");
  } catch (err) {
    logger.warn({ err, signalId: entry.id }, "DB memory write failed");
  }
}

// ── Public API — read ─────────────────────────────────────────

export async function getRelevantContextFromDb(
  symbol: string,
  regime: string,
  strategy: string,
  side: "long" | "short",
  limit = 8,
): Promise<TradeMemoryEntry[]> {
  try {
    const rows = await db
      .select()
      .from(aiLessonsTable)
      .where(
        and(
          or(eq(aiLessonsTable.symbol, symbol), eq(aiLessonsTable.regime, regime)),
          eq(aiLessonsTable.side, side),
        ),
      )
      .orderBy(desc(aiLessonsTable.createdAt))
      .limit(limit);

    return rows.map(r => dbLessonToMemoryEntry(r));
  } catch (err) {
    logger.warn({ err }, "DB getRelevantContext failed — falling back to JSON");
    const store = readJsonFallback();
    return store.trades
      .filter(t => (t.symbol === symbol || t.regime === regime) && t.side === side)
      .slice(0, limit);
  }
}

export async function getStrategyWinRateFromDb(strategy: string): Promise<number | null> {
  try {
    const rows = await db
      .select()
      .from(aiLessonsTable)
      .where(eq(aiLessonsTable.strategy, strategy));
    if (rows.length < 3) return null;
    const wins = rows.filter(r => r.outcome === "tp_hit").length;
    return wins / rows.length;
  } catch {
    return null;
  }
}

export async function getRegimeWinRateFromDb(regime: string): Promise<number | null> {
  try {
    const rows = await db
      .select()
      .from(aiLessonsTable)
      .where(eq(aiLessonsTable.regime, regime));
    if (rows.length < 3) return null;
    const wins = rows.filter(r => r.outcome === "tp_hit").length;
    return wins / rows.length;
  } catch {
    return null;
  }
}

export interface PatternGroupStat {
  symbol: string;
  regime: string;
  side: string;
  strategy: string;
  winRate: number;
  sampleSize: number;
  avgRR: number;
}

export async function getMemorySummaryFromDb(): Promise<{
  totalTrades: number;
  lessonsCount: number;
  patternsCount: number;
  similarityMatchesCount: number;
  topSimilarityMatches: PatternGroupStat[];
  regimeStats: Record<string, { wins: number; losses: number; total: number }>;
  strategyStats: Record<string, { wins: number; losses: number; total: number }>;
  symbolStats: Record<string, { wins: number; losses: number; total: number }>;
  recentLessons: string[];
  updatedAt: string;
}> {
  try {
    const [lessons, patterns] = await Promise.all([
      db.select().from(aiLessonsTable).orderBy(desc(aiLessonsTable.createdAt)).limit(2000),
      db.select().from(aiPatternsTable).limit(2000),
    ]);

    const regimeStats: Record<string, { wins: number; losses: number; total: number }> = {};
    const strategyStats: Record<string, { wins: number; losses: number; total: number }> = {};
    const symbolStats: Record<string, { wins: number; losses: number; total: number }> = {};

    for (const r of lessons) {
      const won = r.outcome === "tp_hit";
      for (const [map, key] of [
        [regimeStats, r.regime],
        [strategyStats, r.strategy],
        [symbolStats, r.symbol],
      ] as [Record<string, { wins: number; losses: number; total: number }>, string][]) {
        if (!map[key]) map[key] = { wins: 0, losses: 0, total: 0 };
        map[key].total++;
        if (won) map[key].wins++; else map[key].losses++;
      }
    }

    // ── Similarity match stats ─────────────────────────────────
    // Group patterns by symbol|regime|side|strategy and compute
    // win rate, avgRR per group — surfaces the top setups by win rate.
    const groupMap = new Map<string, { wins: number; total: number; rrs: number[]; rep: typeof patterns[0] }>();
    for (const p of patterns) {
      const key = `${p.symbol}|${p.regime}|${p.side}|${p.strategy}`;
      if (!groupMap.has(key)) groupMap.set(key, { wins: 0, total: 0, rrs: [], rep: p });
      const g = groupMap.get(key)!;
      g.total++;
      if (p.outcome === "tp_hit") g.wins++;
      if (p.rrRatio > 0) g.rrs.push(p.rrRatio);
    }

    const topSimilarityMatches: PatternGroupStat[] = Array.from(groupMap.values())
      .filter(g => g.total >= 3)
      .map(g => ({
        symbol:     g.rep.symbol,
        regime:     g.rep.regime,
        side:       g.rep.side,
        strategy:   g.rep.strategy,
        winRate:    Math.round((g.wins / g.total) * 1000) / 1000,
        sampleSize: g.total,
        avgRR:      g.rrs.length > 0
          ? Math.round(g.rrs.reduce((s, r) => s + r, 0) / g.rrs.length * 100) / 100
          : 0,
      }))
      .sort((a, b) => b.winRate - a.winRate)
      .slice(0, 10);

    const recentLessons = lessons.slice(0, 10).map(r => r.lesson);
    const updatedAt = lessons[0]?.createdAt?.toISOString() ?? "";

    return {
      totalTrades: lessons.length,
      lessonsCount: lessons.length,
      patternsCount: patterns.length,
      similarityMatchesCount: groupMap.size,
      topSimilarityMatches,
      regimeStats,
      strategyStats,
      symbolStats,
      recentLessons,
      updatedAt,
    };
  } catch (err) {
    logger.warn({ err }, "DB getMemorySummary failed — falling back to JSON");
    const store = readJsonFallback();
    return {
      totalTrades: store.totalTrades,
      lessonsCount: store.trades.length,
      patternsCount: 0,
      similarityMatchesCount: 0,
      topSimilarityMatches: [],
      regimeStats: store.regimeStats,
      strategyStats: store.strategyStats,
      symbolStats: store.symbolStats,
      recentLessons: store.recentLessons,
      updatedAt: store.updatedAt,
    };
  }
}

// ── Symbol stats helper used by decide.ts ─────────────────────

export async function getSymbolStatsFromDb(
  symbol: string,
): Promise<{ wins: number; losses: number; total: number } | undefined> {
  try {
    const rows = await db
      .select()
      .from(aiLessonsTable)
      .where(eq(aiLessonsTable.symbol, symbol));
    if (rows.length === 0) return undefined;
    const wins = rows.filter(r => r.outcome === "tp_hit").length;
    const losses = rows.length - wins;
    return { wins, losses, total: rows.length };
  } catch {
    return undefined;
  }
}

// ── Recent lessons strings (for decide.ts prompt) ─────────────

export async function getRecentLessonsFromDb(limit = 5): Promise<string[]> {
  try {
    const rows = await db
      .select({ lesson: aiLessonsTable.lesson })
      .from(aiLessonsTable)
      .orderBy(desc(aiLessonsTable.createdAt))
      .limit(limit);
    return rows.map(r => r.lesson);
  } catch {
    return readJsonFallback().recentLessons.slice(0, limit);
  }
}

// ── Converter ─────────────────────────────────────────────────

function dbLessonToMemoryEntry(r: typeof aiLessonsTable.$inferSelect): TradeMemoryEntry {
  return {
    id:                      r.signalId,
    timestamp:               r.createdAt.toISOString(),
    symbol:                  r.symbol,
    timeframe:               "5m",
    side:                    r.side as "long" | "short",
    strategy:                r.strategy,
    regime:                  r.regime,
    session:                 r.session,
    htfBias:                 r.htfBias,
    confluenceCount:         0,
    confidence:              r.confidence,
    grade:                   r.grade,
    riskLevel:               "Medium",
    rrRatio:                 r.rrRatio,
    entryPrice:              r.entryPrice,
    slPrice:                 0,
    tpPrice:                 0,
    exitPrice:               r.exitPrice ?? null,
    outcome:                 r.outcome as "tp_hit" | "sl_hit" | "expired",
    volumeState:             "neutral",
    structureState:          "mixed",
    patterns:                [],
    lesson:                  r.lesson,
    weaknesses:              (r.weaknesses as string[]) ?? [],
    trapType:                r.trapType ?? null,
    continuationProbability: r.continuationProbability,
  };
}
