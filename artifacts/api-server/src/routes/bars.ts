import { Router, type IRouter } from "express";
import { ListBarsQueryParams, ListBarsResponse } from "@workspace/api-zod";
import { fetchCandles } from "../lib/finnhub";

const router: IRouter = Router();

router.get("/bars", async (req, res): Promise<void> => {
  const query = ListBarsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const { symbol, limit } = query.data;
  const count = limit ?? 200;

  try {
    const to = Math.floor(Date.now() / 1000);
    // fetch enough history: 5m bars × count, plus weekend gaps → request 10 trading days
    const from = to - 10 * 24 * 60 * 60;
    const bars = await fetchCandles(symbol, from, to);

    if (bars.length === 0) {
      // Finnhub returned no data (market closed / bad symbol) — return empty
      res.json(ListBarsResponse.parse([]));
      return;
    }

    const trimmed = bars.slice(-count);
    res.json(ListBarsResponse.parse(trimmed));
  } catch (err) {
    req.log?.warn({ err }, "Failed to fetch candles from Finnhub");
    res.status(502).json({ error: "Failed to fetch candle data" });
  }
});

export default router;
