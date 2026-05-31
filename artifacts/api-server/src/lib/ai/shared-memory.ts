// ============================================================
// Shared Memory — DB-backed institutional memory layer
// Reads/writes ai_lessons, ai_patterns, ai_market_regimes tables.
// Preserves the same surface as memory.ts so callers need minimal changes.
// The JSON file is kept as a read-only fallback for the import/bootstrap flow.
// ============================================================

import { db, aiLessonsTable, aiPatternsTable } from "@workspace/db";
import { eq, ne, desc, and, or, count } from "drizzle-orm";
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

// ── Frequency counting helper ─────────────────────────────────

function freqTop(arr: (string | null | undefined)[], topN = 2): Array<[string, number]> {
  const map = new Map<string, number>();
  for (const v of arr) {
    const key = v ?? "unknown";
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN);
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
  if (lesson.includes("structure")) return "trend_structure_break";
  if (lesson.includes("support") || lesson.includes("resistance")) return "support_resistance_failure";
  if (lesson.includes("stop")) return "stop_placement";
  if (lesson.includes("tp") || lesson.includes("take profit")) return "takeprofit_placement";
  if (lesson.includes("timing") || lesson.includes("entry tim")) return "entry_timing";
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
    // Guard: skip if a lesson for this signal already exists (prevents duplicates on re-run)
    const existing = await db
      .select({ id: aiLessonsTable.id })
      .from(aiLessonsTable)
      .where(eq(aiLessonsTable.signalId, entry.id))
      .limit(1);
    if (existing.length > 0) {
      logger.info({ signalId: entry.id }, "Skipped duplicate — lesson already stored");
      return;
    }

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
      reasoning:               entry.reasoning ?? "",
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
    // ── Accurate total counts via COUNT(*) ────────────────────────
    const [[{ totalLessons }], [{ totalPatterns }], lessons, patterns] = await Promise.all([
      db.select({ totalLessons: count() }).from(aiLessonsTable),
      db.select({ totalPatterns: count() }).from(aiPatternsTable),
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
      totalTrades:            totalLessons,
      lessonsCount:           totalLessons,
      patternsCount:          totalPatterns,
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

// ── Lesson context (for decide.ts prompt injection) ───────────

export interface LessonWithContext {
  lesson: string;
  outcome: string;
  reasoning?: string;
}

/**
 * Fetch recent lessons, optionally filtered by symbol and/or regime.
 * Returns structured objects so decide.ts can include Qwen3's reasoning
 * alongside the lesson text in the decision prompt.
 */
export async function getRecentLessonsFromDb(
  symbol?: string,
  regime?: string,
  limit = 6,
): Promise<LessonWithContext[]> {
  try {
    // Build WHERE clause: AND when both provided, single condition otherwise
    const whereClause =
      symbol && regime ? and(eq(aiLessonsTable.symbol, symbol), eq(aiLessonsTable.regime, regime)) :
      symbol           ? eq(aiLessonsTable.symbol, symbol) :
      regime           ? eq(aiLessonsTable.regime, regime) :
      undefined;

    const baseSelect = db
      .select({ lesson: aiLessonsTable.lesson, outcome: aiLessonsTable.outcome, reasoning: aiLessonsTable.reasoning })
      .from(aiLessonsTable);

    const rows = whereClause
      ? await baseSelect.where(whereClause).orderBy(desc(aiLessonsTable.createdAt)).limit(limit)
      : await baseSelect.orderBy(desc(aiLessonsTable.createdAt)).limit(limit);

    return rows.map(r => ({
      lesson:    r.lesson,
      outcome:   r.outcome,
      reasoning: r.reasoning || undefined,
    }));
  } catch {
    return readJsonFallback().recentLessons.slice(0, limit).map(lesson => ({ lesson, outcome: "unknown" }));
  }
}

// ── Winner / loser pattern analysis (F2) ─────────────────────

/**
 * Returns a short narrative comparing winner traits vs top loss reasons
 * for a given symbol+regime combination.
 */
export async function getWinnerLoserSummary(symbol: string, regime: string): Promise<string> {
  try {
    // ai_lessons has failureCategory; ai_patterns has volumeState — fetch both in parallel
    const [lessonRows, patternRows] = await Promise.all([
      db
        .select({ outcome: aiLessonsTable.outcome, failureCategory: aiLessonsTable.failureCategory })
        .from(aiLessonsTable)
        .where(and(eq(aiLessonsTable.symbol, symbol), eq(aiLessonsTable.regime, regime))),
      db
        .select({ outcome: aiPatternsTable.outcome, session: aiPatternsTable.session, htfBias: aiPatternsTable.htfBias, volumeState: aiPatternsTable.volumeState })
        .from(aiPatternsTable)
        .where(and(eq(aiPatternsTable.symbol, symbol), eq(aiPatternsTable.regime, regime))),
    ]);

    if (lessonRows.length < 5) return "";

    const losers  = lessonRows.filter(r => r.outcome !== "tp_hit");
    const winners = patternRows.filter(r => r.outcome === "tp_hit");

    const lines: string[] = [];

    if (winners.length > 0) {
      const topSession     = freqTop(winners.map(r => r.session), 1)[0];
      const topBias        = freqTop(winners.map(r => r.htfBias), 1)[0];
      const topVolumeState = freqTop(winners.map(r => r.volumeState), 1)[0];
      const parts: string[] = [];
      if (topSession)     parts.push(`${topSession[0]} session`);
      if (topBias)        parts.push(`htfBias=${topBias[0]}`);
      if (topVolumeState) parts.push(`volume=${topVolumeState[0]}`);
      if (parts.length > 0) {
        lines.push(`Winners (${winners.length}/${patternRows.length}): strongest in ${parts.join(", ")}`);
      }
    }

    if (losers.length >= 3) {
      const top2 = freqTop(losers.map(r => r.failureCategory), 2);
      const parts = top2.map(([cat, cnt]) =>
        `${cat} (${Math.round(cnt / losers.length * 100)}%)`
      );
      if (parts.length > 0) {
        lines.push(`Top loss reasons: ${parts.join(", ")}`);
      }
    }

    return lines.join("\n  ");
  } catch {
    return "";
  }
}

// ── Regime-specific failure stats (F3) ────────────────────────

/**
 * Returns a summary of top failure categories for losses in a given
 * symbol+regime, formatted as a single string for prompt injection.
 */
export async function getFailureCategoryStats(symbol: string, regime: string): Promise<string> {
  try {
    const rows = await db
      .select({ failureCategory: aiLessonsTable.failureCategory })
      .from(aiLessonsTable)
      .where(and(
        eq(aiLessonsTable.symbol, symbol),
        eq(aiLessonsTable.regime, regime),
        ne(aiLessonsTable.outcome, "tp_hit"),
      ));

    if (rows.length < 3) return "";

    const top2 = freqTop(rows.map(r => r.failureCategory), 2);
    return top2.map(([cat, cnt]) =>
      `${cat} (${Math.round(cnt / rows.length * 100)}%)`
    ).join(", ");
  } catch {
    return "";
  }
}

// ── Most recent loss reasoning (F5) ───────────────────────────

/**
 * Returns Qwen3's reasoning text from the most recent SL-hit lesson
 * for this symbol — injected into the next decision prompt as a
 * cautionary reference.
 */
export async function getMostRecentLossReasoning(symbol: string): Promise<string> {
  try {
    const rows = await db
      .select({ reasoning: aiLessonsTable.reasoning })
      .from(aiLessonsTable)
      .where(and(
        eq(aiLessonsTable.symbol, symbol),
        eq(aiLessonsTable.outcome, "sl_hit"),
      ))
      .orderBy(desc(aiLessonsTable.createdAt))
      .limit(1);

    return rows[0]?.reasoning ?? "";
  } catch {
    return "";
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
    reasoning:               r.reasoning || undefined,
  };
}
