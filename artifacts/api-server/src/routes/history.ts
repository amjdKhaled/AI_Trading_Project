import { Router, type IRouter } from "express";
import path from "path";
import fs from "fs/promises";
import { fetchPolygonBars } from "../lib/polygon";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// All intervals served by Polygon REST (SLP plan — no rate limit concerns)
const SUPPORTED_INTERVALS = new Set(["5m", "15m", "1h", "1d", "1w", "1M"]);

// Minute-based intervals keep a 24h TTL — historical bars are immutable.
// Hour/daily+ refresh every hour so today's incomplete bar stays reasonably fresh.
const INTERVAL_MEM_TTL: Record<string, number> = {
  "5m":  24 * 60 * 60 * 1_000,
  "15m": 24 * 60 * 60 * 1_000,
  "1h":  60 * 60 * 1_000,
  "1d":  60 * 60 * 1_000,
  "1w":  60 * 60 * 1_000,
  "1M":  60 * 60 * 1_000,
};

// Rolling lookback in calendar days for minute/hour intervals.
// Daily+ use a fixed start date to return maximum Polygon history.
const INTERVAL_DAYS: Record<string, number> = {
  "5m":  180,
  "15m": 540,
  "1h":  365,
};
const DAILY_INTERVALS  = new Set(["1d", "1w", "1M"]);
const POLYGON_MAX_START = "2004-01-01"; // earliest Polygon aggregate data

// ── In-memory cache ───────────────────────────────────────────────────────────
// Keeps fetched bars alive for MEM_TTL_MS without re-hitting the provider.
const memCache = new Map<string, { data: unknown[]; fetchedAt: number; expiresAt: number }>();

// ── In-flight deduplication ───────────────────────────────────────────────────
// /api/history and /api/signals both fire on page load — collapse concurrent
// requests for the same key into a single shared Promise.
const inflight = new Map<string, Promise<unknown[]>>();

// ── Disk cache ────────────────────────────────────────────────────────────────
// JSON files in data/barcache/ survive server restarts.
const DISK_DIR = path.join(process.cwd(), "data", "barcache");
const DISK_TTL = 24 * 60 * 60 * 1_000;

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
async function fetchWithCache(
  key: string,
  memTtlMs: number,
  fetcher: () => Promise<unknown[]>,
): Promise<unknown[]> {
  const mem = memCache.get(key);
  if (mem && mem.expiresAt > Date.now()) return mem.data;

  const existing = inflight.get(key);
  if (existing) return existing;

  const promise: Promise<unknown[]> = (async () => {
    const disk = await readDisk(key);
    if (disk && Date.now() - disk.fetchedAt < DISK_TTL) {
      memCache.set(key, { data: disk.data, fetchedAt: disk.fetchedAt, expiresAt: Date.now() + memTtlMs });
      return disk.data;
    }

    try {
      const data = await fetcher();
      const entry = { data, fetchedAt: Date.now(), expiresAt: Date.now() + memTtlMs };
      memCache.set(key, entry);
      writeDisk(key, data).catch(() => {});
      return data;
    } catch (err) {
      const stale = disk ?? (mem ? { data: mem.data } : null);
      if (stale) {
        logger.warn({ key, err: String(err) }, "bar provider fetch failed — serving stale cache");
        memCache.set(key, { data: stale.data, fetchedAt: Date.now(), expiresAt: Date.now() + 60_000 });
        return stale.data;
      }
      throw err;
    }
  })().finally(() => inflight.delete(key));

  inflight.set(key, promise);
  return promise;
}

// ── fetchHistory — exported for signal seeding ────────────────────────────────
// Uses the SAME cache/dedup layer as the HTTP route so regenerate calls never
// trigger a fresh Polygon fetch when bars are already in-flight or cached.
export async function fetchHistory(symbol: string, interval: string): Promise<unknown[]> {
  const sym = symbol.toUpperCase().trim();
  if (!SUPPORTED_INTERVALS.has(interval)) return [];

  const cacheKey  = `${sym}:${interval}:polygon`;
  const memTtlMs  = INTERVAL_MEM_TTL[interval] ?? 3_600_000;
  const isDaily   = DAILY_INTERVALS.has(interval);
  const days      = INTERVAL_DAYS[interval] ?? 180;
  const startDate = isDaily ? POLYGON_MAX_START : undefined;

  return fetchWithCache(cacheKey, memTtlMs, () =>
    fetchPolygonBars(sym, interval, days, startDate),
  );
}

// ── HTTP route ────────────────────────────────────────────────────────────────

router.get("/history", async (req, res): Promise<void> => {
  const rawSymbol   = String(req.query.symbol   ?? "").toUpperCase().trim();
  const rawInterval = String(req.query.interval ?? "1d").trim();

  if (!rawSymbol || rawSymbol.length > 12) {
    res.status(400).json({ error: "symbol is required and must be ≤12 chars" }); return;
  }

  if (!SUPPORTED_INTERVALS.has(rawInterval)) {
    res.status(400).json({
      error:     `Unsupported interval: ${rawInterval}`,
      supported: [...SUPPORTED_INTERVALS],
    }); return;
  }

  try {
    const cacheKey = `${rawSymbol}:${rawInterval}:polygon`;
    const memEntry = memCache.get(cacheKey);
    const preHit   = !!(memEntry && memEntry.expiresAt > Date.now());
    const t0       = Date.now();
    const bars     = await fetchHistory(rawSymbol, rawInterval);
    req.log?.info(
      { symbol: rawSymbol, interval: rawInterval, count: bars.length, cache: preHit ? "HIT" : "MISS", ms: Date.now() - t0 },
      "history served",
    );
    res.setHeader("X-Cache", preHit ? "HIT" : "MISS");
    res.json(bars);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log?.warn(
      { symbol: rawSymbol, interval: rawInterval, err: msg, stack: (err as Error).stack },
      "history fetch failed",
    );
    res.status(502).json({
      error:    "history fetch failed",
      message:  msg,
      symbol:   rawSymbol,
      interval: rawInterval,
    });
  }
});

export default router;
