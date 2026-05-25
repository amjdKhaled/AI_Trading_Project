import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
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

router.get("/signals", async (req, res): Promise<void> => {
  const query = ListSignalsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const { symbol, limit } = query.data;

  // On-demand: run the real analysis engine to generate fresh signals
  if (symbol) {
    try {
      const rawBars = await fetchHistory(symbol, "1d");
      const bars = rawBars as import("../lib/analyzer/types").OhlcvBar[];
      if (bars.length >= 50) {
        const { signals } = generateSignals(bars, symbol, "1d");
        // Persist only A+/A grade signals that don't already exist
        for (const sig of signals) {
          try {
            await db.insert(signalsTable).values({
              signalId: sig.id,
              symbol: sig.symbol,
              timeframe: sig.timeframe,
              barTime: new Date(sig.barTime * 1000),
              side: sig.side,
              entryPrice: sig.entryPrice,
              slPrice: sig.slPrice,
              tpPrice: sig.tpPrice,
              currentSlPrice: sig.slPrice,
              confidence: sig.confidence,
              riskTag: sig.riskLevel,
              state: "active",
              rrRatio: Math.round(Math.abs(sig.tpPrice - sig.entryPrice) / Math.abs(sig.entryPrice - sig.slPrice || 0.001) * 100) / 100,
              pattern: sig.patterns[0] ?? "analysis_engine",
              regime: "trend_up",
            });
          } catch {
            // Duplicate key — ignore
          }
        }
      }
    } catch {
      // History unavailable — fall back to DB only
    }
  }

  let q = db.select().from(signalsTable).orderBy(desc(signalsTable.createdAt));
  if (symbol) {
    q = q.where(eq(signalsTable.symbol, symbol)) as typeof q;
  }
  const rows = await q.limit(limit ?? 50);
  res.json(ListSignalsResponse.parse(rows));
});

router.get("/signals/stats", async (req, res): Promise<void> => {
  const query = GetSignalStatsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const { symbol } = query.data;
  let q = db.select().from(signalsTable);
  if (symbol) {
    q = q.where(eq(signalsTable.symbol, symbol)) as typeof q;
  }
  const rows = await q;

  const total = rows.length;
  const active = rows.filter((r) => r.state === "active").length;
  const tp_hit = rows.filter((r) => r.state === "tp_hit").length;
  const sl_hit = rows.filter((r) => r.state === "sl_hit").length;
  const expired = rows.filter((r) => r.state === "expired").length;
  const closed = tp_hit + sl_hit;
  const winRate = closed > 0 ? tp_hit / closed : 0;
  const avgConfidence =
    total > 0 ? rows.reduce((s, r) => s + r.confidence, 0) / total : 0;
  const rrs = rows.filter((r) => r.rrRatio != null).map((r) => r.rrRatio!);
  const avgRR = rrs.length > 0 ? rrs.reduce((s, v) => s + v, 0) / rrs.length : 0;

  res.json(
    GetSignalStatsResponse.parse({
      total,
      active,
      tp_hit,
      sl_hit,
      expired,
      winRate: Math.round(winRate * 100) / 100,
      avgConfidence: Math.round(avgConfidence * 10) / 10,
      avgRR: Math.round(avgRR * 100) / 100,
    })
  );
});

export default router;
