import { Router, type IRouter } from "express";
import { eq, desc, and, gte, inArray, isNull, isNotNull, type SQL } from "drizzle-orm";
import { db, signalsTable, aiDecisionsTable } from "@workspace/db";
import {
  ListSignalsQueryParams,
  ListSignalsResponse,
  GetSignalStatsQueryParams,
  GetSignalStatsResponse,
  GetAiDecisionStatsQueryParams,
  GetAiDecisionStatsResponse,
} from "@workspace/api-zod";
import { generateSignals } from "../lib/analyzer/signals";
import { simulateLifecycle } from "../lib/analyzer/lifecycle";
import { computeTradeHealth } from "../lib/analyzer/trade-health";
import { fetchHistory } from "./history";
import { isOllamaAvailable } from "../lib/ai/ollama";
import { reflectOnTrade, reflectWithoutAi } from "../lib/ai/reflection";
import { rowToTradeEntry } from "./ai";
import { filterCandleWithAi } from "../lib/ai/filter";
import { runReplay } from "../lib/ai/replay";
import type { ReplayResult } from "../lib/ai/replay";
import { buildMarketContext, findSimilarHistoricalSetups } from "../lib/ai/market-context";
import { getNewsSentiment } from "../lib/ai/news";
import { checkOpenDecisions } from "../lib/ai/lifecycle-checker";
import { autoReflectResolved } from "../lib/ai/auto-reflect";
import type { OhlcvBar } from "../lib/analyzer/types";

// Find the bar index whose time equals (or is closest to) the signal's barTime.
// Signals carry epoch-seconds matching the bar grid, so an exact match is
// expected in almost every case.
function findBarIndex(bars: { time: number }[], targetSec: number): number {
  // Binary search assumes bars are time-sorted ascending.
  let lo = 0, hi = bars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time === targetSec) return mid;
    if (bars[mid].time < targetSec) lo = mid + 1; else hi = mid - 1;
  }
  // Fall back to nearest if no exact match
  return Math.max(0, Math.min(bars.length - 1, lo - 1));
}

const router: IRouter = Router();

// ── GET /signals ──────────────────────────────────────────────
router.get("/signals", async (req, res): Promise<void> => {
  const query = ListSignalsQueryParams.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: query.error.message }); return; }

  const { symbol, limit } = query.data;
  const timeframe = typeof req.query.timeframe === "string" && req.query.timeframe ? req.query.timeframe : "5m";

  let phase: string = "query_build";
  try {
    const conditions: SQL[] = [];
    if (symbol)    conditions.push(eq(signalsTable.symbol,    symbol));
    if (timeframe) conditions.push(eq(signalsTable.timeframe, timeframe));

    res.setHeader("Cache-Control", "no-store");
    const effectiveLimit = Math.min(limit ?? 3000, 5000);

    phase = "db_select";
    const base = db.select().from(signalsTable).orderBy(desc(signalsTable.barTime));
    const rows = await (
      conditions.length === 0 ? base :
      conditions.length === 1 ? base.where(conditions[0]) :
      base.where(and(...conditions))
    ).limit(effectiveLimit);

    let didSeed = false;
    if (rows.length === 0 && symbol) {
    try {
      phase = "seed_fetch_history";
      const rawBars = await fetchHistory(symbol, timeframe);
      const bars = rawBars as import("../lib/analyzer/types").OhlcvBar[];
      let htfBars: import("../lib/analyzer/types").OhlcvBar[] = [];
      if (timeframe === "5m") {
        try {
          const htf = await fetchHistory(symbol, "15m");
          htfBars = htf as import("../lib/analyzer/types").OhlcvBar[];
        } catch { /* HTF optional */ }
      }
      if (bars.length >= 50) {
        phase = "seed_generate_signals";
        const { signals } = generateSignals(bars, symbol, timeframe, htfBars);
        phase = "seed_insert";
        for (const sig of signals) {
          const entryIdx  = findBarIndex(bars, sig.barTime);
          const lifecycle = simulateLifecycle(bars, entryIdx, sig.side, sig.entryPrice, sig.slPrice, sig.tpPrice);
          try {
            await db.insert(signalsTable).values({
              signalId:       sig.id,
              symbol:         sig.symbol,
              timeframe:      sig.timeframe,
              barTime:        new Date(sig.barTime * 1000),
              side:           sig.side,
              entryPrice:     sig.entryPrice,
              slPrice:        sig.slPrice,
              tpPrice:        sig.tpPrice,
              currentSlPrice: sig.slPrice,
              confidence:     sig.confidence,
              riskTag:        sig.riskLevel,
              state:          lifecycle.state,
              exitPrice:      lifecycle.exitPrice ?? undefined,
              exitReason:     lifecycle.exitReason ?? undefined,
              exitBarTime:    lifecycle.exitBarTime ? new Date(lifecycle.exitBarTime * 1000) : undefined,
              rrRatio:        Math.round(Math.abs(sig.tpPrice - sig.entryPrice) / (Math.abs(sig.entryPrice - sig.slPrice) || 0.001) * 100) / 100,
              pattern:        sig.patterns[0] ?? "analysis_engine",
              regime:         sig.regime ?? "ranging",
              grade:          sig.grade,
              metadata:       (sig.metadata ?? null) as Record<string, unknown> | null,
            });
          } catch { /* duplicate — skip */ }
        }
        didSeed = true;
      }
    } catch (seedErr) {
      req.log?.warn(
        { err: seedErr, symbol, timeframe, phase },
        "signal seeding failed — returning empty result",
      );
    }
  }

    if (didSeed) {
      phase = "seed_reselect";
      const seeded = await (
        conditions.length === 0 ? db.select().from(signalsTable).orderBy(desc(signalsTable.createdAt)) :
        conditions.length === 1 ? db.select().from(signalsTable).where(conditions[0]).orderBy(desc(signalsTable.createdAt)) :
        db.select().from(signalsTable).where(and(...conditions)).orderBy(desc(signalsTable.createdAt))
      ).limit(effectiveLimit);
      phase = "seed_parse_response";
      res.json(ListSignalsResponse.parse(seeded));
      return;
    }

    phase = "parse_response";
    res.json(ListSignalsResponse.parse(rows));
  } catch (err) {
    req.log?.error(
      { err, stack: (err as Error).stack, symbol, timeframe, phase },
      `GET /signals failed during phase=${phase}`,
    );
    if (!res.headersSent) {
      res.status(500).json({
        error:   "Failed to load signals",
        message: (err as Error).message,
        phase,
        symbol,
        timeframe,
      });
    }
  }
});

