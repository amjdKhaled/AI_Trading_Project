import { Router, type IRouter } from "express";
import { fetchPolygonBars, fetchPolygonSnapshot } from "../lib/polygon.js";
import { getWsStatus } from "../lib/websocket.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

router.get("/diagnostics", async (req, res): Promise<void> => {
  const symbol   = String(req.query.symbol   ?? "").toUpperCase().trim();
  const interval = String(req.query.interval ?? "5m").trim();

  if (!symbol || symbol.length > 12) {
    res.status(400).json({ error: "symbol is required and must be ≤12 chars" });
    return;
  }

  const fetchedAt = new Date().toISOString();

  const [snapResult, barsResult] = await Promise.allSettled([
    fetchPolygonSnapshot(symbol),
    fetchPolygonBars(symbol, interval, 3), // 3 days → plenty for last 5 completed bars
  ]);

  if (snapResult.status === "rejected") {
    logger.warn({ symbol, err: (snapResult.reason as Error).message }, "diagnostics snapshot failed");
  }
  if (barsResult.status === "rejected") {
    logger.warn({ symbol, interval, err: (barsResult.reason as Error).message }, "diagnostics bars failed");
  }

  const snapshot   = snapResult.status   === "fulfilled" ? snapResult.value  : null;
  const latestBars = barsResult.status   === "fulfilled"
    ? barsResult.value.slice(-5)
    : [];

  req.log?.info({ symbol, interval, bars: latestBars.length }, "diagnostics served");

  res.json({
    symbol,
    interval,
    fetchedAt,
    snapshot,
    latestBars,
    websocket: getWsStatus(),
  });
});

export default router;
