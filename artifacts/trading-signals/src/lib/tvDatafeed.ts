/**
 * TradingView Charting Library custom datafeed.
 *
 * Implements the JS API the library expects (onReady, searchSymbols,
 * resolveSymbol, getBars, subscribeBars, unsubscribeBars). History comes from
 * our UDF HTTP endpoints (/api/udf/*); live bars are built client-side from
 * raw trade ticks on the existing /ws WebSocket and pushed via TV's
 * onRealtimeCallback as the library natively expects.
 *
 * Why a custom datafeed (vs the bundled UDFCompatibleDatafeed):
 *   The bundled UDF helper would POLL /api/udf/history on a timer for live
 *   updates — wasteful and laggy. We already have a WebSocket relaying every
 *   trade in real time; using it directly gives sub-second bar updates and
 *   matches the bar-roll behavior of TradingView's own live charts.
 */

const SUPPORTED_RESOLUTIONS = ["5", "15", "60", "D", "W", "M"];

interface UdfBarsOk {
  s: "ok";
  t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[];
}
interface UdfBarsNoData { s: "no_data"; nextTime?: number }
interface UdfBarsError  { s: "error"; errmsg: string }
type UdfBarsResp = UdfBarsOk | UdfBarsNoData | UdfBarsError;

export interface TvBar {
  time:   number;  // ms
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
}

interface PeriodParams {
  from: number;          // unix seconds
  to:   number;          // unix seconds
  countBack?: number;
  firstDataRequest?: boolean;
}

interface SymbolInfo {
  name:     string;
  ticker:   string;
  full_name: string;
  exchange:  string;
  type:      string;
  session:   string;
  timezone:  string;
  pricescale: number;
  minmov: number;
  has_intraday: boolean;
  has_daily: boolean;
  has_weekly_and_monthly: boolean;
  supported_resolutions: string[];
  volume_precision: number;
  data_status: string;
}

// Resolution → seconds. Used for floor-aligning live ticks to bar boundaries.
function resolutionToSeconds(resolution: string): number {
  const r = String(resolution);
  if (r === "5")                  return 300;
  if (r === "15")                 return 900;
  if (r === "60")                 return 3600;
  if (r === "D"  || r === "1D")   return 86400;
  if (r === "W"  || r === "1W")   return 86400 * 7;
  if (r === "M"  || r === "1M")   return 86400 * 30;
  return 300;
}

// ── Live-bar aggregator ──────────────────────────────────────────────────────
// One WebSocket per subscribeBars subscription. The server emits raw
// `price.update` frames; we floor each tick to the current resolution's
// boundary and either start a new bar or update the running one, then hand
// the bar to TV via the callback.

interface LiveSub {
  ws:                WebSocket;
  intervalSec:       number;
  symbol:            string;
  onRealtimeCallback: (bar: TvBar) => void;
  currentBar:        TvBar | null;
}