// ── POST /signals/regenerate ──────────────────────────────────
// Wipes existing signals for symbol+timeframe and re-runs the analyzer
// across the full history. Use after engine changes to refresh stored rows.
router.post("/signals/regenerate", async (req, res): Promise<void> => {
  const symbol    = typeof req.query.symbol === "string" ? req.query.symbol : "";
  const timeframe = typeof req.query.timeframe === "string" && req.query.timeframe ? req.query.timeframe : "5m";
  if (!symbol) { res.status(400).json({ error: "symbol query param required" }); return; }

  try {
    await db.delete(signalsTable).where(and(
      eq(signalsTable.symbol,    symbol),
      eq(signalsTable.timeframe, timeframe),
    ));

    const rawBars = await fetchHistory(symbol, timeframe);
    const bars = rawBars as import("../lib/analyzer/types").OhlcvBar[];
    if (bars.length < 50) {
      res.json({ ok: true, symbol, timeframe, inserted: 0, reason: "not enough bars" });
      return;
    }

    let htfBars: import("../lib/analyzer/types").OhlcvBar[] = [];
    let dailyBars: import("../lib/analyzer/types").OhlcvBar[] = [];
    if (timeframe === "5m") {
      try {
        const htf = await fetchHistory(symbol, "15m");
        htfBars = htf as import("../lib/analyzer/types").OhlcvBar[];
      } catch { /* HTF optional */ }
      try {
        const daily = await fetchHistory(symbol, "1d");
        dailyBars = daily as import("../lib/analyzer/types").OhlcvBar[];
      } catch { /* daily optional — filter simply disabled if unavailable */ }
    }

    const { signals } = generateSignals(bars, symbol, timeframe, htfBars, dailyBars);
    let inserted = 0;
    let tpHits   = 0;
    let slHits   = 0;
    let expired  = 0;
    let active   = 0;
    for (const sig of signals) {
      const entryIdx  = findBarIndex(bars, sig.barTime);
      const lifecycle = simulateLifecycle(bars, entryIdx, sig.side, sig.entryPrice, sig.slPrice, sig.tpPrice);
      try {
        await db.insert(signalsTable).values({
          signalId:       sig.id,
          symbol:         sig.symbol,
          timeframe:      sig.timeframe,
          barTime:        new Date(sig.barTime * 1000),
          side:           sig.side,
          entryPrice:     sig.entryPrice,
          slPrice:        sig.slPrice,
          tpPrice:        sig.tpPrice,
          currentSlPrice: sig.slPrice,
          confidence:     sig.confidence,
          riskTag:        sig.riskLevel,
          state:          lifecycle.state,
          exitPrice:      lifecycle.exitPrice ?? undefined,
          exitReason:     lifecycle.exitReason ?? undefined,
          exitBarTime:    lifecycle.exitBarTime ? new Date(lifecycle.exitBarTime * 1000) : undefined,
          rrRatio:        Math.round(Math.abs(sig.tpPrice - sig.entryPrice) / (Math.abs(sig.entryPrice - sig.slPrice) || 0.001) * 100) / 100,
          pattern:        sig.patterns[0] ?? "analysis_engine",
          regime:         sig.regime ?? "ranging",
          grade:          sig.grade,
          metadata:       (sig.metadata ?? null) as Record<string, unknown> | null,
        });
        inserted++;
        if (lifecycle.state === "tp_hit")  tpHits++;
        else if (lifecycle.state === "sl_hit") slHits++;
        else if (lifecycle.state === "expired") expired++;
        else active++;
      } catch { /* duplicate — skip */ }
    }
    const closed = tpHits + slHits;
    res.json({
      ok: true, symbol, timeframe,
      bars: bars.length, htfBars: htfBars.length,
      inserted,
      backtest: {
        total: inserted, tp_hit: tpHits, sl_hit: slHits, expired, active,
        winRate: closed > 0 ? Math.round((tpHits / closed) * 1000) / 10 : null,
      },
    });
  } catch (err) {
    req.log?.warn({ err, symbol, timeframe }, "regenerate failed");
    res.status(500).json({ error: "regenerate failed" });
  }
});

