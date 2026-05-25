/**
 * Alpaca Markets data client.
 * Used for all intraday (5m, 15m) historical bars and live price snapshots.
 * Daily / weekly / monthly data is still served by yfinance.
 */

const DATA_BASE = "https://data.alpaca.markets";

const apiKey  = () => process.env.ALPACA_API_KEY  ?? "";
const secret  = () => process.env.ALPACA_SECRET_KEY ?? "";

const TIMEFRAME_MAP: Record<string, string> = {
  "5m":  "5Min",
  "15m": "15Min",
};

export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface AlpacaSnapshot {
  price:     number;
  open:      number;
  high:      number;
  low:       number;
  volume:    number;
  prevClose: number;
}

// ── Internal fetch helper ────────────────────────────────────────────────────

async function alpacaFetch(path: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(`${DATA_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    headers: {
      "APCA-API-KEY-ID":     apiKey(),
      "APCA-API-SECRET-KEY": secret(),
      "Accept":              "application/json",
    },
    signal: AbortSignal.timeout(25_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Alpaca HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  return res.json();
}

// ── Historical bars ──────────────────────────────────────────────────────────

interface AlpacaBarRaw { t: string; o: number; h: number; l: number; c: number; v: number; }
interface AlpacaBarsResp { bars?: AlpacaBarRaw[]; next_page_token?: string; }

/**
 * Fetch OHLCV bars from Alpaca for the given symbol and interval.
 * `days` controls how many calendar days back to fetch (default 90).
 * Pass `startDate` as "YYYY-MM-DD" to override the rolling window with a fixed origin.
 * Handles pagination transparently.
 */
export async function fetchAlpacaBars(symbol: string, interval: string, days = 90, startDate?: string): Promise<Bar[]> {
  const tf = TIMEFRAME_MAP[interval];
  if (!tf) throw new Error(`Unsupported Alpaca interval: ${interval}`);

  const end   = new Date();
  const start = startDate ? new Date(`${startDate}T00:00:00Z`) : new Date(end.getTime() - days * 86_400_000);

  const bars: Bar[] = [];
  let pageToken: string | undefined;

  do {
    const params: Record<string, string> = {
      timeframe:  tf,
      start:      start.toISOString(),
      end:        end.toISOString(),
      limit:      "10000",
      adjustment: "all",
      feed:       "iex",
    };
    if (pageToken) params.page_token = pageToken;

    const data = (await alpacaFetch(`/v2/stocks/${encodeURIComponent(symbol)}/bars`, params)) as AlpacaBarsResp;

    for (const b of data.bars ?? []) {
      const ts = Math.floor(new Date(b.t).getTime() / 1000);
      bars.push({ time: ts, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v });
    }

    pageToken = data.next_page_token ?? undefined;
  } while (pageToken);

  // Ensure ascending order (Alpaca returns them in order, but be safe)
  bars.sort((a, b) => a.time - b.time);
  return bars;
}

// ── Live snapshot ────────────────────────────────────────────────────────────

interface AlpacaSnapshotRaw {
  latestTrade?:  { p: number };
  latestQuote?:  { ap: number; bp: number };
  minuteBar?:    { t: string; o: number; h: number; l: number; c: number; v: number };
  dailyBar?:     { t: string; o: number; h: number; l: number; c: number; v: number };
  prevDailyBar?: { t: string; o: number; h: number; l: number; c: number; v: number };
}

/**
 * Fetch the latest snapshot for a symbol: current price, daily OHLCV, prev close.
 * Returns null on any error so callers can fall back gracefully.
 */
export async function fetchAlpacaSnapshot(symbol: string): Promise<AlpacaSnapshot | null> {
  try {
    const data = (await alpacaFetch(`/v2/stocks/${encodeURIComponent(symbol)}/snapshot`, { feed: "iex" })) as AlpacaSnapshotRaw;

    const price     = data.latestTrade?.p ?? data.latestQuote?.ap ?? data.dailyBar?.c ?? 0;
    const dayBar    = data.dailyBar;
    const prevClose = data.prevDailyBar?.c ?? 0;

    return {
      price,
      open:      dayBar?.o ?? price,
      high:      dayBar?.h ?? price,
      low:       dayBar?.l ?? price,
      volume:    dayBar?.v ?? 0,
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
    const now    = new Date();
    const etStr  = now.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });
    // etStr: "5/22/2026, 15:30:00"
    const [, timePart] = etStr.split(", ");
    if (!timePart) return false;
    const [hStr, mStr] = timePart.split(":");
    const h = parseInt(hStr, 10);
    const m = parseInt(mStr, 10);

    // Day-of-week in ET
    const etDate = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const dow = etDate.getDay(); // 0=Sun, 6=Sat
    if (dow === 0 || dow === 6) return false;

    const totalMin = h * 60 + m;
    return totalMin >= 9 * 60 + 30 && totalMin < 16 * 60;
  } catch {
    return false;
  }
}
