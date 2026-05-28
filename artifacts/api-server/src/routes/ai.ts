import { Router, type IRouter } from "express";
import { db, signalsTable, aiLessonsTable, aiPatternsTable, aiMarketRegimesTable, aiChartAnalysesTable } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import { isOllamaAvailable, MODEL, OLLAMA_BASE_URL } from "../lib/ai/ollama.js";
import { isVisionAvailable, VISION_MODEL } from "../lib/ai/ollama-vision.js";
import { reflectOnTrade, reflectWithoutAi } from "../lib/ai/reflection.js";
import { filterSignalWithAi } from "../lib/ai/filter.js";
import { getMemorySummary, loadMemory } from "../lib/ai/memory.js";
import { getMemorySummaryFromDb } from "../lib/ai/shared-memory.js";
import { aiDecide } from "../lib/ai/decide.js";
import { analyzeChart } from "../lib/ai/analyze-chart.js";
import { findSimilarPatterns } from "../lib/ai/similarity.js";
import { fetchHistory } from "./history.js";
import type { TradeMemoryEntry } from "../lib/ai/types.js";

const router: IRouter = Router();

// ── GET /ai/status ─────────────────────────────────────────────
// Reports both decision model (qwen2.5:14b) and vision model (qwen2.5-vl:7b).
router.get("/ai/status", async (req, res): Promise<void> => {
  const [available, visionAvailable] = await Promise.all([
    isOllamaAvailable(),
    isVisionAvailable(),
  ]);
  res.json({
    available,
    model:          MODEL,
    endpoint:       OLLAMA_BASE_URL,
    visionModel:    VISION_MODEL,
    visionAvailable,
    message: available
      ? `Ollama reachable at ${OLLAMA_BASE_URL} — decision: ${MODEL}, vision: ${VISION_MODEL} (${visionAvailable ? "ready" : "not pulled"})`
      : `Ollama NOT reachable at ${OLLAMA_BASE_URL}. Start Ollama locally: ollama serve`,
  });
});

// ── GET /ai/memory ──────────────────────────────────────────────
// DB-backed stats: lessons count, pattern count, similarity matches.
router.get("/ai/memory", async (_req, res): Promise<void> => {
  try {
    const summary = await getMemorySummaryFromDb();
    res.json({ ok: true, source: "db", ...summary });
  } catch {
    const summary = getMemorySummary();
    res.json({ ok: true, source: "json_fallback", lessonsCount: summary.totalTrades, patternsCount: 0, ...summary });
  }
});

// ── GET /ai/memory/trades ───────────────────────────────────────
// Raw trade list with optional symbol filter (JSON fallback for compatibility).
router.get("/ai/memory/trades", (req, res): void => {
  const symbol = typeof req.query.symbol === "string" ? req.query.symbol.toUpperCase() : null;
  const limit  = Math.min(parseInt(String(req.query.limit ?? "50"), 10), 200);
  const store  = loadMemory();
  const trades = symbol ? store.trades.filter(t => t.symbol === symbol) : store.trades;
  res.json({ ok: true, total: trades.length, trades: trades.slice(0, limit) });
});

// ── POST /ai/reflect ────────────────────────────────────────────
// Trigger AI reflection on a completed trade (by signalId).
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

  const trade = rowToTradeEntry(row);

  try {
    if (useAi) {
      const available = await isOllamaAvailable();
      if (!available) {
        await reflectWithoutAi(trade);
        res.json({ ok: true, signalId, aiUsed: false, warning: "Ollama not available — trade stored without AI reflection", trade });
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
    res.json({ ok: true, signalId, aiUsed: false, error: (err as Error).message, warning: "AI reflection failed — trade stored without lesson" });
  }
});

// ── POST /ai/reflect/batch ──────────────────────────────────────
// Reflect on ALL closed signals for a symbol (up to limit).
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
    const trade = rowToTradeEntry(row);
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

