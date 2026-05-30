import { eq, and, isNull, isNotNull } from "drizzle-orm";
import { db, aiDecisionsTable } from "@workspace/db";
import type { AiDecisionRow } from "@workspace/db";

const TF_INTERVAL_SEC: Record<string, number> = {
  "5m": 300, "15m": 900, "1h": 3600, "1d": 86400,
};

export interface LatestBar {
  time:  number;   // epoch seconds
  open:  number;
  high:  number;
  low:   number;
  close: number;
}

/**
 * For every APPROVED aiDecisions row with no outcome yet, check whether the
 * latest completed bar hit the TP, SL, or expiry limit (20 bars).
 * Mutates those rows in the DB and returns the newly-resolved rows so the
 * caller can fire reflections.
 */
export async function checkOpenDecisions(
  symbol:    string,
  timeframe: string,
  bar:       LatestBar,
): Promise<AiDecisionRow[]> {
  const rows = await db
    .select()
    .from(aiDecisionsTable)
    .where(
      and(
        eq(aiDecisionsTable.symbol,    symbol),
        eq(aiDecisionsTable.timeframe, timeframe),
        eq(aiDecisionsTable.verdict,   "APPROVE"),
        isNull(aiDecisionsTable.outcome),
        isNotNull(aiDecisionsTable.candidateSide),
        isNotNull(aiDecisionsTable.entryPrice),
      ),
    );

  const intervalSec = TF_INTERVAL_SEC[timeframe] ?? 300;
  const expiryMs    = 20 * intervalSec * 1000;
  const resolved: AiDecisionRow[] = [];

  for (const row of rows) {
    const side      = row.candidateSide as "long" | "short";
    const tp        = row.tpPrice;
    const sl        = row.slPrice;
    const candleMs  = new Date(row.candleTime).getTime();
    const barMs     = bar.time * 1000;

    let outcome:      "tp_hit" | "sl_hit" | "expired" | null = null;
    let outcomePrice: number | null = null;

    if (tp !== null && sl !== null) {
      if (side === "long") {
        if (bar.high >= tp)  { outcome = "tp_hit";  outcomePrice = tp; }
        else if (bar.low <= sl) { outcome = "sl_hit"; outcomePrice = sl; }
      } else {
        if (bar.low <= tp)   { outcome = "tp_hit";  outcomePrice = tp; }
        else if (bar.high >= sl) { outcome = "sl_hit"; outcomePrice = sl; }
      }
    }

    if (!outcome && barMs - candleMs > expiryMs) {
      outcome      = "expired";
      outcomePrice = bar.close;
    }

    if (outcome) {
      await db
        .update(aiDecisionsTable)
        .set({
          outcome,
          outcomePrice,
          resolvedAt: new Date(),
        })
        .where(eq(aiDecisionsTable.id, row.id));

      resolved.push({ ...row, outcome, outcomePrice, resolvedAt: new Date(), reflected: false });
    }
  }

  return resolved;
}
