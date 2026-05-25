import { Router, type IRouter } from "express";
import { spawn } from "child_process";
import path from "path";
import { fetchPolygonBars } from "../lib/polygon";

const router: IRouter = Router();

const PYTHON_SCRIPT = path.join(process.cwd(), "src", "yfinance_fetch.py");

// Daily / weekly / monthly intervals remain on yfinance (max history)
const DAILY_CONFIG: Record<string, { yf: string; period: string; cacheTtl: number }> = {
  "1h":  { yf: "60m", period: "max", cacheTtl:  300_000 },
  "1d":  { yf: "1d",  period: "max", cacheTtl: 3_600_000 },
  "1w":  { yf: "1wk", period: "max", cacheTtl: 3_600_000 },
  "1M":  { yf: "1mo", period: "max", cacheTtl: 3_600_000 },
};

const INTRADAY_INTERVALS = new Set(["5m", "15m"]);

// Per-interval lookback windows sized to fit in a single Polygon response
// (free tier returns ~10k bars per page; paginating costs 13s per page on the
// 5-req/min rate limit, so we keep the cold-cache fetch fast by default).
// 5m: 78 bars/trading day × 250 days ≈ 19.5k → cap at 180 days (≈14k bars)
// 15m: 26 bars/trading day × 540 days ≈ 14k bars
const INTRADAY_DAYS: Record<string, number> = { "5m": 180, "15m": 540 };

// Cache shared by all interval types
const cache = new Map<string, { data: unknown[]; expiresAt: number }>();

// ── yfinance (daily/long-term) ───────────────────────────────────────────────

function runPython(symbol: string, yf_interval: string, period: string, timeoutMs = 60_000): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", [PYTHON_SCRIPT, symbol, yf_interval, period]);
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("close", (code) => {
      if (code !== 0) { reject(new Error(`yfinance exited ${code}: ${stderr.slice(0, 400)}`)); return; }
      try {
        const parsed = JSON.parse(stdout);
        if (parsed?.error)        reject(new Error(parsed.error));
        else if (Array.isArray(parsed)) resolve(parsed);
        else reject(new Error("Unexpected yfinance output"));
      } catch {
        reject(new Error(`JSON parse failed: ${stdout.slice(0, 200)}`));
      }
    });

    proc.on("error", reject);
    setTimeout(() => { proc.kill(); reject(new Error("yfinance fetch timed out")); }, timeoutMs);
  });
}

// ── fetchHistory — exported for signal seeding ────────────────────────────
// Signals use real Alpaca intraday data for accurate analysis.
export async function fetchHistory(symbol: string, interval: string): Promise<unknown[]> {
  if (INTRADAY_INTERVALS.has(interval)) {
    // Polygon SIP intraday — consolidated OHLCV matching TradingView.
    // Uses the same per-interval window as the /history route so signal
    // seeding and chart display share an identical bar set.
    return fetchPolygonBars(symbol, interval, INTRADAY_DAYS[interval] ?? 180).catch(() => []);
  }
  const config = DAILY_CONFIG[interval];
  if (!config) return [];
  return runPython(symbol, config.yf, config.period);
}

// ── HTTP route ────────────────────────────────────────────────────────────────

router.get("/history", async (req, res): Promise<void> => {
  const rawSymbol   = String(req.query.symbol   ?? "").toUpperCase().trim();
  const rawInterval = String(req.query.interval ?? "1d").trim();

  if (!rawSymbol || rawSymbol.length > 12) {
    res.status(400).json({ error: "symbol is required and must be ≤12 chars" }); return;
  }

  const isIntraday = INTRADAY_INTERVALS.has(rawInterval);
  const dailyConf  = DAILY_CONFIG[rawInterval];

  if (!isIntraday && !dailyConf) {
    res.status(400).json({
      error: `Unsupported interval: ${rawInterval}`,
      supported: ["5m", "15m", ...Object.keys(DAILY_CONFIG)],
    }); return;
  }

  const cacheKey = `${rawSymbol}:${rawInterval}${isIntraday ? ":polygon-sip" : ""}`;
  const cacheTtl = isIntraday ? 300_000 : dailyConf!.cacheTtl;

  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    res.setHeader("X-Cache", "HIT");
    res.json(cached.data);
    return;
  }

  try {
    const bars = isIntraday
      // Polygon SIP intraday — consolidated tape, matches TradingView OHLCV.
      // Window is sized to fit in one Polygon response so first paint is fast
      // even on the free tier's 5-req/min budget.
      ? await fetchPolygonBars(rawSymbol, rawInterval, INTRADAY_DAYS[rawInterval] ?? 180)
      : await runPython(rawSymbol, dailyConf!.yf, dailyConf!.period);

    cache.set(cacheKey, { data: bars, expiresAt: Date.now() + cacheTtl });
    res.setHeader("X-Cache", "MISS");
    res.json(bars);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log?.warn({ symbol: rawSymbol, interval: rawInterval, err: msg }, "history fetch failed");
    res.json([]);
  }
});

export default router;
