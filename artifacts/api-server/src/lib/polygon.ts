/**
 * Polygon.io market-data client.
 *
 * Used for all intraday (5m, 15m) historical bars and live price snapshots.
 * Daily / weekly / monthly data is still served by yfinance.
 *
 * Polygon's bars come from the consolidated SIP tape (all US exchanges),
 * so OHLCV values match TradingView, ThinkOrSwim, and institutional terminals.
 */

const REST_BASE = "https://api.polygon.io";

const apiKey = () => process.env.POLYGON_API_KEY ?? "";

// Polygon uses "multiplier/timespan" pairs. We expose the same string keys
// our routes already use ("5m", "15m") and translate at the edge.
const TIMEFRAME_MAP: Record<string, { multiplier: number; timespan: string }> = {
  "5m":  { multiplier: 5,  timespan: "minute" },
  "15m": { multiplier: 15, timespan: "minute" },
};

export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PolygonSnapshot {
  price:     number;
  open:      number;
  high:      number;
  low:       number;
  volume:    number;
  prevClose: number;
}

// ── Regular Trading Hours filter ─────────────────────────────────────────────
// TradingView's default US-equities session is Regular Trading Hours only:
// 09:30 – 16:00 America/New_York, Mon–Fri (DST-aware). Polygon's aggregates
// include all extended-hours activity (04:00 – 20:00 ET), which inflates the
// bar count, changes volume, and distorts the OHLC of the 5m bars that
// straddle 09:30 / 16:00. Filtering to RTH here brings our chart in line with
// the default TradingView display.
//
// A bar's `time` is its START. We keep bars whose start is in [09:30, 16:00) ET,
// i.e. minute-of-day in [570, 960). The 15:55 bar (start 955) is included; the
// 16:00 bar (start 960) is excluded — same convention TradingView uses.

const ET_PARTS_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone:   "America/New_York",
  hourCycle:  "h23",
  weekday:    "short",
  hour:       "2-digit",
  minute:     "2-digit",
});

function isRegularTradingHours(epochSec: number): boolean {
  const parts = ET_PARTS_FMT.formatToParts(new Date(epochSec * 1000));
  const wd = parts.find((p) => p.type === "weekday")?.value;
  if (wd === "Sat" || wd === "Sun") return false;
  const hh = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const mm = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const minutes = hh * 60 + mm;
  return minutes >= 570 && minutes < 960; // 09:30 ≤ t < 16:00 ET
}

// ── Internal fetch helper ────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Fetch a Polygon URL with automatic 429 backoff.
 * Polygon's free tier allows only 5 requests/minute, so on rate-limit we wait
 * a fixed 13 s (just over the 12 s "smooth" window of 5/min) and retry up to
 * `maxRetries` times. This keeps cold-cache pagination from failing without
 * needing per-request user intervention.
 */
async function polygonFetch(url: string, maxRetries = 3): Promise<unknown> {
  const u = new URL(url);
  // Always attach the apiKey query param. Polygon's `next_url` includes
  // everything except the key, so we must add it on every hop.
  u.searchParams.set("apiKey", apiKey());
  const finalUrl = u.toString();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(finalUrl, {
      headers: { Accept: "application/json" },
      signal:  AbortSignal.timeout(55_000),
    });

    if (res.status === 429 && attempt < maxRetries) {
      // Rate-limited. Wait for the per-minute bucket to refill, then retry.
      await sleep(13_000);
      continue;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Polygon HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    return res.json();
  }
  throw new Error("Polygon rate-limit retries exhausted");
}

// ── Historical bars ──────────────────────────────────────────────────────────

interface PolygonAggRaw { t: number; o: number; h: number; l: number; c: number; v: number; }
interface PolygonAggsResp {
  status?:   string;
  results?:  PolygonAggRaw[];
  next_url?: string;
}

/**
 * Fetch OHLCV bars from Polygon for the given symbol and interval.
 * `days` controls how many calendar days back to fetch (default 90).
 * Pass `startDate` as "YYYY-MM-DD" to override the rolling window with a fixed origin.
 *
 * Polygon returns ascending bars in `results`, with `t` as a millisecond Unix epoch
 * representing the bar's *start* time. We convert to seconds (lightweight-charts
 * convention) and de-dupe across paginated responses.
 *
 * `adjusted=true` applies splits & dividends so historical prices line up with the
 * current ticker, matching TradingView's default display.
 */
