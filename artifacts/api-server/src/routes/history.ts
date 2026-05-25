import { Router, type IRouter } from "express";
import { spawn } from "child_process";
import path from "path";

const router: IRouter = Router();

const PYTHON_SCRIPT = path.join(process.cwd(), "src", "yfinance_fetch.py");

const INTERVAL_CONFIG: Record<string, { yf: string; period: string; cacheTtl: number }> = {
  "1m":  { yf: "1m",  period: "7d",  cacheTtl:   60_000 },
  "5m":  { yf: "5m",  period: "60d", cacheTtl:   60_000 },
  "15m": { yf: "15m", period: "60d", cacheTtl:  120_000 },
  "30m": { yf: "30m", period: "60d", cacheTtl:  120_000 },
  "1h":  { yf: "60m", period: "max", cacheTtl:  300_000 },
  "1d":  { yf: "1d",  period: "max", cacheTtl: 3_600_000 },
  "1w":  { yf: "1wk", period: "max", cacheTtl: 3_600_000 },
  "1M":  { yf: "1mo", period: "max", cacheTtl: 3_600_000 },
};

const cache = new Map<string, { data: unknown[]; expiresAt: number }>();

// Exported for signal seeding — always returns pure intraday data (no blending)
export function fetchHistory(symbol: string, interval: string): Promise<unknown[]> {
  const config = INTERVAL_CONFIG[interval];
  if (!config) return Promise.resolve([]);
  return runPython(symbol, config.yf, config.period);
}

function runPython(symbol: string, yf_interval: string, period: string, timeoutMs = 45_000): Promise<unknown[]> {
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
        if (parsed?.error)       reject(new Error(parsed.error));
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

interface Bar { time: number; [k: string]: unknown }

/**
 * Blended history: daily candles from max history + recent intraday candles.
 * Gives the chart a long view (years of context) while showing detailed recent bars.
 */
async function fetchBlended(symbol: string, intradayYfInterval: string): Promise<unknown[]> {
  const [dailyRaw, intradayRaw] = await Promise.all([
    runPython(symbol, "1d",  "max", 60_000),   // up to 50 years daily
    runPython(symbol, intradayYfInterval, "60d", 45_000), // recent 60d intraday
  ]);

  const daily    = dailyRaw    as Bar[];
  const intraday = intradayRaw as Bar[];

  if (intraday.length === 0) return daily;
  if (daily.length    === 0) return intraday;

  // Cut off daily bars that overlap with the intraday period (keep 2-day buffer)
  const firstIntradayTime = intraday[0].time;
  const cutoff = firstIntradayTime - 86_400 * 2;
  const filteredDaily = daily.filter(b => b.time < cutoff);

  return [...filteredDaily, ...intraday];
}

router.get("/history", async (req, res): Promise<void> => {
  const rawSymbol   = String(req.query.symbol   ?? "").toUpperCase().trim();
  const rawInterval = String(req.query.interval ?? "1d").trim();
  const blended     = req.query.blended === "true";

  if (!rawSymbol || rawSymbol.length > 12) {
    res.status(400).json({ error: "symbol is required and must be ≤12 chars" }); return;
  }

  const config = INTERVAL_CONFIG[rawInterval];
  if (!config) {
    res.status(400).json({ error: `Unsupported interval: ${rawInterval}`, supported: Object.keys(INTERVAL_CONFIG) }); return;
  }

  // Intraday intervals always use blended mode: daily bars from ~1990 + recent intraday.
  // This gives the chart full historical context while keeping recent candles accurate.
  const canBlend = rawInterval === "5m" || rawInterval === "15m";
  const cacheKey = `${rawSymbol}:${rawInterval}${canBlend ? ":blended" : ""}`;
  const cacheTtl = canBlend ? 300_000 : config.cacheTtl;  // 5 min for blended

  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    res.setHeader("X-Cache", "HIT");
    res.json(cached.data);
    return;
  }

  try {
    const bars = canBlend
      ? await fetchBlended(rawSymbol, config.yf)
      : await runPython(rawSymbol, config.yf, config.period);

    cache.set(cacheKey, { data: bars, expiresAt: Date.now() + cacheTtl });
    res.setHeader("X-Cache", "MISS");
    res.json(bars);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log?.warn({ symbol: rawSymbol, interval: rawInterval, err: msg }, "yfinance fetch failed");
    res.json([]);
  }
});

export default router;