export function createTvDatafeed(baseUrl: string) {
  const udf = (path: string) => `${baseUrl}/api/udf${path}`;

  const subs = new Map<string, LiveSub>();

  return {
    onReady(callback: (config: Record<string, unknown>) => void) {
      fetch(udf("/config"))
        .then((r) => r.json())
        .then((cfg) => setTimeout(() => callback(cfg), 0))
        .catch(() => setTimeout(() => callback({
          supported_resolutions: SUPPORTED_RESOLUTIONS,
          supports_search: true, supports_time: true,
        }), 0));
    },

    searchSymbols(
      userInput:  string,
      exchange:   string,
      symbolType: string,
      onResult:   (results: unknown[]) => void,
    ) {
      const u = new URL(udf("/search"), window.location.origin);
      u.searchParams.set("query",    userInput);
      u.searchParams.set("type",     symbolType);
      u.searchParams.set("exchange", exchange);
      u.searchParams.set("limit",    "30");
      fetch(u.toString())
        .then((r) => r.json())
        .then(onResult)
        .catch(() => onResult([]));
    },

    resolveSymbol(
      symbolName:    string,
      onResolve:     (info: SymbolInfo) => void,
      onError:       (reason: string) => void,
    ) {
      const u = new URL(udf("/symbols"), window.location.origin);
      u.searchParams.set("symbol", symbolName);
      fetch(u.toString())
        .then((r) => r.json())
        .then((info: SymbolInfo & { s?: string; errmsg?: string }) => {
          if (info.s === "error") onError(info.errmsg ?? "resolve failed");
          else setTimeout(() => onResolve(info), 0);
        })
        .catch((e: unknown) => onError(String(e)));
    },

    getBars(
      symbolInfo:    SymbolInfo,
      resolution:    string,
      periodParams:  PeriodParams,
      onResult:      (bars: TvBar[], meta: { noData: boolean; nextTime?: number }) => void,
      onError:       (reason: string) => void,
    ) {
      const { from, to } = periodParams;
      const u = new URL(udf("/history"), window.location.origin);
      u.searchParams.set("symbol",     symbolInfo.ticker || symbolInfo.name);
      u.searchParams.set("resolution", resolution);
      u.searchParams.set("from",       String(from));
      u.searchParams.set("to",         String(to));

      fetch(u.toString())
        .then((r) => r.json() as Promise<UdfBarsResp>)
        .then((resp) => {
          if (resp.s === "error") { onError(resp.errmsg); return; }
          if (resp.s === "no_data") {
            onResult([], { noData: true, nextTime: resp.nextTime });
            return;
          }
          const bars: TvBar[] = resp.t.map((t, i) => ({
            time:   t * 1000,           // TV expects ms
            open:   resp.o[i],
            high:   resp.h[i],
            low:    resp.l[i],
            close:  resp.c[i],
            volume: resp.v[i],
          }));
          onResult(bars, { noData: false });
        })
        .catch((e: unknown) => onError(String(e)));
    },

    subscribeBars(
      symbolInfo:        SymbolInfo,
      resolution:        string,
      onRealtimeCallback: (bar: TvBar) => void,
      subscribeUID:      string,
    ) {
      // Replace any previous subscription with the same UID (TV does this
      // when switching intervals on the same symbol).
      this.unsubscribeBars(subscribeUID);

      const intervalSec = resolutionToSeconds(resolution);
      const symbol      = symbolInfo.ticker || symbolInfo.name;

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl    = `${protocol}//${window.location.host}${baseUrl}/ws?symbol=${encodeURIComponent(symbol)}`;
      const ws       = new WebSocket(wsUrl);

      const sub: LiveSub = { ws, intervalSec, symbol, onRealtimeCallback, currentBar: null };
      subs.set(subscribeUID, sub);

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type !== "price.update" || typeof msg.price !== "number" || msg.price <= 0) return;
          if (msg.symbol !== symbol) return;

          const tickSec    = Number(msg.timestamp) || Math.floor(Date.now() / 1000);
          const bucketSec  = tickSec - (tickSec % sub.intervalSec);
          const bucketMs   = bucketSec * 1000;
          const price      = msg.price as number;

          if (!sub.currentBar || bucketMs > sub.currentBar.time) {
            // New bar — emit the OPEN.
            sub.currentBar = {
              time: bucketMs, open: price, high: price, low: price, close: price, volume: 0,
            };
          } else if (bucketMs === sub.currentBar.time) {
            sub.currentBar = {
              time:   sub.currentBar.time,
              open:   sub.currentBar.open,
              high:   Math.max(sub.currentBar.high, price),
              low:    Math.min(sub.currentBar.low,  price),
              close:  price,
              volume: sub.currentBar.volume,
            };
          } else {
            // tick predates current bar — ignore.
            return;
          }
          onRealtimeCallback(sub.currentBar);
        } catch { /* malformed frame — ignore */ }
      };

      ws.onerror = () => { /* surface via close */ };
    },

    unsubscribeBars(subscribeUID: string) {
      const sub = subs.get(subscribeUID);
      if (!sub) return;
      try { sub.ws.close(); } catch { /* already closed */ }
      subs.delete(subscribeUID);
    },
  };
}
