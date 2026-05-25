import { Router, type IRouter } from "express";
import { spawn } from "child_process";
import path from "path";

const router: IRouter = Router();

// process.cwd() = artifacts/api-server/ when run via pnpm, so src/ is always reachable
const PYTHON_SCRIPT = path.join(process.cwd(), "src", "yfinance_fetch.py");

// Interval → yfinance interval + yfinance period + cache TTL ms
const INTERVAL_CONFIG: Record<string, { yf: string; period: string; cacheTtl: number }> = {
  "1m":  { yf: "1m",  period: "7d",  cacheTtl:   60_000 },
  "5m":  { yf: "5m",  period: "60d", cacheTtl:   60_000 },
  "15m": { yf: "15m", period: "60d", cacheTtl:  120_000 },
  "30m": { yf: "30m", period: "60d", cacheTtl:  120_000 },
  "1h":  { yf: "60m", period: "max", cacheTtl:  300_000 },
  "4h":  { yf: "4h",  period: "max", cacheTtl:  300_000 },
  "1d":  { yf: "1d",  period: "max", cacheTtl: 3_600_000 },   // → full history (often 30–50 yrs)
  "1w":  { yf: "1wk", period: "max", cacheTtl: 3_600_000 },   // → full history
  "1M":  { yf: "1mo", period: "max", cacheTtl: 3_600_000 },   // → full history
};

// In-memory response cache
const cache = new Map<string, { data: unknown[]; expiresAt: number }>();

function runPython(symbol: string, yf_interval: string, period: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", [PYTHON_SCRIPT, symbol, yf_interval, period]);
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`yfinance exited ${code}: ${stderr.slice(0, 400)}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        if (parsed && parsed.error) {
          reject(new Error(parsed.error));
        } else if (Array.isArray(parsed)) {
          resolve(parsed);
        } else {
          reject(new Error("Unexpected output from yfinance_fetch"));
        }
      } catch {
        reject(new Error(`JSON parse failed: ${stdout.slice(0, 200)}`));
      }
    });

    proc.on("error", reject);
    // 30s hard timeout
    setTimeout(() => { proc.kill(); reject(new Error("yfinance fetch timed out")); }, 30_000);
  });
}

router.get("/history", async (req, res): Promise<void> => {
  const rawSymbol   = String(req.query.symbol ?? "").toUpperCase().trim();
  const rawInterval = String(req.query.interval ?? "1d").trim();

  if (!rawSymbol || rawSymbol.length > 12) {
    res.status(400).json({ error: "symbol is required and must be ≤12 chars" });
    return;
  }

  const config = INTERVAL_CONFIG[rawInterval];
  if (!config) {
    res.status(400).json({
      error: `Unsupported interval: ${rawInterval}`,
      supported: Object.keys(INTERVAL_CONFIG),
    });
    return;
  }

  const cacheKey = `${rawSymbol}:${rawInterval}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    res.setHeader("X-Cache", "HIT");
    res.json(cached.data);
    return;
  }

  try {
    const bars = await runPython(rawSymbol, config.yf, config.period);
    cache.set(cacheKey, { data: bars, expiresAt: Date.now() + config.cacheTtl });
    res.setHeader("X-Cache", "MISS");
    res.json(bars);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log?.warn({ symbol: rawSymbol, interval: rawInterval, err: msg }, "yfinance fetch failed");
    // Degrade gracefully — return empty array so the chart shows nothing instead of crashing
    res.json([]);
  }
});

export default router;
