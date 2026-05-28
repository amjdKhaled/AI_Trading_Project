import { Router, type IRouter } from "express";
import { spawn } from "child_process";
import path from "path";
import fs from "fs/promises";
import { fetchPolygonBars } from "../lib/polygon";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const PYTHON_SCRIPT = path.join(process.cwd(), "src", "yfinance_fetch.py");

// Daily / weekly / monthly intervals remain on yfinance (max history)
const DAILY_CONFIG: Record<string, { yf: string; period: string; memTtlMs: number }> = {
  "1h":  { yf: "60m", period: "max", memTtlMs:    300_000 },
  "1d":  { yf: "1d",  period: "max", memTtlMs:  3_600_000 },
  "1w":  { yf: "1wk", period: "max", memTtlMs:  3_600_000 },
  "1M":  { yf: "1mo", period: "max", memTtlMs:  3_600_000 },
};

const INTRADAY_INTERVALS = new Set(["5m", "15m"]);

// Per-interval lookback windows sized to fit in a single Polygon response
const INTRADAY_DAYS: Record<string, number> = { "5m": 180, "15m": 540 };

// ── In-memory cache ───────────────────────────────────────────────────────────
// Keeps fetched bars alive for MEM_TTL_MS without re-hitting the provider.
// Historical intraday bars don't change — 24 h is safe; only today's trailing
// bars are live, and the engine re-generates signals explicitly via /regenerate.
const MEM_TTL_INTRADAY = 24 * 60 * 60 * 1_000; // 24 h — historical bars are immutable
const memCache = new Map<string, { data: unknown[]; fetchedAt: number; expiresAt: number }>();

// ── In-flight deduplication ───────────────────────────────────────────────────
// The root cause of Polygon 429 bursts: /api/history and /api/signals both fire
// on page load, both see a cold cache at the same instant, and both start their
// own independent Polygon fetch.  We collapse concurrent requests for the same
// key into a single shared Promise, so only ONE Polygon call is ever made.
const inflight = new Map<string, Promise<unknown[]>>();

// ── Disk cache ────────────────────────────────────────────────────────────────
// JSON files in data/barcache/ survive server restarts.  The disk layer is the
// sole "offline fallback" — if Polygon is unreachable we return stale disk data
// rather than an empty array, so signal generation still works.
const DISK_DIR  = path.join(process.cwd(), "data", "barcache");
const DISK_TTL  = 24 * 60 * 60 * 1_000; // 24 h disk freshness before re-fetching

function diskPath(key: string): string {
  const safe = key.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(DISK_DIR, `${safe}.json`);
}

async function readDisk(key: string): Promise<{ data: unknown[]; fetchedAt: number } | null> {
  try {
    const raw = await fs.readFile(diskPath(key), "utf-8");
    return JSON.parse(raw) as { data: unknown[]; fetchedAt: number };
  } catch { return null; }
}

async function writeDisk(key: string, data: unknown[]): Promise<void> {
  try {
    await fs.mkdir(DISK_DIR, { recursive: true });
    await fs.writeFile(diskPath(key), JSON.stringify({ data, fetchedAt: Date.now() }));
  } catch { /* best-effort */ }
}

// ── Core cache+fetch function ─────────────────────────────────────────────────
/**
 * Fetch bars for `key` using the supplied `fetcher`, applying:
 *   1. Memory cache (returns immediately if fresh)
 *   2. In-flight deduplication (concurrent requests share one Promise)
 *   3. Disk cache (populates memory without hitting the provider on restarts)
 *   4. Stale-on-error fallback (returns cached data if the provider throws)
 */
async function fetchWithCache(
  key: string,
  memTtlMs: number,
  fetcher: () => Promise<unknown[]>,
): Promise<unknown[]> {
  // 1. Memory hit — fastest path
  const mem = memCache.get(key);
  if (mem && mem.expiresAt > Date.now()) return mem.data;

  // 2. In-flight dedup — collapse concurrent callers into one fetch
  const existing = inflight.get(key);
  if (existing) return existing;

  // 3. Kick off a single fetch that all concurrent callers will await
  const promise: Promise<unknown[]> = (async () => {
    // 3a. Disk cache — avoids Polygon on server restarts / short outages
    const disk = await readDisk(key);
    if (disk && Date.now() - disk.fetchedAt < DISK_TTL) {
      memCache.set(key, { data: disk.data, fetchedAt: disk.fetchedAt, expiresAt: Date.now() + memTtlMs });
      return disk.data;
    }

    // 3b. Provider fetch
    try {
      const data = await fetcher();
      const entry = { data, fetchedAt: Date.now(), expiresAt: Date.now() + memTtlMs };
      memCache.set(key, entry);
      writeDisk(key, data).catch(() => {}); // fire-and-forget
      return data;
    } catch (err) {
      // 3c. Stale fallback — return whatever we have rather than an empty array
      const stale = disk ?? (mem ? { data: mem.data } : null);
      if (stale) {
        logger.warn({ key, err: String(err) }, "bar provider fetch failed — serving stale cache");
        // Short TTL so the next request retries the provider soon
        memCache.set(key, { data: stale.data, fetchedAt: Date.now(), expiresAt: Date.now() + 60_000 });
        return stale.data;
      }
      throw err; // Nothing cached at all — surface the error
    }
  })().finally(() => inflight.delete(key));

  inflight.set(key, promise);
  return promise;
}

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

// ── fetchHistory — exported for signal seeding ────────────────────────────────
// Uses the SAME cache/dedup layer as the HTTP route so regenerate calls never
// trigger a fresh Polygon fetch when bars are already in-flight or cached.
export async function fetchHistory(symbol: string, interval: string): Promise<unknown[]> {
  const sym        = symbol.toUpperCase().trim();
  const isIntraday = INTRADAY_INTERVALS.has(interval);
  const dailyConf  = DAILY_CONFIG[interval];

  if (!isIntraday && !dailyConf) return [];

  const cacheKey = `${sym}:${interval}${isIntraday ? ":polygon" : ":yfinance"}`;
  const memTtl   = isIntraday ? MEM_TTL_INTRADAY : dailyConf!.memTtlMs;

  return fetchWithCache(cacheKey, memTtl, () =>
    isIntraday
      ? fetchPolygonBars(sym, interval, INTRADAY_DAYS[interval] ?? 180)
      : runPython(sym, dailyConf!.yf, dailyConf!.period)
  );
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

  try {
    const bars = await fetchHistory(rawSymbol, rawInterval);
    const mem  = memCache.get(`${rawSymbol}:${rawInterval}${isIntraday ? ":polygon" : ":yfinance"}`);
    res.setHeader("X-Cache", mem ? "HIT" : "MISS");
    res.json(bars);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log?.warn({ symbol: rawSymbol, interval: rawInterval, err: msg }, "history fetch failed");
    res.json([]);
  }
});

export default router;
