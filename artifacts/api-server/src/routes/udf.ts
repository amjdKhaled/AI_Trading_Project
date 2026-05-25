/**
 * TradingView UDF (Universal Data Feed) adapter.
 *
 * Implements the JSON HTTP protocol the TradingView Charting Library expects
 * for historical bars, symbol resolution, and configuration. All endpoints
 * are mounted under /api/udf/* and back the chart on the trading-signals
 * frontend (TVChartContainer.tsx).
 *
 * Spec reference:
 *   https://www.tradingview.com/charting-library-docs/latest/connecting_data/UDF/
 *
 * Data sources:
 *   - 5m / 15m intraday  → Polygon SIP via fetchPolygonBars (RTH-filtered)
 *   - 60m / D / W / M     → yfinance via fetchHistory
 *
 * UDF endpoints implemented:
 *   GET /api/udf/config             – datafeed feature list
 *   GET /api/udf/time               – server time (unix seconds, text/plain)
 *   GET /api/udf/symbols?symbol=X   – SymbolInfo for one symbol
 *   GET /api/udf/search?query=…     – symbol search (watchlist-backed)
 *   GET /api/udf/history?symbol=…&resolution=…&from=…&to=…
 */

import { Router, type IRouter } from "express";
import { fetchHistory } from "./history";
import { db, symbolsTable } from "@workspace/db";

const router: IRouter = Router();

// ── Resolution mapping ───────────────────────────────────────────────────────
// TradingView sends resolution as "1","5","15","60","D","W","M" (and a few
// variants). We translate to the interval strings our backend already speaks.

function tvResolutionToInterval(r: string): string | null {
  const v = String(r).trim();
  if (v === "5")                     return "5m";
  if (v === "15")                    return "15m";
  if (v === "60")                    return "1h";
  if (v === "D"  || v === "1D")      return "1d";
  if (v === "W"  || v === "1W")      return "1w";
  if (v === "M"  || v === "1M")      return "1M";
  return null;
}

const SUPPORTED_RESOLUTIONS = ["5", "15", "60", "D", "W", "M"];

// ── /config ──────────────────────────────────────────────────────────────────
// Static capability descriptor consumed once at library boot.

router.get("/udf/config", (_req, res) => {
  res.json({
    supports_search:          true,
    supports_group_request:   false,
    supports_marks:           false,
    supports_timescale_marks: false,
    supports_time:            true,
    supported_resolutions:    SUPPORTED_RESOLUTIONS,
    exchanges: [
      { value: "",       name: "All Exchanges", desc: "" },
      { value: "NASDAQ", name: "NASDAQ",        desc: "NASDAQ" },
      { value: "NYSE",   name: "NYSE",          desc: "NYSE"   },
    ],
    symbols_types: [
      { name: "All",   value: "" },
      { name: "Stock", value: "stock" },
    ],
  });
});

// ── /time ────────────────────────────────────────────────────────────────────
// Plain-text unix seconds; used by TV to align the user clock with the server.

router.get("/udf/time", (_req, res) => {
  res.setHeader("Content-Type", "text/plain");
  res.send(String(Math.floor(Date.now() / 1000)));
});

// ── /symbols ─────────────────────────────────────────────────────────────────
// TV calls this from resolveSymbol(symbolName). We synthesize a SymbolInfo on
// the fly so any US equity ticker the user types works without a registry.

router.get("/udf/symbols", (req, res) => {
  const sym = String(req.query.symbol ?? "").toUpperCase().trim();
  if (!sym) {
    res.status(400).json({ s: "error", errmsg: "symbol required" });
    return;
  }

  res.json({
    name:                 sym,
    ticker:               sym,
    full_name:            `NASDAQ:${sym}`,
    description:          sym,
    type:                 "stock",
    session:              "0930-1600",
    timezone:             "America/New_York",
    exchange:             "NASDAQ",
    listed_exchange:      "NASDAQ",
    format:               "price",
    pricescale:           100,
    minmov:               1,
    has_intraday:         true,
    has_daily:            true,
    has_weekly_and_monthly: true,
    intraday_multipliers: ["5", "15", "60"],
    supported_resolutions: SUPPORTED_RESOLUTIONS,
    volume_precision:     0,
    data_status:          "delayed_streaming",
  });
});

