import { Router, type IRouter } from "express";
import { spawn } from "child_process";
import path from "path";
import { fetchAlpacaBars } from "../lib/alpaca";

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
    // Use Alpaca for intraday signal seeding — real OHLCV, proper timestamps
    return fetchAlpacaBars(symbol, interval, 90).catch(() => []);
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

  const cacheKey = `${rawSymbol}:${rawInterval}${isIntraday ? ":alpaca-blended" : ""}`;
  const cacheTtl = isIntraday ? 300_000 : dailyConf!.cacheTtl;

  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    res.setHeader("X-Cache", "HIT");
    res.json(cached.data);
    return;
  }

  try {
    const bars = isIntraday
      // Pure Alpaca intraday — no blending with daily candles.
      // SIP feed goes back to ~2016; "2015-01-01" ensures we always capture the full range.
      ? await fetchAlpacaBars(rawSymbol, rawInterval, 90, "2015-01-01")
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