export async function fetchPolygonBars(symbol: string, interval: string, days = 90, startDate?: string): Promise<Bar[]> {
  const tf = TIMEFRAME_MAP[interval];
  if (!tf) throw new Error(`Unsupported Polygon interval: ${interval}`);

  // CRITICAL: Polygon anchors aggregate windows to the `from` parameter. Passing
  // a wall-clock ms timestamp (e.g. 18:07:45.568) produces bars at :03/:08/:13...
  // instead of the wall-clock :00/:05/:10... that TradingView shows. Using a
  // YYYY-MM-DD date string anchors the windows to 00:00 UTC of that day, which
  // divides cleanly into every supported intraday timeframe (1m/5m/15m/…),
  // so bars land on standard market boundaries (e.g. 09:30, 09:35, 09:40 ET).
  const toDate = new Date().toISOString().slice(0, 10);
  const fromDate = startDate
    ? startDate
    : new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  const initialUrl =
    `${REST_BASE}/v2/aggs/ticker/${encodeURIComponent(symbol)}` +
    `/range/${tf.multiplier}/${tf.timespan}/${fromDate}/${toDate}` +
    `?adjusted=true&sort=asc&limit=50000`;

  const bars: Bar[] = [];
  const seen = new Set<number>();
  let nextUrl: string | undefined = initialUrl;
  let pageCount = 0;

  while (nextUrl) {
    const data = (await polygonFetch(nextUrl)) as PolygonAggsResp;
    for (const r of data.results ?? []) {
      const ts = Math.floor(r.t / 1000);
      // De-dupe across paginated pages: Polygon occasionally repeats the boundary bar.
      if (seen.has(ts)) continue;
      seen.add(ts);
      bars.push({ time: ts, open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v });
    }

    nextUrl = data.next_url;
    pageCount++;
    // Hard safety cap. 50k bars/page × 200 pages = 10M bars — far beyond any
    // realistic intraday history. Prevents accidental infinite loops on a
    // malformed `next_url`.
    if (pageCount > 200) break;
  }

  // Polygon returns ascending order already; sort as a defensive measure.
  bars.sort((a, b) => a.time - b.time);

  // Filter to Regular Trading Hours so OHLCV, volume profile, and bar boundaries
  // match TradingView's default US-equities session. Drops pre-market (04:00–09:30
  // ET) and after-hours (16:00–20:00 ET), and excludes the 16:00 closing-cross bar.
  return bars.filter((b) => isRegularTradingHours(b.time));
}

// ── Live snapshot ────────────────────────────────────────────────────────────

interface PolygonSnapshotRaw {
  ticker?: {
    day?:        { o: number; h: number; l: number; c: number; v: number };
    prevDay?:    { o: number; h: number; l: number; c: number; v: number };
    lastTrade?:  { p: number; t: number };
    lastQuote?:  { p?: number; P?: number };
    min?:        { o: number; h: number; l: number; c: number; v: number };
  };
}

/**
 * Fetch the latest snapshot for a symbol: current price, daily OHLCV, prev close.
 * Returns null on any error so callers can fall back gracefully.
 */
export async function fetchPolygonSnapshot(symbol: string): Promise<PolygonSnapshot | null> {
  try {
    const url = `${REST_BASE}/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(symbol)}`;
    const data = (await polygonFetch(url)) as PolygonSnapshotRaw;
    const t = data.ticker;
    if (!t) return null;

    const price     = t.lastTrade?.p ?? t.min?.c ?? t.day?.c ?? 0;
    const day       = t.day;
    const prevClose = t.prevDay?.c ?? 0;

    return {
      price,
      open:      day?.o ?? price,
      high:      day?.h ?? price,
      low:       day?.l ?? price,
      volume:    day?.v ?? 0,
      prevClose,
    };
  } catch {
    return null;
  }
}

// ── Market hours (NYSE) ───────────────────────────────────────────────────────

/**
 * Returns true if NYSE regular session is currently active.
 * Uses JS Intl to determine Eastern Time — no Python dependency.
 */
export function isNyseOpen(): boolean {
  try {
    const now   = new Date();
    const etStr = now.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });
    // etStr: "5/22/2026, 15:30:00"
    const [, timePart] = etStr.split(", ");
    if (!timePart) return false;
    const [hStr, mStr] = timePart.split(":");
    const h = parseInt(hStr, 10);
    const m = parseInt(mStr, 10);

    const etDate = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const dow = etDate.getDay(); // 0=Sun, 6=Sat
    if (dow === 0 || dow === 6) return false;

    const totalMin = h * 60 + m;
    return totalMin >= 9 * 60 + 30 && totalMin < 16 * 60;
  } catch {
    return false;
  }
}
