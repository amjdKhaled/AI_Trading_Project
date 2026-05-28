// ============================================================
// Regime Tracker — writes to ai_market_regimes on every aiDecide call.
// Builds up a historical time-series of market conditions per symbol
// so future AI decisions can incorporate regime history context.
// ============================================================

import { db, aiMarketRegimesTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { logger } from "../logger.js";

export interface RegimeSnapshot {
  symbol:    string;
  timeframe: string;
  regime:    string;
  htfBias:   string;
  atr?:      number;
  rsi?:      number;
  macd?:     number;
  vwapDiff?: number;
}

// ── Write ────────────────────────────────────────────────────

export async function snapshotRegime(snap: RegimeSnapshot): Promise<void> {
  try {
    await db.insert(aiMarketRegimesTable).values({
      symbol:       snap.symbol,
      timeframe:    snap.timeframe,
      regime:       snap.regime,
      htfBias:      snap.htfBias,
      atr:          snap.atr      ?? null,
      rsi:          snap.rsi      ?? null,
      macd:         snap.macd     ?? null,
      vwapDiff:     snap.vwapDiff ?? null,
    });
    logger.debug({ symbol: snap.symbol, regime: snap.regime, htfBias: snap.htfBias }, "Regime snapshot recorded");
  } catch (err) {
    logger.warn({ err, symbol: snap.symbol }, "Regime snapshot DB write failed");
  }
}

// ── Read ─────────────────────────────────────────────────────

export async function getRecentRegimes(symbol: string, limit = 100) {
  return db
    .select()
    .from(aiMarketRegimesTable)
    .where(eq(aiMarketRegimesTable.symbol, symbol))
    .orderBy(desc(aiMarketRegimesTable.snapshottedAt))
    .limit(limit);
}

export async function getAllRegimes(limit = 500) {
  return db
    .select()
    .from(aiMarketRegimesTable)
    .orderBy(desc(aiMarketRegimesTable.snapshottedAt))
    .limit(limit);
}

/** Regime distribution for a symbol — counts per regime type. */
export async function getRegimeDistribution(symbol?: string): Promise<Record<string, number>> {
  const rows = symbol
    ? await db
        .select()
        .from(aiMarketRegimesTable)
        .where(eq(aiMarketRegimesTable.symbol, symbol))
        .orderBy(desc(aiMarketRegimesTable.snapshottedAt))
        .limit(500)
    : await db
        .select()
        .from(aiMarketRegimesTable)
        .orderBy(desc(aiMarketRegimesTable.snapshottedAt))
        .limit(500);

  const dist: Record<string, number> = {};
  for (const r of rows) {
    const label =
      r.regime === "trending" && r.htfBias === "bull" ? "Bull Market" :
      r.regime === "trending" && r.htfBias === "bear" ? "Bear Market" :
      r.regime === "trending"                          ? "Trending" :
      r.regime === "vol_expansion"                     ? "High Volatility" :
      r.regime === "ranging"                           ? "Range Market" :
      r.regime === "chop"                              ? "Low Volatility" :
      r.regime;
    dist[label] = (dist[label] ?? 0) + 1;
  }
  return dist;
}

/** Recent regime history formatted as a string for injection into AI prompts. */
export async function formatRecentRegimeHistory(symbol: string, limit = 10): Promise<string> {
  try {
    const rows = await getRecentRegimes(symbol, limit);
    if (rows.length === 0) return "  No regime history yet.";
    return rows
      .slice(0, limit)
      .map(r => {
        const label =
          r.regime === "trending" && r.htfBias === "bull" ? "Bull Market" :
          r.regime === "trending" && r.htfBias === "bear" ? "Bear Market" :
          r.regime === "vol_expansion"                     ? "High Volatility" :
          r.regime === "ranging"                           ? "Range Market" :
          r.regime === "chop"                              ? "Low Volatility" :
          r.regime;
        const rsiStr  = r.rsi   != null ? ` RSI:${r.rsi.toFixed(0)}`   : "";
        const atrStr  = r.atr   != null ? ` ATR:${r.atr.toFixed(2)}`   : "";
        const vwapStr = r.vwapDiff != null
          ? ` VWAP:${r.vwapDiff > 0 ? "+" : ""}${r.vwapDiff.toFixed(1)}%` : "";
        const ts = r.snapshottedAt.toISOString().slice(0, 10);
        return `  ${ts}: ${label}${rsiStr}${atrStr}${vwapStr}`;
      })
      .join("\n");
  } catch {
    return "  Regime history unavailable.";
  }
}
