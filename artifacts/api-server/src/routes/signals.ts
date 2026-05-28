import { Router, type IRouter } from "express";
import { eq, desc, and, type SQL } from "drizzle-orm";
import { db, signalsTable } from "@workspace/db";
import {
  ListSignalsQueryParams,
  ListSignalsResponse,
  GetSignalStatsQueryParams,
  GetSignalStatsResponse,
} from "@workspace/api-zod";
import { generateSignals } from "../lib/analyzer/signals";
import { simulateLifecycle } from "../lib/analyzer/lifecycle";
import { fetchHistory } from "./history";
import { isOllamaAvailable } from "../lib/ai/ollama";
import { reflectOnTrade, reflectWithoutAi } from "../lib/ai/reflection";
import { rowToTradeEntry } from "./ai";

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

export default router;