// ── /search ──────────────────────────────────────────────────────────────────
// Used by the symbol-search input. Backed by the user's watchlist so they get
// suggestions from symbols they already track; falls back to echoing the
// query as a typed ticker so any equity can still be opened.

router.get("/udf/search", async (req, res) => {
  const q     = String(req.query.query ?? "").toUpperCase().trim();
  const limit = Math.max(1, Math.min(50, Number(req.query.limit ?? 30)));

  try {
    const rows = await db.select().from(symbolsTable);
    const matches = rows
      .filter((r) => !q || r.symbol.toUpperCase().includes(q))
      .slice(0, limit)
      .map((r) => ({
        symbol:      r.symbol.toUpperCase(),
        full_name:   `NASDAQ:${r.symbol.toUpperCase()}`,
        description: r.name ?? r.symbol,
        exchange:    "NASDAQ",
        ticker:      r.symbol.toUpperCase(),
        type:        "stock",
      }));

    // If the user typed a ticker that isn't in their watchlist, surface it as
    // a first-class hit so they can open arbitrary symbols (e.g. AMZN).
    if (q && !matches.some((m) => m.symbol === q)) {
      matches.unshift({
        symbol: q, full_name: `NASDAQ:${q}`, description: q,
        exchange: "NASDAQ", ticker: q, type: "stock",
      });
    }

    res.json(matches.slice(0, limit));
  } catch {
    res.json([]);
  }
});

// ── /history ─────────────────────────────────────────────────────────────────
// The hot path. TV requests bars by (symbol, resolution, from, to). We fetch
// the full cached window from our backend (Polygon for intraday, yfinance for
// daily+) and slice it. Bars are returned in TV's column-oriented "ohlcv"
// shape.

interface Bar { time: number; open: number; high: number; low: number; close: number; volume: number }

router.get("/udf/history", async (req, res) => {
  const symbol     = String(req.query.symbol ?? "").toUpperCase().trim();
  const resolution = String(req.query.resolution ?? "").trim();
  const from       = Number(req.query.from);
  const to         = Number(req.query.to);

  if (!symbol || !resolution || !Number.isFinite(from) || !Number.isFinite(to)) {
    res.json({ s: "error", errmsg: "symbol, resolution, from, to required" });
    return;
  }

  const interval = tvResolutionToInterval(resolution);
  if (!interval) {
    res.json({ s: "error", errmsg: `unsupported resolution: ${resolution}` });
    return;
  }

  try {
    const all = (await fetchHistory(symbol, interval)) as Bar[];
    if (!Array.isArray(all) || all.length === 0) {
      res.json({ s: "no_data" });
      return;
    }

    // Slice to the requested window. TV expects ascending order.
    const slice = all.filter((b) => b.time >= from && b.time < to);

    if (slice.length === 0) {
      // Tell TV the earliest bar we have so it stops asking for older data
      // (otherwise it pages forever requesting pre-history).
      const earliest = all[0]?.time ?? 0;
      res.json({ s: "no_data", nextTime: earliest });
      return;
    }

    res.json({
      s: "ok",
      t: slice.map((b) => b.time),
      o: slice.map((b) => b.open),
      h: slice.map((b) => b.high),
      l: slice.map((b) => b.low),
      c: slice.map((b) => b.close),
      v: slice.map((b) => b.volume),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log?.warn({ symbol, resolution, err: msg }, "UDF history fetch failed");
    res.json({ s: "error", errmsg: msg });
  }
});

export default router;
