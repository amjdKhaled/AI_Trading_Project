import { Router, type IRouter } from "express";
import { db, signalsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { isOllamaAvailable, MODEL, OLLAMA_BASE_URL } from "../lib/ai/ollama.js";
import { reflectOnTrade, reflectWithoutAi } from "../lib/ai/reflection.js";
import { filterSignalWithAi } from "../lib/ai/filter.js";
import { getMemorySummary, loadMemory } from "../lib/ai/memory.js";
import type { TradeMemoryEntry } from "../lib/ai/types.js";

const router: IRouter = Router();

// ── GET /ai/status ─────────────────────────────────────────────
// Check if Ollama is reachable and report model config.
router.get("/ai/status", async (req, res): Promise<void> => {
  const available = await isOllamaAvailable();
  res.json({
    available,
    model:    MODEL,
    endpoint: OLLAMA_BASE_URL,
    message:  available
      ? `Ollama reachable at ${OLLAMA_BASE_URL} — model: ${MODEL}`
      : `Ollama NOT reachable at ${OLLAMA_BASE_URL}. Start Ollama locally: ollama serve`,
  });
});

// ── GET /ai/memory ──────────────────────────────────────────────
// View the trade memory store (stats + recent lessons).
router.get("/ai/memory", (_req, res): void => {
  const summary = getMemorySummary();
  res.json({ ok: true, ...summary });
});

// ── GET /ai/memory/trades ───────────────────────────────────────
// Raw trade list with optional symbol filter.
router.get("/ai/memory/trades", (req, res): void => {
  const symbol = typeof req.query.symbol === "string" ? req.query.symbol.toUpperCase() : null;
  const limit  = Math.min(parseInt(String(req.query.limit ?? "50"), 10), 200);
  const store  = loadMemory();
  const trades = symbol ? store.trades.filter(t => t.symbol === symbol) : store.trades;
  res.json({ ok: true, total: trades.length, trades: trades.slice(0, limit) });
});

// ── POST /ai/reflect ────────────────────────────────────────────
// Trigger AI reflection on a completed trade (by signalId).
// Pulls the signal from DB, runs Ollama reflection, stores lesson in memory.
router.post("/ai/reflect", async (req, res): Promise<void> => {
  const { signalId, useAi = true } = req.body as { signalId?: string; useAi?: boolean };
  if (!signalId) { res.status(400).json({ error: "signalId required" }); return; }

  const rows = await db.select().from(signalsTable).where(eq(signalsTable.signalId, signalId)).limit(1);
  if (rows.length === 0) { res.status(404).json({ error: "Signal not found" }); return; }

  const row = rows[0];
  if (row.state === "active") {
    res.status(400).json({ error: "Cannot reflect on an active trade — wait for it to close" });
    return;
  }

  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const trade: TradeMemoryEntry = {
    id:              row.signalId,
    timestamp:       row.barTime?.toISOString() ?? new Date().toISOString(),
    symbol:          row.symbol,
    timeframe:       row.timeframe,
    side:            row.side as "long" | "short",
    strategy:        String(meta.strategy ?? row.pattern ?? "unknown"),
    regime:          String(meta.regime   ?? row.regime  ?? "ranging"),
    session:         String(meta.session  ?? "unknown"),
    htfBias:         String(meta.htfBias  ?? "neutral"),
    confluenceCount: Number(meta.confluenceCount ?? 0),
    confidence:      row.confidence,
    grade:           row.grade ?? "B",
    riskLevel:       row.riskTag ?? "Medium",
    rrRatio:         row.rrRatio ?? 1,
    entryPrice:      row.entryPrice,
    slPrice:         row.slPrice,
    tpPrice:         row.tpPrice,
    exitPrice:       row.exitPrice ?? null,
    outcome:         row.state as "tp_hit" | "sl_hit" | "expired",
    volumeState:     String(meta.volumeState    ?? "neutral"),
    structureState:  String(meta.structureState ?? "mixed"),
    patterns:        row.pattern ? [row.pattern] : [],
  };

  try {
    if (useAi) {
      const available = await isOllamaAvailable();
      if (!available) {
        await reflectWithoutAi(trade);
        res.json({
          ok: true, signalId,
          aiUsed: false,
          warning: "Ollama not available — trade stored without AI reflection",
          trade,
        });
        return;
      }
      const reflection = await reflectOnTrade(trade);
      res.json({ ok: true, signalId, aiUsed: true, reflection, trade });
    } else {
      await reflectWithoutAi(trade);
      res.json({ ok: true, signalId, aiUsed: false, trade });
    }
  } catch (err) {
    req.log?.warn({ err, signalId }, "AI reflection failed");
    await reflectWithoutAi(trade);
    res.json({
      ok: true, signalId, aiUsed: false,
      error: (err as Error).message,
      warning: "AI reflection failed — trade stored without lesson",
    });
  }
});

// ── POST /ai/reflect/batch ──────────────────────────────────────
// Reflect on ALL closed signals for a symbol (up to limit).
// Useful for bootstrapping memory from existing backtest data.
// Set useAi=false to store trades without Ollama calls (fast).
router.post("/ai/reflect/batch", async (req, res): Promise<void> => {
  const { symbol, useAi = false, limit = 100 } = req.body as {
    symbol?: string;
    useAi?: boolean;
    limit?: number;
  };

  if (!symbol) { res.status(400).json({ error: "symbol required" }); return; }

  const rows = await db
    .select()
    .from(signalsTable)
    .where(eq(signalsTable.symbol, symbol.toUpperCase()))
    .limit(Math.min(Number(limit), 500));

  const closed = rows.filter(r => r.state !== "active");
  let processed = 0;
  let errors    = 0;

  for (const row of closed) {
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const trade: TradeMemoryEntry = {
      id:              row.signalId,
      timestamp:       row.barTime?.toISOString() ?? new Date().toISOString(),
      symbol:          row.symbol,
      timeframe:       row.timeframe,
      side:            row.side as "long" | "short",
      strategy:        String(meta.strategy ?? row.pattern ?? "unknown"),
      regime:          String(meta.regime   ?? row.regime  ?? "ranging"),
      session:         String(meta.session  ?? "unknown"),
      htfBias:         String(meta.htfBias  ?? "neutral"),
      confluenceCount: Number(meta.confluenceCount ?? 0),
      confidence:      row.confidence,
      grade:           row.grade ?? "B",
      riskLevel:       row.riskTag ?? "Medium",
      rrRatio:         row.rrRatio ?? 1,
      entryPrice:      row.entryPrice,
      slPrice:         row.slPrice,
      tpPrice:         row.tpPrice,
      exitPrice:       row.exitPrice ?? null,
      outcome:         row.state as "tp_hit" | "sl_hit" | "expired",
      volumeState:     String(meta.volumeState    ?? "neutral"),
      structureState:  String(meta.structureState ?? "mixed"),
      patterns:        row.pattern ? [row.pattern] : [],
    };

    try {
      if (useAi) {
        const available = await isOllamaAvailable();
        if (available) {
          await reflectOnTrade(trade);
        } else {
          await reflectWithoutAi(trade);
        }
      } else {
        await reflectWithoutAi(trade);
      }
      processed++;
    } catch {
      errors++;
    }
  }

  res.json({ ok: true, symbol, processed, errors, useAi, total: closed.length });
});

// ── POST /ai/filter ─────────────────────────────────────────────
// Run a signal context through the AI filter manually (for testing).
router.post("/ai/filter", async (req, res): Promise<void> => {
  const ctx = req.body as Parameters<typeof filterSignalWithAi>[0];
  if (!ctx?.symbol || !ctx?.side) {
    res.status(400).json({ error: "signal context required (symbol, side, strategy, regime, ...)" });
    return;
  }

  const available = await isOllamaAvailable();
  if (!available) {
    res.status(503).json({
      error: "Ollama not available",
      hint:  `Start Ollama locally: ollama serve && ollama pull ${MODEL}`,
    });
    return;
  }

  try {
    const verdict = await filterSignalWithAi(ctx);
    res.json({ ok: true, verdict });
  } catch (err) {
    req.log?.warn({ err }, "AI filter failed");
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
