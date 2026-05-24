import { Router, type IRouter } from "express";
import { ListBarsQueryParams, ListBarsResponse } from "@workspace/api-zod";

const router: IRouter = Router();

// Simulated bar generator — produces realistic 5m NASDAQ-style candles
function generateBars(
  symbol: string,
  count: number
): { time: number; open: number; high: number; low: number; close: number; volume: number }[] {
  const seed = symbol.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const basePrice: Record<string, number> = {
    "NVDA": 1048,
    "AAPL": 195,
    "AMD": 168,
    "MSFT": 430,
    "TSLA": 285,
    "AMZN": 196,
    "META": 590,
    "QQQ": 488,
  };
  let price = basePrice[symbol] ?? 100 + (seed % 400);

  const now = Math.floor(Date.now() / 1000);
  const intervalSec = 5 * 60;
  const bars = [];

  for (let i = count - 1; i >= 0; i--) {
    const time = now - i * intervalSec;
    const move = (Math.random() - 0.485) * price * 0.006;
    const open = price;
    const close = Math.max(price + move, price * 0.97);
    const high = Math.max(open, close) * (1 + Math.random() * 0.003);
    const low = Math.min(open, close) * (1 - Math.random() * 0.003);
    const volume = Math.floor(100000 + Math.random() * 900000);
    bars.push({
      time,
      open: Math.round(open * 100) / 100,
      high: Math.round(high * 100) / 100,
      low: Math.round(low * 100) / 100,
      close: Math.round(close * 100) / 100,
      volume,
    });
    price = close;
  }
  return bars;
}

router.get("/bars", async (req, res): Promise<void> => {
  const query = ListBarsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const { symbol, limit } = query.data;
  const bars = generateBars(symbol, limit ?? 200);
  res.json(ListBarsResponse.parse(bars));
});

export default router;