// ── PATCH /signals/:signalId/state ────────────────────────────
// When a signal closes (tp_hit / sl_hit / expired), automatically
// triggers post-trade reflection and writes a lesson to the DB.
router.patch("/signals/:signalId/state", async (req, res): Promise<void> => {
  const { signalId } = req.params;
  const body = req.body as { state?: string; exitPrice?: number };
  const validStates = ["active", "tp_hit", "sl_hit", "expired"];
  const closedStates = ["tp_hit", "sl_hit", "expired"];

  if (!body.state || !validStates.includes(body.state)) {
    res.status(400).json({ error: `state must be one of: ${validStates.join(", ")}` });
    return;
  }

  const updateData: Record<string, unknown> = { state: body.state };
  if (body.exitPrice != null && isFinite(body.exitPrice)) {
    updateData.exitPrice   = body.exitPrice;
    updateData.exitBarTime = new Date();
    updateData.exitReason  = body.state === "tp_hit" ? "TP reached" : body.state === "sl_hit" ? "SL triggered" : "manual";
  }

  try {
    await db.update(signalsTable).set(updateData).where(eq(signalsTable.signalId, signalId));
    res.json({ ok: true, signalId, state: body.state });
  } catch (err) {
    req.log?.warn({ err, signalId }, "Failed to update signal state");
    res.status(500).json({ error: "Failed to update signal" });
    return;
  }

  // ── Auto post-trade reflection (fire-and-forget after response sent) ──
  if (closedStates.includes(body.state)) {
    setImmediate(async () => {
      try {
        const rows = await db
          .select()
          .from(signalsTable)
          .where(eq(signalsTable.signalId, signalId))
          .limit(1);
        if (rows.length === 0) return;

        const trade = rowToTradeEntry(rows[0]);

        const ollamaOk = await isOllamaAvailable();
        if (ollamaOk) {
          await reflectOnTrade(trade);
        } else {
          await reflectWithoutAi(trade);
        }
        // Logger available via module scope
      } catch {
        // Best-effort — errors must not affect the main response
      }
    });
  }
});

// ── POST /signals/candle-decision ────────────────────────────
// Called by the frontend after every candle close.
// Runs the full AI evaluation pipeline and stores the verdict in the DB.
// Rate-limit safe: bars are sourced from fetchHistory which has a 24 h
// disk+memory cache and stale-fallback on 429 — never breaks the chart.
const HTF_MAP: Record<string, string> = { "5m": "15m", "15m": "1h", "1h": "1d" };

// ── Replay job store (in-memory, one job per symbol-timeframe) ────────────────
interface ReplayJob {
  jobId:     string;
  symbol:    string;
  timeframe: string;
  status:    "running" | "done" | "error";
  progress:  number;
  total:     number;
  result?:   ReplayResult;
  error?:    string;
  startedAt: number;
}

const replayJobs       = new Map<string, ReplayJob>();
const activeJobByKey   = new Map<string, string>(); // "SYM-tf" → jobId
const TF_INTERVAL_SEC: Record<string, number> = { "5m": 300, "15m": 900, "1h": 3600, "1d": 86400 };

