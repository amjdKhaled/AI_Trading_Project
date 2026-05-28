// ============================================================
// Similarity Engine — historical pattern matching
// Queries ai_patterns for setups matching symbol ± regime ± side,
// returns SimilarityMatch[] with win rate, avg gain, and a match score.
// ============================================================

import { db, aiPatternsTable } from "@workspace/db";
import { eq, and, or } from "drizzle-orm";
import { logger } from "../logger.js";

export interface SimilarityMatch {
  symbol: string;
  regime: string;
  side: string;
  strategy: string;
  patternTags: string[];
  session: string;
  htfBias: string;
  historicalWinRate: number;
  avgRR: number;
  sampleSize: number;
  matchScore: number;
  recentOutcomes: string[];
}

interface QueryContext {
  symbol: string;
  regime: string;
  side: "long" | "short";
  strategy?: string;
  patternTags?: string[];
  session?: string;
}

function scoreMatch(
  candidate: typeof aiPatternsTable.$inferSelect,
  ctx: QueryContext,
): number {
  let score = 0;
  if (candidate.symbol === ctx.symbol)   score += 40;
  if (candidate.regime === ctx.regime)   score += 25;
  if (candidate.side === ctx.side)       score += 20;
  if (ctx.strategy && candidate.strategy === ctx.strategy) score += 10;
  if (ctx.session && candidate.session === ctx.session)    score += 5;
  const tags: string[] = (candidate.patternTags as string[]) ?? [];
  const ctxTags = ctx.patternTags ?? [];
  const shared = tags.filter(t => ctxTags.includes(t)).length;
  if (ctxTags.length > 0 && tags.length > 0) score += Math.min(10, shared * 5);
  return Math.min(100, score);
}

export async function findSimilarPatterns(ctx: QueryContext, limit = 6): Promise<SimilarityMatch[]> {
  try {
    const rows = await db
      .select()
      .from(aiPatternsTable)
      .where(
        and(
          eq(aiPatternsTable.side, ctx.side),
          or(
            eq(aiPatternsTable.symbol, ctx.symbol),
            eq(aiPatternsTable.regime, ctx.regime),
          ),
        ),
      )
      .limit(200);

    if (rows.length === 0) return [];

    const scored = rows.map(r => ({ row: r, score: scoreMatch(r, ctx) }));
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit * 5);

    const grouped = new Map<string, typeof top>();
    for (const item of top) {
      const key = `${item.row.symbol}|${item.row.regime}|${item.row.side}|${item.row.strategy}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(item);
    }

    const results: SimilarityMatch[] = [];
    for (const [, items] of grouped) {
      if (results.length >= limit) break;
      const outcomes = items.map(i => i.row.outcome);
      const wins = outcomes.filter(o => o === "tp_hit").length;
      const winRate = outcomes.length > 0 ? wins / outcomes.length : 0;
      const rrs = items.map(i => i.row.rrRatio).filter(r => r > 0);
      const avgRR = rrs.length > 0 ? rrs.reduce((s, r) => s + r, 0) / rrs.length : 1;
      const rep = items[0].row;

      results.push({
        symbol:            rep.symbol,
        regime:            rep.regime,
        side:              rep.side,
        strategy:          rep.strategy,
        patternTags:       (rep.patternTags as string[]) ?? [],
        session:           rep.session,
        htfBias:           rep.htfBias,
        historicalWinRate: Math.round(winRate * 1000) / 1000,
        avgRR:             Math.round(avgRR * 100) / 100,
        sampleSize:        outcomes.length,
        matchScore:        Math.round(items[0].score),
        recentOutcomes:    outcomes.slice(0, 5),
      });
    }

    results.sort((a, b) => b.matchScore - a.matchScore);
    return results;
  } catch (err) {
    logger.warn({ err }, "Similarity engine failed — returning empty matches");
    return [];
  }
}

export function formatSimilarityContext(matches: SimilarityMatch[]): string {
  if (matches.length === 0) return "  No historical pattern matches found.";
  return matches.map(m =>
    `  [score:${m.matchScore}] ${m.symbol} ${m.side} ${m.regime} via ${m.strategy}: ` +
    `${Math.round(m.historicalWinRate * 100)}% WR over ${m.sampleSize} trades, avg RR ${m.avgRR}`
  ).join("\n");
}
