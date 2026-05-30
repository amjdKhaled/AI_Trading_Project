import { eq } from "drizzle-orm";
import { db, aiDecisionsTable } from "@workspace/db";
import type { AiDecisionRow } from "@workspace/db";
import { isOllamaAvailable } from "./ollama.js";
import { reflectOnTrade, reflectWithoutAi } from "./reflection.js";
import type { TradeMemoryEntry } from "./types.js";

function decisionToTradeEntry(row: AiDecisionRow): TradeMemoryEntry {
  const tc = (row.technicalContext ?? {}) as Record<string, unknown>;
  const outcome = row.outcome as "tp_hit" | "sl_hit" | "expired";

  return {
    id:              String(row.id),
    timestamp:       new Date(row.candleTime).toISOString(),
    symbol:          row.symbol,
    timeframe:       row.timeframe,
    side:            (row.candidateSide ?? "long") as "long" | "short",
    strategy:        "candle_decision",
    regime:          row.regime         ?? "ranging",
    session:         row.session        ?? "unknown",
    htfBias:         row.htfBias        ?? "neutral",
    confluenceCount: typeof tc.confluenceCount === "number" ? tc.confluenceCount : 0,
    confidence:      row.confidence,
    grade:           "B",
    riskLevel:       "Medium",
    rrRatio:         row.rrRatio        ?? 1,
    entryPrice:      row.entryPrice     ?? 0,
    slPrice:         row.slPrice        ?? 0,
    tpPrice:         row.tpPrice        ?? 0,
    exitPrice:       row.outcomePrice   ?? null,
    outcome,
    volumeState:     typeof tc.relVol === "number" && tc.relVol > 1.2 ? "high" : "neutral",
    structureState:  typeof tc.trend === "string" ? tc.trend : "mixed",
    patterns:        Array.isArray(row.patterns) ? row.patterns : [],
  };
}

/**
 * For each resolved aiDecisions row, fire reflection (with or without Ollama)
 * and mark `reflected = true` on success. Also accepts rows that previously
 * failed reflection (outcome set but reflected = false) for automatic retry.
 *
 * Uses Promise.allSettled so one failure never blocks the rest.
 */
export async function autoReflectResolved(
  rows:    AiDecisionRow[],
  log?:    { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void },
): Promise<void> {
  if (rows.length === 0) return;

  const ollamaOk = await isOllamaAvailable();

  const tasks = rows.map(async (row) => {
    const trade = decisionToTradeEntry(row);
    try {
      if (ollamaOk) {
        await reflectOnTrade(trade);
      } else {
        await reflectWithoutAi(trade);
      }
      await db
        .update(aiDecisionsTable)
        .set({ reflected: true })
        .where(eq(aiDecisionsTable.id, row.id));

      log?.info(
        { id: row.id, symbol: row.symbol, outcome: row.outcome },
        "Auto-reflection complete",
      );
    } catch (err) {
      log?.warn(
        { id: row.id, symbol: row.symbol, outcome: row.outcome, err },
        "Auto-reflection failed — will retry on next candle close",
      );
    }
  });

  await Promise.allSettled(tasks);
}