router.post("/signals/candle-decision", async (req, res): Promise<void> => {
  const { symbol, timeframe, candleTime } = req.body as {
    symbol?: unknown; timeframe?: unknown; candleTime?: unknown;
  };

  if (!symbol || typeof symbol !== "string" || symbol.length > 12) {
    res.status(400).json({ error: "symbol is required (≤12 chars)" }); return;
  }
  if (!timeframe || typeof timeframe !== "string") {
    res.status(400).json({ error: "timeframe is required" }); return;
  }
  if (!candleTime || typeof candleTime !== "number" || !isFinite(candleTime)) {
    res.status(400).json({ error: "candleTime (epoch seconds) is required" }); return;
  }

  // Guard: the candle must already be closed before we evaluate it
  const intervalSec = TF_INTERVAL_SEC[timeframe] ?? 300;
  const nowSec      = Math.floor(Date.now() / 1000);
  if (candleTime + intervalSec > nowSec) {
    res.status(400).json({ error: "Candle has not closed yet — wait for the bar to finish." }); return;
  }

  const sym = symbol.toUpperCase().trim();

  try {
    // ── 1. Fetch bars (uses 24 h cache; stale-fallback on 429) ────────────
    const [barsRaw, htfBarsRaw] = await Promise.all([
      fetchHistory(sym, timeframe),
      fetchHistory(sym, HTF_MAP[timeframe] ?? "15m"),
    ]);

    if (!Array.isArray(barsRaw) || barsRaw.length < 50) {
      res.status(422).json({ error: "Insufficient bars for analysis" }); return;
    }

    const bars    = barsRaw    as OhlcvBar[];
    const htfBars = htfBarsRaw as OhlcvBar[];

    // ── 2. Market Analysis Engine — compute full deterministic context ────
    const news = await getNewsSentiment(sym);
    const ctx  = buildMarketContext(bars, htfBars, HTF_MAP[timeframe] ?? "15m", sym, timeframe, candleTime, news);

    // ── 3. Historical similar setups (async DB query) ────────────────────
    const historicalStats = await findSimilarHistoricalSetups(
      sym, ctx.regime, ctx.indicators.rsi14, ctx.candlestickPatterns,
    );

    // ── 4. Ollama Trade Intelligence Engine — full decision ───────────────
    const decision = await filterCandleWithAi(ctx, historicalStats);

    // ── 5. Persist to DB (skip on duplicate) ────────────────────────────
    try {
      await db.insert(aiDecisionsTable).values({
        symbol:            sym,
        timeframe,
        candleTime:        new Date(candleTime * 1000),
        candidateSide:     decision.candidateSide,
        verdict:           decision.verdict,
        confidence:        decision.confidence,
        entryPrice:        decision.entryPrice,
        slPrice:           decision.slPrice,
        tpPrice:           decision.tpPrice,
        invalidationLevel: decision.invalidationLevel,
        rrRatio:           decision.rrRatio,
        technicalContext:  {
          ...decision.technicalContext,
          strengths:            decision.strengths,
          weaknesses:           decision.weaknesses,
          marketBias:           decision.marketBias,
          memoryUsed:           decision.memoryUsed,
          lessonsLoaded:        decision.lessonsLoaded,
          winnerAnalysisLoaded: decision.winnerAnalysisLoaded,
          failureStatsLoaded:   decision.failureStatsLoaded,
          recentLossLoaded:     decision.recentLossLoaded,
          memoryImpactScore:    decision.memoryImpactScore,
        },
        aiReasoning:       decision.aiReasoning,
        rejectionReason:   decision.rejectionReason,
        newsSummary:       decision.newsSummary,
        newsSentiment:     decision.newsSentiment,
        regime:            decision.regime,
        htfBias:           decision.htfBias,
        session:           decision.session,
        candidateScore:    decision.confidence,
        patterns:          decision.patterns,
      });
    } catch (dbErr) {
      // Duplicate candleTime — already processed, just return the decision
      req.log?.warn({ sym, timeframe, candleTime, dbErr }, "Duplicate candle decision — skipping insert");
    }

    req.log?.info(
      { sym, timeframe, candleTime, verdict: decision.verdict, confidence: decision.confidence },
      "Candle decision complete",
    );

    res.json(decision);

    // ── Fire-and-forget: lifecycle check + auto-reflect ───────────────────
    // Run after response is sent so it never delays the client.
    void (async () => {
      try {
        const latestBar = bars[bars.length - 1];

        // 1. Detect newly resolved open decisions
        const newlyResolved = await checkOpenDecisions(sym, timeframe, latestBar);

        // 2. Retry any previously-failed reflections (outcome set, reflected = false)
        const pendingRetry = await db
          .select()
          .from(aiDecisionsTable)
          .where(
            and(
              eq(aiDecisionsTable.symbol,    sym),
              eq(aiDecisionsTable.timeframe, timeframe),
              eq(aiDecisionsTable.verdict,   "APPROVE"),
              isNotNull(aiDecisionsTable.outcome),
              eq(aiDecisionsTable.reflected, false),
            ),
          );

        // Merge, deduplicate (newlyResolved rows are already in pendingRetry)
        const newIds = new Set(newlyResolved.map((r) => r.id));
        const toReflect = [
          ...newlyResolved,
          ...pendingRetry.filter((r) => !newIds.has(r.id)),
        ];

        await autoReflectResolved(toReflect, req.log);
      } catch (bgErr) {
        req.log?.warn({ bgErr, sym, timeframe }, "lifecycle/reflect background task failed");
      }
    })();
  } catch (err) {
    req.log?.error({ err, sym, timeframe, candleTime }, "candle-decision error");
    res.status(500).json({ error: "Internal error during candle decision" });
  }
});