// ── POST /ai/decide ─────────────────────────────────────────────
// Full AI-first decision pipeline using shared memory + similarity engine.
router.post("/ai/decide", async (req, res): Promise<void> => {
  const { symbol, timeframe = "5m" } = req.body as { symbol?: string; timeframe?: string };
  if (!symbol) { res.status(400).json({ error: "symbol required" }); return; }

  const sym = symbol.toUpperCase();

  const available = await isOllamaAvailable();
  if (!available) {
    res.status(503).json({
      ok: false,
      error: "Ollama not available — start it locally first",
      hint: `ollama serve && ollama pull ${MODEL}`,
    });
    return;
  }

  try {
    const bars = (await fetchHistory(sym, timeframe)) as import("../lib/analyzer/types.js").OhlcvBar[];

    let htfBars: import("../lib/analyzer/types.js").OhlcvBar[] = [];
    if (timeframe === "5m") {
      try {
        htfBars = (await fetchHistory(sym, "15m")) as import("../lib/analyzer/types.js").OhlcvBar[];
      } catch { /* HTF optional */ }
    }

    const decision = await aiDecide({ symbol: sym, timeframe, bars, htfBars });

    let signalId: string | null = null;

    if (decision.decision !== "NO_TRADE") {
      const ID_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      signalId = "AI" + Array.from({ length: 10 }, () =>
        ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)],
      ).join("");

      const lastBar = bars[bars.length - 2];
      const sl      = decision.stopLoss;
      const tp      = decision.takeProfit;
      const entry   = decision.entry;
      const rr      = Math.abs(tp - entry) / (Math.abs(entry - sl) || 0.001);

      try {
        await db.insert(signalsTable).values({
          signalId,
          symbol:         sym,
          timeframe,
          barTime:        new Date(lastBar.time * 1000),
          side:           decision.decision === "BUY" ? "long" : "short",
          entryPrice:     entry,
          slPrice:        sl,
          tpPrice:        tp,
          currentSlPrice: sl,
          confidence:     decision.confidence,
          riskTag:        rr >= 2 ? "Safe" : rr >= 1.5 ? "Medium" : "Danger",
          state:          "active",
          rrRatio:        Math.round(rr * 100) / 100,
          pattern:        "AI Decision",
          regime:         "ai_generated",
          grade:          decision.confidence >= 80 ? "A" : "B",
          metadata: {
            aiDecision: true,
            reasoning:  decision.reasoning,
            marketBias: decision.marketBias,
            confidence: decision.confidence,
          } as Record<string, unknown>,
        });
        req.log?.info({ signalId, decision: decision.decision, sym, confidence: decision.confidence }, "AI signal persisted");
      } catch (dbErr) {
        req.log?.warn({ dbErr, signalId }, "AI signal DB insert failed — returning decision without signalId");
        signalId = null;
      }
    }

    res.json({ ok: true, ...decision, signalId, aiUsed: true, barsUsed: bars.length });
  } catch (err) {
    req.log?.warn({ err, symbol: sym, timeframe }, "AI decide failed");
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
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

// ── POST /ai/analyze-chart ──────────────────────────────────────
// Accept a base64 chart image, run qwen2.5-vl:7b vision analysis,
// cross-reference shared memory for similar historical patterns,
// and return a structured ChartAnalysis + historicalMatches.
router.post("/ai/analyze-chart", async (req, res): Promise<void> => {
  const { imageBase64, symbol, timeframe, signalId } = req.body as {
    imageBase64?: string;
    symbol?: string;
    timeframe?: string;
    signalId?: string;
  };

  if (!imageBase64) {
    res.status(400).json({ error: "imageBase64 required" });
    return;
  }

  const visionOk = await isVisionAvailable();
  if (!visionOk) {
    res.status(503).json({
      ok: false,
      error: `Vision model ${VISION_MODEL} not available`,
      hint: `Pull it first: ollama pull ${VISION_MODEL}`,
    });
    return;
  }

  try {
    const [analysis, historicalMatches] = await Promise.all([
      analyzeChart({ imageBase64, symbol, timeframe, signalId }),
      symbol
        ? findSimilarPatterns({ symbol, regime: "unknown", side: "long" }, 5)
        : Promise.resolve([]),
    ]);

    req.log?.info({ symbol, timeframe, signalId, trend: analysis.trend, confidence: analysis.confidence }, "Chart analysis complete");
    res.json({ ok: true, analysis, historicalMatches });
  } catch (err) {
    req.log?.warn({ err, symbol, timeframe }, "Chart analysis failed");
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ── POST /ai/similarity ─────────────────────────────────────────
// Query the pattern similarity engine for a given context.
router.post("/ai/similarity", async (req, res): Promise<void> => {
  const { symbol, regime, side, strategy, patternTags, session } = req.body as {
    symbol?: string;
    regime?: string;
    side?: "long" | "short";
    strategy?: string;
    patternTags?: string[];
    session?: string;
  };

  if (!symbol || !side) {
    res.status(400).json({ error: "symbol and side are required" });
    return;
  }

  try {
    const matches = await findSimilarPatterns({
      symbol,
      regime: regime ?? "ranging",
      side,
      strategy,
      patternTags,
      session,
    });
    res.json({ ok: true, matches });
  } catch (err) {
    req.log?.warn({ err }, "Similarity query failed");
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ── GET /ai/lessons ─────────────────────────────────────────────
// Paginated list from ai_lessons. Filters: symbol, outcome, failureCategory.
router.get("/ai/lessons", async (req, res): Promise<void> => {
  const symbol          = typeof req.query.symbol === "string"          ? req.query.symbol.toUpperCase() : undefined;
  const outcome         = typeof req.query.outcome === "string"         ? req.query.outcome              : undefined;
  const failureCategory = typeof req.query.failureCategory === "string" ? req.query.failureCategory      : undefined;
  const limit  = Math.min(parseInt(String(req.query.limit  ?? "100"), 10), 500);
  const offset = parseInt(String(req.query.offset ?? "0"), 10);

  try {
    const conditions = [
      symbol          ? eq(aiLessonsTable.symbol,          symbol)                        : undefined,
      outcome         ? eq(aiLessonsTable.outcome,         outcome)                       : undefined,
      failureCategory ? eq(aiLessonsTable.failureCategory, failureCategory as never)      : undefined,
    ].filter(Boolean) as Parameters<typeof and>[0][];

    const rows = await db
      .select()
      .from(aiLessonsTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(aiLessonsTable.createdAt))
      .limit(limit)
      .offset(offset);

    res.json({ ok: true, lessons: rows, total: rows.length });
  } catch (err) {
    req.log?.warn({ err }, "GET /ai/lessons failed");
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ── GET /ai/patterns ────────────────────────────────────────────
// Historical setup library. Filters: symbol, side, regime.
router.get("/ai/patterns", async (req, res): Promise<void> => {
  const symbol = typeof req.query.symbol === "string" ? req.query.symbol.toUpperCase() : undefined;
  const side   = typeof req.query.side   === "string" ? req.query.side                 : undefined;
  const regime = typeof req.query.regime === "string" ? req.query.regime               : undefined;
  const limit  = Math.min(parseInt(String(req.query.limit ?? "500"), 10), 1000);

  try {
    const conditions = [
      symbol ? eq(aiPatternsTable.symbol, symbol) : undefined,
      side   ? eq(aiPatternsTable.side,   side)   : undefined,
      regime ? eq(aiPatternsTable.regime, regime) : undefined,
    ].filter(Boolean) as Parameters<typeof and>[0][];

    const rows = await db
      .select()
      .from(aiPatternsTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(aiPatternsTable.createdAt))
      .limit(limit);

    res.json({ ok: true, patterns: rows, total: rows.length });
  } catch (err) {
    req.log?.warn({ err }, "GET /ai/patterns failed");
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ── GET /ai/regimes ─────────────────────────────────────────────
// Regime time-series. Optional symbol filter.
router.get("/ai/regimes", async (req, res): Promise<void> => {
  const symbol = typeof req.query.symbol === "string" ? req.query.symbol.toUpperCase() : undefined;
  const limit  = Math.min(parseInt(String(req.query.limit ?? "500"), 10), 2000);

  try {
    const rows = await db
      .select()
      .from(aiMarketRegimesTable)
      .where(symbol ? eq(aiMarketRegimesTable.symbol, symbol) : undefined)
      .orderBy(desc(aiMarketRegimesTable.snapshottedAt))
      .limit(limit);

    res.json({ ok: true, regimes: rows, total: rows.length });
  } catch (err) {
    req.log?.warn({ err }, "GET /ai/regimes failed");
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ── GET /ai/chart-analyses ──────────────────────────────────────
// Recent vision model chart analyses. Optional symbol filter.
router.get("/ai/chart-analyses", async (req, res): Promise<void> => {
  const symbol = typeof req.query.symbol === "string" ? req.query.symbol.toUpperCase() : undefined;
  const limit  = Math.min(parseInt(String(req.query.limit ?? "20"), 10), 100);

  try {
    const rows = await db
      .select()
      .from(aiChartAnalysesTable)
      .where(symbol ? eq(aiChartAnalysesTable.symbol, symbol) : undefined)
      .orderBy(desc(aiChartAnalysesTable.createdAt))
      .limit(limit);

    res.json({ ok: true, analyses: rows, total: rows.length });
  } catch (err) {
    req.log?.warn({ err }, "GET /ai/chart-analyses failed");
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ── Helper ────────────────────────────────────────────────────

function rowToTradeEntry(row: typeof signalsTable.$inferSelect): TradeMemoryEntry {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  return {
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
}

export { rowToTradeEntry };
export default router;
