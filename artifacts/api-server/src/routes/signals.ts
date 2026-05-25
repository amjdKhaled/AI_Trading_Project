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
import { fetchHistory } from "./history";

const router: IRouter = Router();

// ── GET /signals ──────────────────────────────────────────────
router.get("/signals", async (req, res): Promise<void> => {
  const query = ListSignalsQueryParams.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: query.error.message }); return; }

  const { symbol, limit } = query.data;
  const timeframe = typeof req.query.timeframe === "string" && req.query.timeframe ? req.query.timeframe : "5m";

  const conditions: SQL[] = [];
  if (symbol)    conditions.push(eq(signalsTable.symbol,    symbol));
  if (timeframe) conditions.push(eq(signalsTable.timeframe, timeframe));

  const base = db.select().from(signalsTable).orderBy(desc(signalsTable.createdAt));
  const rows = await (
    conditions.length === 0 ? base :
    conditions.length === 1 ? base.where(conditions[0]) :
    base.where(and(...conditions))
  ).limit(limit ?? 50);

  // Seed once if empty for this symbol+timeframe
  if (rows.length === 0 && symbol) {
    try {
      const rawBars = await fetchHistory(symbol, timeframe);
      const bars = rawBars as import("../lib/analyzer/types").OhlcvBar[];
      if (bars.length >= 50) {
        const { signals } = generateSignals(bars, symbol, timeframe);
        for (const sig of signals) {
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
              state:          "active",
              rrRatio:        Math.round(Math.abs(sig.tpPrice - sig.entryPrice) / (Math.abs(sig.entryPrice - sig.slPrice) || 0.001) * 100) / 100,
              pattern:        sig.patterns[0] ?? "analysis_engine",
              regime:         "trend_up",
            });
          } catch { /* duplicate — skip */ }
        }
        const seeded = await (
          conditions.length === 0 ? db.select().from(signalsTable).orderBy(desc(signalsTable.createdAt)) :
          conditions.length === 1 ? db.select().from(signalsTable).where(conditions[0]).orderBy(desc(signalsTable.createdAt)) :
          db.select().from(signalsTable).where(and(...conditions)).orderBy(desc(signalsTable.createdAt))
        ).limit(limit ?? 50);
        res.json(ListSignalsResponse.parse(seeded));
        return;
      }
    } catch { /* history unavailable */ }
  }

  res.json(ListSignalsResponse.parse(rows));
});

// ── PATCH /signals/:signalId/state ────────────────────────────
router.patch("/signals/:signalId/state", async (req, res): Promise<void> => {
  const { signalId } = req.params;
  const body = req.body as { state?: string; exitPrice?: number };
  const validStates = ["active", "tp_hit", "sl_hit", "expired"];

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