// ── GET /signals/ai-active ────────────────────────────────────
// Returns the newest APPROVED AI candle-close decision for a symbol+timeframe.
router.get("/signals/ai-active", async (req, res): Promise<void> => {
  const symbol    = typeof req.query.symbol    === "string" ? req.query.symbol    : null;
  const timeframe = typeof req.query.timeframe === "string" ? req.query.timeframe : "5m";
  if (!symbol) { res.status(400).json({ error: "symbol query param required" }); return; }

  try {
    const rows = await db
      .select()
      .from(aiDecisionsTable)
      .where(and(
        eq(aiDecisionsTable.symbol,    symbol.toUpperCase().trim()),
        eq(aiDecisionsTable.timeframe, timeframe),
        eq(aiDecisionsTable.verdict,   "APPROVE"),
        isNull(aiDecisionsTable.outcome),
      ))
      .orderBy(desc(aiDecisionsTable.createdAt))
      .limit(1);

    if (rows.length === 0) {
      res.json({ ok: true, decision: null });
      return;
    }

    const row = rows[0];
    const tc = (row.technicalContext ?? {}) as Record<string, unknown>;
    res.json({
      ok: true,
      decision: {
        symbol:            row.symbol,
        timeframe:         row.timeframe,
        candleTime:        Math.floor(new Date(row.candleTime).getTime() / 1000),
        candidateSide:     row.candidateSide ?? "no_trade",
        verdict:           row.verdict,
        confidence:        row.confidence,
        entryPrice:        row.entryPrice,
        slPrice:           row.slPrice,
        tpPrice:           row.tpPrice,
        invalidationLevel: row.invalidationLevel,
        rrRatio:           row.rrRatio,
        aiReasoning:       row.aiReasoning ?? "",
        rejectionReason:   row.rejectionReason ?? null,
        newsSentiment:     (row.newsSentiment ?? "neutral") as "bullish" | "bearish" | "neutral",
        newsSummary:       row.newsSummary ?? "",
        regime:            row.regime ?? "",
        htfBias:           row.htfBias ?? "",
        session:           row.session ?? "",
        patterns:          row.patterns,
        strengths:         Array.isArray(tc.strengths)  ? (tc.strengths  as string[]) : [],
        weaknesses:        Array.isArray(tc.weaknesses) ? (tc.weaknesses as string[]) : [],
        marketBias:        (typeof tc.marketBias === "string" ? tc.marketBias : "neutral") as "bullish" | "bearish" | "neutral",
        technicalContext:  tc,
      },
    });
  } catch (err) {
    req.log?.error({ err, symbol, timeframe }, "ai-active lookup failed");
    res.status(500).json({ error: "Failed to fetch active AI decision" });
  }
});

// ── GET /signals/ai-active/health ─────────────────────────────
// Computes a 0-100 health score for the current open approved AI trade
// across 6 dimensions: EMA trend, RSI momentum, volume, price progress,
// pattern integrity, and memory alignment.
// Returns { ok, health: null } when no active trade exists.
router.get("/signals/ai-active/health", async (req, res): Promise<void> => {
  const symbol    = typeof req.query.symbol    === "string" ? req.query.symbol    : null;
  const timeframe = typeof req.query.timeframe === "string" ? req.query.timeframe : "5m";
  if (!symbol) { res.status(400).json({ error: "symbol query param required" }); return; }

  try {
    const rows = await db
      .select()
      .from(aiDecisionsTable)
      .where(and(
        eq(aiDecisionsTable.symbol,    symbol.toUpperCase().trim()),
        eq(aiDecisionsTable.timeframe, timeframe),
        eq(aiDecisionsTable.verdict,   "APPROVE"),
        isNull(aiDecisionsTable.outcome),
      ))
      .orderBy(desc(aiDecisionsTable.createdAt))
      .limit(1);

    if (rows.length === 0) {
      res.json({ ok: true, health: null });
      return;
    }

    const row = rows[0];
    const tc  = (row.technicalContext ?? {}) as Record<string, unknown>;
    const memoryImpactScore = typeof tc.memoryImpactScore === "number" ? tc.memoryImpactScore : undefined;

    const barsRaw = await fetchHistory(symbol.toUpperCase().trim(), timeframe);
    const bars    = barsRaw as OhlcvBar[];

    const health = computeTradeHealth(bars, {
      side:              (row.candidateSide ?? "long") as "long" | "short",
      entryPrice:        row.entryPrice ?? 0,
      slPrice:           row.slPrice   ?? 0,
      tpPrice:           row.tpPrice   ?? 0,
      confidence:        row.confidence,
      regime:            row.regime    ?? "ranging",
      patterns:          row.patterns,
      memoryImpactScore,
    });

    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, health });
  } catch (err) {
    req.log?.error({ err, symbol, timeframe }, "ai-active/health failed");
    res.status(500).json({ error: "Failed to compute trade health" });
  }
});

