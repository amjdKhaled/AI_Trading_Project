import { Router, type IRouter } from "express";
import { ListBarsQueryParams, ListBarsResponse } from "@workspace/api-zod";

const router: IRouter = Router();

const TIMEFRAME_SECONDS: Record<string, number> = {
  "5m":  5 * 60,
  "15m": 15 * 60,
  "30m": 30 * 60,
  "1h":  60 * 60,
  "4h":  4 * 60 * 60,
  "1d":  24 * 60 * 60,
  "1w":  7 * 24 * 60 * 60,
  "1M":  30 * 24 * 60 * 60,
};

// Default bar counts per timeframe — gives a full "all-time" history view
const DEFAULT_LIMIT: Record<string, number> = {
  "5m":  390,    // ~1 trading day (6.5h × 12 bars)
  "15m": 672,    // ~7 days
  "30m": 504,    // ~10 days
  "1h":  720,    // ~30 days
  "4h":  730,    // ~1 year
  "1d":  1000,   // ~4 years
  "1w":  260,    // ~5 years
  "1M":  120,    // ~10 years
};

const BASE_PRICE: Record<string, number> = {
  "NVDA": 1048,
  "AAPL": 195,
  "AMD":  168,
  "MSFT": 430,
  "TSLA": 285,
  "AMZN": 196,
  "META": 590,
  "QQQ":  488,
};

// Deterministic seeded PRNG so history is stable across reloads
function seededRand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = Math.imul(s, 1664525) + 1013904223;
    return (s >>> 0) / 0x100000000;
  };
}

function generateBars(
  symbol: string,
  timeframe: string,
  count: number
): { time: number; open: number; high: number; low: number; close: number; volume: number }[] {
  const intervalSec = TIMEFRAME_SECONDS[timeframe] ?? TIMEFRAME_SECONDS["5m"];
  const symbolSeed = symbol.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const rand = seededRand(symbolSeed * 31337 + intervalSec);

  // Volatility scales with timeframe length (longer bars = bigger moves per bar)
  const volMult = Math.sqrt(intervalSec / TIMEFRAME_SECONDS["5m"]);
  const baseVol = 0.005 * volMult;

  let price = BASE_PRICE[symbol] ?? 100 + (symbolSeed % 400);

  // Align start to a clean timeframe boundary
  const now = Math.floor(Date.now() / 1000);
  const alignedNow = now - (now % intervalSec);

  const bars = [];
  for (let i = count - 1; i >= 0; i--) {
    const time = alignedNow - i * intervalSec;
    const move = (rand() - 0.489) * price * baseVol;
    const open  = price;
    const close = Math.max(price + move, price * 0.88);
    const wick  = rand() * 0.004 * volMult;
    const high  = Math.max(open, close) * (1 + wick);
    const low   = Math.min(open, close) * (1 - wick);
    const volume = Math.floor(500_000 + rand() * 4_500_000);

    bars.push({
      time,
      open:   Math.round(open  * 100) / 100,
      high:   Math.round(high  * 100) / 100,
      low:    Math.round(low   * 100) / 100,
      close:  Math.round(close * 100) / 100,
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
  const { symbol, timeframe, limit } = query.data;
  const tf    = timeframe ?? "5m";
  const count = limit ?? DEFAULT_LIMIT[tf] ?? 200;
  const bars  = generateBars(symbol, tf, count);
  res.json(ListBarsResponse.parse(bars));
});

export default router;
