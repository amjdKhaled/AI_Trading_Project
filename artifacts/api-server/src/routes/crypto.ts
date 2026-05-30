// ── Crypto market data — Binance Spot API proxy ────────────────────────────
//
// GET /api/crypto/symbols  — list of supported crypto trading pairs
// GET /api/crypto/history  — historical OHLCV klines from Binance
//
// Binance public REST endpoints require no API key for market data.
// We proxy through the server to keep all origin traffic uniform and to
// allow caching / rate-limit handling in the future.

import { Router } from "express";
import { logger } from "../lib/logger";

const router = Router();

const BINANCE_REST = "https://api.binance.com";

const VALID_INTERVALS = new Set([
  "1m", "3m", "5m", "15m", "30m",
  "1h", "2h", "4h", "6h", "8h", "12h",
  "1d", "3d", "1w", "1M",
]);

export const CRYPTO_SYMBOLS = [
  { symbol: "BTCUSDT",  name: "Bitcoin",   baseAsset: "BTC" },
  { symbol: "ETHUSDT",  name: "Ethereum",  baseAsset: "ETH" },
  { symbol: "SOLUSDT",  name: "Solana",    baseAsset: "SOL" },
  { symbol: "BNBUSDT",  name: "BNB",       baseAsset: "BNB" },
  { symbol: "XRPUSDT",  name: "XRP",       baseAsset: "XRP" },
  { symbol: "ADAUSDT",  name: "Cardano",   baseAsset: "ADA" },
  { symbol: "DOGEUSDT", name: "Dogecoin",  baseAsset: "DOGE" },
  { symbol: "AVAXUSDT", name: "Avalanche", baseAsset: "AVAX" },
  { symbol: "DOTUSDT",  name: "Polkadot",  baseAsset: "DOT" },
  { symbol: "MATICUSDT",name: "Polygon",   baseAsset: "MATIC" },
];

// ── GET /crypto/symbols ──────────────────────────────────────────────────────
// Mounted under /api via app.use("/api", router) → full path: /api/crypto/symbols
router.get("/crypto/symbols", (_req, res) => {
  res.json(CRYPTO_SYMBOLS);
});

// ── GET /crypto/history ───────────────────────────────────────────────────────
// Mounted under /api via app.use("/api", router) → full path: /api/crypto/history
// Query params:
//   symbol   — e.g. BTCUSDT  (required)
//   interval — e.g. 5m       (default: 5m)
//   limit    — 1–1000        (default: 1000)
router.get("/crypto/history", async (req, res): Promise<void> => {
  const {
    symbol,
    interval = "5m",
    limit    = "1000",
  } = req.query as Record<string, string>;

  if (!symbol) {
    res.status(400).json({ error: "symbol required" });
    return;
  }

  const sym = symbol.toUpperCase();

  if (!VALID_INTERVALS.has(interval)) {
    res.status(400).json({
      error: `invalid interval. Valid values: ${[...VALID_INTERVALS].join(", ")}`,
    });
    return;
  }

  const limitNum = Math.min(Math.max(1, parseInt(limit, 10) || 1000), 1000);

  const url =
    `${BINANCE_REST}/api/v3/klines` +
    `?symbol=${encodeURIComponent(sym)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&limit=${limitNum}`;

  req.log?.info({ sym, interval, limit: limitNum }, "Binance klines fetch");

  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "TradingSignalsPlatform/1.0" },
      signal: AbortSignal.timeout(10_000),
    });

    if (!r.ok) {
      const body = await r.text().catch(() => "");
      req.log?.warn({ sym, interval, status: r.status, body }, "Binance klines HTTP error");
      res.status(r.status).json({ error: `Binance API error ${r.status}`, detail: body });
      return;
    }

    // Binance kline format:
    // [open_time_ms, open, high, low, close, volume, close_time_ms, ...]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (await r.json()) as any[][];

    const bars = raw
      .map((k) => ({
        time:   Math.floor(k[0] / 1000),  // ms → Unix seconds
        open:   parseFloat(k[1]),
        high:   parseFloat(k[2]),
        low:    parseFloat(k[3]),
        close:  parseFloat(k[4]),
        volume: parseFloat(k[5]),
      }))
      .filter(
        (b) =>
          isFinite(b.open) && isFinite(b.high) && isFinite(b.low) && isFinite(b.close) &&
          b.time > 0 && b.high >= b.open && b.high >= b.close &&
          b.low  <= b.open && b.low  <= b.close && b.low <= b.high,
      );

    req.log?.info({ sym, interval, bars: bars.length }, "Binance klines served");
    res.json(bars);
  } catch (err) {
    logger.error({ err, sym, interval }, "Binance klines fetch failed");
    res.status(500).json({ error: "Failed to fetch crypto history from Binance" });
  }
});

export default router;