// ── PATCH /signals/ai-active/resolve ──────────────────────────
// Resolves all pending (no outcome) APPROVED AI decisions for a symbol+timeframe
// with the given outcome (tp_hit | sl_hit). Called by the frontend when a live
// price tick touches TP or SL. Fires auto-reflection fire-and-forget.
router.patch("/signals/ai-active/resolve", async (req, res): Promise<void> => {
  const { symbol, timeframe, outcome, outcomePrice } = req.body as {
    symbol?: string; timeframe?: string;
    outcome?: string; outcomePrice?: number;
  };
  if (!symbol || !timeframe || !outcome || outcomePrice == null) {
    res.status(400).json({ error: "symbol, timeframe, outcome, outcomePrice required" });
    return;
  }
  if (outcome !== "tp_hit" && outcome !== "sl_hit") {
    res.status(400).json({ error: "outcome must be tp_hit or sl_hit" });
    return;
  }

  try {
    const rows = await db
      .select()
      .from(aiDecisionsTable)
      .where(and(
        eq(aiDecisionsTable.symbol,    symbol.toUpperCase().trim()),
        eq(aiDecisionsTable.timeframe, timeframe),
        eq(aiDecisionsTable.verdict,   "APPROVE"),
        isNull(aiDecisionsTable.outcome),
      ));

    if (rows.length === 0) {
      res.json({ ok: true, resolved: 0 });
      return;
    }

    const resolvedAt = new Date();
    for (const row of rows) {
      await db
        .update(aiDecisionsTable)
        .set({ outcome: outcome as "tp_hit" | "sl_hit", outcomePrice, resolvedAt })
        .where(eq(aiDecisionsTable.id, row.id));
    }

    const resolvedRows = rows.map(r => ({
      ...r, outcome: outcome as "tp_hit" | "sl_hit", outcomePrice, resolvedAt, reflected: false,
    }));
    // Fire reflection asynchronously — never block the HTTP response
    autoReflectResolved(resolvedRows, req.log).catch(() => {});

    req.log?.info({ symbol, timeframe, outcome, count: rows.length }, "AI decisions resolved via live tick");
    res.json({ ok: true, resolved: rows.length });
  } catch (err) {
    req.log?.error({ err }, "ai-active/resolve failed");
    res.status(500).json({ error: "Failed to resolve AI decision" });
  }
});

// ── GET /signals/ai-decisions-history ─────────────────────────
// Returns resolved (outcome IS NOT NULL) APPROVED AI decisions for a symbol+timeframe.
// Used by the chart to render outcome markers (tp_hit=green, sl_hit=red, expired=gray).
router.get("/signals/ai-decisions-history", async (req, res): Promise<void> => {
  const symbol    = typeof req.query.symbol    === "string" ? req.query.symbol    : null;
  const timeframe = typeof req.query.timeframe === "string" ? req.query.timeframe : "5m";
  if (!symbol) { res.status(400).json({ error: "symbol query param required" }); return; }

  try {
    const rows = await db
      .select({
        candleTime:    aiDecisionsTable.candleTime,
        candidateSide: aiDecisionsTable.candidateSide,
        outcome:       aiDecisionsTable.outcome,
        confidence:    aiDecisionsTable.confidence,
      })
      .from(aiDecisionsTable)
      .where(and(
        eq(aiDecisionsTable.symbol,    symbol.toUpperCase().trim()),
        eq(aiDecisionsTable.timeframe, timeframe),
        eq(aiDecisionsTable.verdict,   "APPROVE"),
        isNotNull(aiDecisionsTable.outcome),
      ))
      .orderBy(desc(aiDecisionsTable.candleTime))
      .limit(200);

    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      decisions: rows.map((r) => ({
        candleTime:    Math.floor(new Date(r.candleTime).getTime() / 1000),
        candidateSide: r.candidateSide ?? "no_trade",
        outcome:       r.outcome,
        confidence:    r.confidence,
      })),
    });
  } catch (err) {
    req.log?.error({ err, symbol, timeframe }, "ai-decisions-history lookup failed");
    res.status(500).json({ error: "Failed to fetch AI decision history" });
  }
});

// ── GET /signals/ai-recent-decisions ─────────────────────────
// Returns the last N decisions (all verdicts) with memory diagnostics extracted
// from technicalContext. Used by the AI Engine per-decision diagnostics UI.
router.get("/signals/ai-recent-decisions", async (req, res): Promise<void> => {
  const symbol    = typeof req.query.symbol    === "string" ? req.query.symbol    : null;
  const timeframe = typeof req.query.timeframe === "string" ? req.query.timeframe : null;
  const limit     = Math.min(Number(req.query.limit) || 15, 50);

  try {
    const conditions: SQL[] = [];
    if (symbol)    conditions.push(eq(aiDecisionsTable.symbol,    symbol.toUpperCase().trim()));
    if (timeframe) conditions.push(eq(aiDecisionsTable.timeframe, timeframe));

    const base = db.select({
      candleTime:       aiDecisionsTable.candleTime,
      candidateSide:    aiDecisionsTable.candidateSide,
      verdict:          aiDecisionsTable.verdict,
      confidence:       aiDecisionsTable.confidence,
      regime:           aiDecisionsTable.regime,
      technicalContext: aiDecisionsTable.technicalContext,
    }).from(aiDecisionsTable);

    const rows = await (
      conditions.length === 0 ? base :
      conditions.length === 1 ? base.where(conditions[0]!) :
      base.where(and(...conditions))
    ).orderBy(desc(aiDecisionsTable.candleTime)).limit(limit);

    res.json({
      ok: true,
      decisions: rows.map(r => {
        const tc = (r.technicalContext ?? {}) as Record<string, unknown>;
        return {
          candleTime:           Math.floor(new Date(r.candleTime).getTime() / 1000),
          candidateSide:        r.candidateSide ?? "no_trade",
          verdict:              r.verdict,
          confidence:           r.confidence,
          regime:               r.regime ?? "",
          memoryUsed:           tc.memoryUsed           as boolean | undefined,
          lessonsLoaded:        tc.lessonsLoaded         as number  | undefined,
          winnerAnalysisLoaded: tc.winnerAnalysisLoaded  as boolean | undefined,
          failureStatsLoaded:   tc.failureStatsLoaded    as boolean | undefined,
          recentLossLoaded:     tc.recentLossLoaded      as boolean | undefined,
          memoryImpactScore:    tc.memoryImpactScore     as number  | undefined,
        };
      }),
    });
  } catch (err) {
    req.log?.error({ err }, "ai-recent-decisions lookup failed");
    res.status(500).json({ error: "Failed to fetch recent AI decisions" });
  }
});

