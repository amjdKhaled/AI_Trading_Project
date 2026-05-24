import { Router, type IRouter } from "express";
import { ListBarsQueryParams, ListBarsResponse } from "@workspace/api-zod";
import { buildSeedBars } from "../lib/finnhub";
import { getBarHistory } from "../lib/websocket";

const router: IRouter = Router();

router.get("/bars", async (req, res): Promise<void> => {
  const query = ListBarsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const { symbol, limit } = query.data;
  const count = limit ?? 200;

  // Prefer in-memory live bars (built from Finnhub WebSocket ticks)
  const liveHistory = getBarHistory(symbol);
  if (liveHistory.length >= 10) {
    res.json(ListBarsResponse.parse(liveHistory.slice(-count)));
    return;
  }

  // Fall back to seed bars built from the current quote
  try {
    const bars = await buildSeedBars(symbol, count);
    if (bars.length > 0) {
      res.json(ListBarsResponse.parse(bars));
      return;
    }
    // Quote also failed (symbol unknown or market fully closed)
    res.json(ListBarsResponse.parse([]));
  } catch (err) {
    req.log?.warn({ err }, "Failed to build seed bars");
    res.status(502).json({ error: "Failed to fetch candle data" });
  }
});

export default router;