// ── GET /signals/ai-decision-stats ───────────────────────────
router.get("/signals/ai-decision-stats", async (req, res): Promise<void> => {
  const query = GetAiDecisionStatsQueryParams.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: query.error.message }); return; }

  const { symbol, timeframe } = query.data;

  try {
    const conditions: import("drizzle-orm").SQL[] = [];
    if (symbol)    conditions.push(eq(aiDecisionsTable.symbol,    symbol));
    if (timeframe) conditions.push(eq(aiDecisionsTable.timeframe, timeframe));

    const base = db.select().from(aiDecisionsTable);
    const rows = await (
      conditions.length === 0 ? base :
      conditions.length === 1 ? base.where(conditions[0]) :
      base.where(and(...conditions))
    );

    const total    = rows.length;
    const resolved = rows.filter(r => r.outcome != null);
    const tp_hit   = resolved.filter(r => r.outcome === "tp_hit").length;
    const sl_hit   = resolved.filter(r => r.outcome === "sl_hit").length;
    const expired  = resolved.filter(r => r.outcome === "expired").length;
    const closed   = tp_hit + sl_hit;
    const winRate  = closed > 0 ? tp_hit / closed : 0;
    const rrs      = resolved.filter(r => r.rrRatio != null).map(r => r.rrRatio!);
    const avgRR    = rrs.length > 0 ? rrs.reduce((s, v) => s + v, 0) / rrs.length : 0;

    // Breakdown by regime
    type RegimeStat = { tp_hit: number; sl_hit: number; expired: number; total: number; winRate: number };
    const byRegime: Record<string, RegimeStat> = {};
    for (const r of resolved) {
      const regime = r.regime ?? "unknown";
      if (!byRegime[regime]) byRegime[regime] = { tp_hit: 0, sl_hit: 0, expired: 0, total: 0, winRate: 0 };
      const s = byRegime[regime];
      s.total++;
      if (r.outcome === "tp_hit")  s.tp_hit++;
      else if (r.outcome === "sl_hit")  s.sl_hit++;
      else if (r.outcome === "expired") s.expired++;
    }
    for (const s of Object.values(byRegime)) {
      const c = s.tp_hit + s.sl_hit;
      s.winRate = c > 0 ? Math.round((s.tp_hit / c) * 100) / 100 : 0;
    }

    res.setHeader("Cache-Control", "no-store");
    res.json(GetAiDecisionStatsResponse.parse({
      total,
      resolved: resolved.length,
      tp_hit,
      sl_hit,
      expired,
      winRate:  Math.round(winRate * 100) / 100,
      avgRR:    Math.round(avgRR * 100) / 100,
      byRegime,
    }));
  } catch (err) {
    req.log?.error({ err, symbol, timeframe }, "ai-decision-stats failed");
    res.status(500).json({ error: "Failed to compute AI decision stats" });
  }
});

// ── GET /signals/stats ────────────────────────────────────────
router.get("/signals/stats", async (req, res): Promise<void> => {
  const query = GetSignalStatsQueryParams.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: query.error.message }); return; }

  const { symbol } = query.data;
  const base = db.select().from(signalsTable);
  const rows = symbol ? await base.where(eq(signalsTable.symbol, symbol)) : await base;

  const total   = rows.length;
  const active  = rows.filter((r) => r.state === "active").length;
  const tp_hit  = rows.filter((r) => r.state === "tp_hit").length;
  const sl_hit  = rows.filter((r) => r.state === "sl_hit").length;
  const expired = rows.filter((r) => r.state === "expired").length;
  const closed  = tp_hit + sl_hit;
  const winRate = closed > 0 ? tp_hit / closed : 0;
  const avgConf = total > 0 ? rows.reduce((s, r) => s + r.confidence, 0) / total : 0;
  const rrs     = rows.filter((r) => r.rrRatio != null).map((r) => r.rrRatio!);
  const avgRR   = rrs.length > 0 ? rrs.reduce((s, v) => s + v, 0) / rrs.length : 0;

  res.json(GetSignalStatsResponse.parse({
    total, active, tp_hit, sl_hit, expired,
    winRate:       Math.round(winRate * 100) / 100,
    avgConfidence: Math.round(avgConf * 10) / 10,
    avgRR:         Math.round(avgRR * 100) / 100,
  }));
});

// ── GET /signals/alerts ───────────────────────────────────────
// Returns recent AI candle decisions (LONG or SHORT) above a confidence
// threshold for a comma-separated list of symbols, since a given Unix-ms
// timestamp. Used by the frontend real-time signal alert system.
router.get("/signals/alerts", async (req, res): Promise<void> => {
  const sinceMs  = req.query.since           ? Number(req.query.since)           : Date.now() - 60 * 60_000;
  const minConf  = req.query.minConfidence   ? Number(req.query.minConfidence)   : 70;
  const symbols  = req.query.symbols
    ? String(req.query.symbols).split(",").map(s => s.trim().toUpperCase()).filter(Boolean)
    : [];

  const since = new Date(sinceMs);

  const conditions: SQL[] = [
    inArray(aiDecisionsTable.verdict, ["LONG", "SHORT"]),
    gte(aiDecisionsTable.confidence, minConf),
    gte(aiDecisionsTable.createdAt, since),
  ];
  if (symbols.length > 0) conditions.push(inArray(aiDecisionsTable.symbol, symbols));

  const rows = await db
    .select({
      id:         aiDecisionsTable.id,
      symbol:     aiDecisionsTable.symbol,
      timeframe:  aiDecisionsTable.timeframe,
      verdict:    aiDecisionsTable.verdict,
      confidence: aiDecisionsTable.confidence,
      entryPrice: aiDecisionsTable.entryPrice,
      rrRatio:    aiDecisionsTable.rrRatio,
      regime:     aiDecisionsTable.regime,
      candleTime: aiDecisionsTable.candleTime,
      createdAt:  aiDecisionsTable.createdAt,
    })
    .from(aiDecisionsTable)
    .where(and(...conditions))
    .orderBy(desc(aiDecisionsTable.createdAt))
    .limit(20);

  res.json(rows.map(r => ({
    ...r,
    candleTime: r.candleTime.toISOString(),
    createdAt:  r.createdAt.toISOString(),
  })));
});

// ── POST /signals/replay ──────────────────────────────────────
// Starts an async memory-vs-no-memory replay job for a symbol+timeframe.
// Returns immediately with { jobId }. Poll GET /signals/replay/:jobId for status.
// Only one active job per symbol-timeframe at a time.
router.post("/signals/replay", async (req, res): Promise<void> => {
  const { symbol, timeframe = "5m", limit = 50 } = req.body as {
    symbol?: string; timeframe?: string; limit?: number;
  };
  if (!symbol || typeof symbol !== "string") {
    res.status(400).json({ error: "symbol required" });
    return;
  }

  const sym = symbol.toUpperCase().trim();
  const tf  = String(timeframe);
  const lim = Math.max(5, Math.min(200, typeof limit === "number" ? Math.round(limit) : 50));
  const key = `${sym}-${tf}`;

  // Return existing running job
  const existingId = activeJobByKey.get(key);
  if (existingId) {
    const existing = replayJobs.get(existingId);
    if (existing?.status === "running") {
      res.json({ jobId: existingId, alreadyRunning: true });
      return;
    }
  }

  const jobId = `${sym}-${tf}-${Date.now()}`;
  const job: ReplayJob = {
    jobId, symbol: sym, timeframe: tf,
    status: "running", progress: 0, total: lim, startedAt: Date.now(),
  };
  replayJobs.set(jobId, job);
  activeJobByKey.set(key, jobId);

  // Evict oldest jobs if store grows beyond 30 entries
  if (replayJobs.size > 30) {
    const oldest = [...replayJobs.entries()]
      .sort((a, b) => a[1].startedAt - b[1].startedAt)[0];
    if (oldest) replayJobs.delete(oldest[0]);
  }

  // Respond immediately so the client can start polling
  res.json({ jobId });

  void (async () => {
    try {
      const htfTf = HTF_MAP[tf] ?? "15m";
      const [barsRaw, htfBarsRaw] = await Promise.all([
        fetchHistory(sym, tf),
        fetchHistory(sym, htfTf),
      ]);
      const bars    = barsRaw    as OhlcvBar[];
      const htfBars = htfBarsRaw as OhlcvBar[];

      if (bars.length < 110) {
        job.status = "error";
        job.error  = `Insufficient bars (${bars.length} < 110) — fetch more history first`;
        return;
      }

      const result = await runReplay(
        bars, htfBars, htfTf, sym, tf, lim,
        (done, total) => { job.progress = done; job.total = total; },
      );

      job.result   = result;
      job.status   = "done";
      job.progress = result.processed;
    } catch (err) {
      job.status = "error";
      job.error  = (err instanceof Error) ? err.message : String(err);
    }
  })();
});

// ── GET /signals/replay/:jobId ────────────────────────────────
router.get("/signals/replay/:jobId", (req, res): void => {
  const { jobId } = req.params;
  const job = replayJobs.get(jobId);
  if (!job) {
    res.status(404).json({ error: "Replay job not found" });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.json({
    jobId:    job.jobId,
    status:   job.status,
    progress: job.progress,
    total:    job.total,
    result:   job.result ?? null,
    error:    job.error ?? null,
  });
});

export default router;
