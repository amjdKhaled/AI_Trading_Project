import { useState, useCallback } from "react";
import { Activity, Radio, RefreshCw, Check, AlertCircle, Clock } from "lucide-react";

interface DiagBar     { time: number; open: number; high: number; low: number; close: number; volume: number; }
interface DiagSnap    { price: number; open: number; high: number; low: number; volume: number; prevClose: number; }
interface DiagWs      { status: "realtime" | "delayed" | "connecting" | "offline"; url: string | null; authenticated: boolean; }
interface DiagData    { symbol: string; interval: string; fetchedAt: string; snapshot: DiagSnap | null; latestBars: DiagBar[]; websocket: DiagWs; }

const INTERVALS = ["5m", "15m", "1h", "1d"];

const DATA_SOURCES = [
  { label: "Historical bars",  endpoint: "/v2/aggs/ticker/{sym}/range/{tf}/minute|day",                desc: "Paginated SIP aggregates, adjusted=true, RTH-filtered for intraday" },
  { label: "Live snapshot",    endpoint: "/v2/snapshot/locale/us/markets/stocks/tickers/{sym}",       desc: "Current price + daily OHLCV, used on WS connect to seed the chart" },
  { label: "News sentiment",   endpoint: "/v2/reference/news?ticker={sym}",                           desc: "Latest headlines scored by AI for bull/bear sentiment" },
  { label: "WebSocket trades", endpoint: "wss://socket.polygon.io/stocks → T.{sym}, AM.{sym}",       desc: "Real-time trades (throttled 1/s) + minute-agg closes for candle accuracy" },
];

const WS_META: Record<string, { color: string; dot: string; label: string; hint: string }> = {
  realtime:   { color: "text-emerald-400 bg-emerald-500/10 border-emerald-500/30", dot: "bg-emerald-400 animate-pulse", label: "Real-time",         hint: "Authenticated on wss://socket.polygon.io/stocks — full SIP trades and minute aggregates." },
  delayed:    { color: "text-yellow-400 bg-yellow-500/10 border-yellow-500/30",   dot: "bg-yellow-400 animate-pulse",  label: "Delayed (15 min)",  hint: "Connected to delayed.polygon.io — data arrives 15 minutes late. Upgrade to Stocks Starter+ for real-time." },
  connecting: { color: "text-blue-400 bg-blue-500/10 border-blue-500/30",         dot: "bg-blue-400 animate-pulse",    label: "Connecting…",       hint: "Establishing connection to Polygon WebSocket. This normally completes within a few seconds." },
  offline:    { color: "text-red-400 bg-red-500/10 border-red-500/30",            dot: "bg-red-400",                   label: "Offline",            hint: "Both real-time and delayed endpoints rejected the key. Update POLYGON_API_KEY and restart the server." },
};

const fmt    = (n: number, d = 2) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtVol = (v: number) => v >= 1_000_000 ? `${(v / 1_000_000).toFixed(2)}M` : v >= 1_000 ? `${(v / 1_000).toFixed(1)}K` : v.toFixed(0);
const fmtET  = (sec: number) => new Date(sec * 1000).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

export default function DiagnosticsPage() {
  const [symbol,   setSymbol]   = useState("NVDA");
  const [interval, setInterval] = useState("5m");
  const [data,     setData]     = useState<DiagData | null>(null);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);

  const base = (import.meta.env.BASE_URL ?? "").replace(/\/$/, "");

  const runDiagnostics = useCallback(() => {
    const sym = symbol.trim().toUpperCase();
    if (!sym) return;
    setLoading(true);
    setError(null);

    const ctrl = new AbortController();
    void fetch(`${base}/api/diagnostics?symbol=${encodeURIComponent(sym)}&interval=${interval}`, { signal: ctrl.signal })
      .then((r) => r.ok ? (r.json() as Promise<DiagData>) : r.text().then((t) => Promise.reject(new Error(`HTTP ${r.status}: ${t.slice(0, 120)}`))))
      .then((d) => { setData(d); })
      .catch((e: Error) => { if (e.name !== "AbortError") setError(e.message); })
      .finally(() => setLoading(false));
  }, [symbol, interval, base]);

  const ws    = data?.websocket;
  const wsMeta = ws ? WS_META[ws.status] : null;

  const lastBar = data?.latestBars.at(-1) ?? null;
  const priceDiff = data?.snapshot && lastBar
    ? Math.abs((lastBar.close - data.snapshot.price) / data.snapshot.price * 100)
    : null;

  return (
    <div className="flex flex-col h-full bg-background text-foreground overflow-y-auto">
      <div className="max-w-3xl mx-auto w-full px-5 py-5 space-y-4">

        {/* Header */}
        <div className="flex items-center gap-2.5">
          <Activity size={15} className="text-blue-400 flex-shrink-0" />
          <div>
            <h1 className="text-sm font-bold text-foreground">Market Data Diagnostics</h1>
            <p className="text-[11px] text-muted-foreground">Verify live Polygon.io values against chart display</p>
          </div>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-2 flex-wrap">
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === "Enter" && runDiagnostics()}
            placeholder="NVDA"
            className="w-24 text-xs px-2.5 py-1.5 bg-card border border-border rounded text-foreground placeholder-muted-foreground/40 uppercase tracking-wide"
          />
          <select
            value={interval}
            onChange={(e) => setInterval(e.target.value)}
            className="text-xs px-2.5 py-1.5 bg-card border border-border rounded text-foreground"
          >
            {INTERVALS.map((tf) => <option key={tf} value={tf}>{tf}</option>)}
          </select>
          <button
            onClick={runDiagnostics}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-50 transition-colors"
          >
            <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
            {loading ? "Fetching…" : "Fetch from Polygon"}
          </button>
          {data && (
            <span className="text-[10px] text-muted-foreground/60 ml-1">
              <Clock size={9} className="inline mr-1" />
              {new Date(data.fetchedAt).toLocaleTimeString("en-US", { hour12: false, timeZone: "UTC" })} UTC
            </span>
          )}
        </div>

        {error && (
          <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded px-3 py-2">
            <AlertCircle size={12} className="flex-shrink-0" />
            {error}
          </div>
        )}

        {data && (
          <>
            {/* WS Status */}
            {ws && wsMeta && (
              <div className="bg-card border border-border rounded-lg p-4">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2.5">
                  <Radio size={10} className="inline mr-1.5" />WebSocket Connection
                </p>
                <div className="flex items-start gap-3">
                  <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold rounded border ${wsMeta.color} flex-shrink-0`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${wsMeta.dot}`} />
                    {wsMeta.label}
                  </span>
                  <div className="min-w-0">
                    {ws.url && <p className="text-[10px] font-mono text-blue-400/80 truncate">{ws.url}</p>}
                    <p className="text-[10px] text-muted-foreground/70 mt-0.5">{wsMeta.hint}</p>
                  </div>
                </div>
                {ws.status === "realtime" && (
                  <p className="mt-2 text-[10px] text-muted-foreground/60">
                    Subscriptions on connect: <span className="font-mono text-foreground/70">T.{data.symbol}</span> (trades, throttled 1 /s) + <span className="font-mono text-foreground/70">AM.{data.symbol}</span> (minute aggregates)
                  </p>
                )}
              </div>
            )}

            {/* Snapshot */}
            {data.snapshot ? (
              <div className="bg-card border border-border rounded-lg p-4">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                  Polygon Snapshot — {data.symbol}
                </p>
                <div className="flex items-end gap-4 mb-3">
                  <div>
                    <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider mb-0.5">Last Price</p>
                    <p className="text-2xl font-bold text-foreground tracking-tight">${fmt(data.snapshot.price)}</p>
                  </div>
                  <div className="pb-0.5">
                    <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider mb-0.5">vs Prev Close</p>
                    <p className="text-xs text-muted-foreground">${fmt(data.snapshot.prevClose)}</p>
                    <p className={`text-xs font-semibold ${data.snapshot.price >= data.snapshot.prevClose ? "text-emerald-400" : "text-red-400"}`}>
                      {data.snapshot.price >= data.snapshot.prevClose ? "+" : ""}
                      {fmt(((data.snapshot.price - data.snapshot.prevClose) / (data.snapshot.prevClose || 1)) * 100)}%
                    </p>
                  </div>
                  <div className="pb-0.5 ml-auto">
                    <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider mb-0.5">Daily Volume</p>
                    <p className="text-sm font-semibold text-foreground">{fmtVol(data.snapshot.volume)}</p>
                  </div>
                </div>
                <div className="grid grid-cols-4 gap-2 pt-3 border-t border-border/60">
                  {(["open", "high", "low", "price"] as const).map((k) => (
                    <div key={k} className="bg-muted/20 rounded px-2 py-1.5">
                      <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider mb-0.5">
                        {k === "price" ? "Close" : k.charAt(0).toUpperCase() + k.slice(1)}
                      </p>
                      <p className="text-xs font-mono text-foreground">${fmt(data.snapshot![k])}</p>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="bg-card border border-border rounded-lg p-4">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Polygon Snapshot</p>
                <p className="text-xs text-muted-foreground/60">Snapshot unavailable — market may be closed or symbol not found.</p>
              </div>
            )}

            {/* Latest Bars */}
            {data.latestBars.length > 0 && (
              <div className="bg-card border border-border rounded-lg p-4">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                  Latest Polygon Bars — {data.interval} — {data.symbol}
                </p>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[9px] uppercase tracking-wider text-muted-foreground/60 border-b border-border">
                      {["Time (ET)", "Open", "High", "Low", "Close", "Volume"].map((h) => (
                        <th key={h} className={`pb-1.5 font-medium ${h === "Time (ET)" ? "text-left" : "text-right"}`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/40">
                    {[...data.latestBars].reverse().map((b, i) => (
                      <tr key={b.time} className={i === 0 ? "text-foreground" : "text-muted-foreground/70"}>
                        <td className="py-1.5 font-mono text-[11px]">{fmtET(b.time)}</td>
                        <td className="py-1.5 text-right font-mono">{fmt(b.open)}</td>
                        <td className="py-1.5 text-right font-mono text-emerald-400/80">{fmt(b.high)}</td>
                        <td className="py-1.5 text-right font-mono text-red-400/80">{fmt(b.low)}</td>
                        <td className="py-1.5 text-right font-mono">{fmt(b.close)}</td>
                        <td className="py-1.5 text-right font-mono text-muted-foreground/60">{fmtVol(b.volume)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {/* Match check */}
                {priceDiff !== null && data.snapshot && lastBar && (
                  <div className={`mt-3 pt-2.5 border-t border-border/60 flex items-center gap-2 text-[11px] ${priceDiff < 2 ? "text-emerald-400" : "text-yellow-400"}`}>
                    {priceDiff < 2
                      ? <><Check size={11} className="flex-shrink-0" />Last bar close <span className="font-mono mx-1">${fmt(lastBar.close)}</span> matches live price <span className="font-mono mx-1">${fmt(data.snapshot.price)}</span> within <span className="font-mono mx-1">{priceDiff.toFixed(2)}%</span></>
                      : <><AlertCircle size={11} className="flex-shrink-0" />Last bar close <span className="font-mono mx-1">${fmt(lastBar.close)}</span> differs from live price <span className="font-mono mx-1">${fmt(data.snapshot.price)}</span> by <span className="font-mono mx-1">{priceDiff.toFixed(2)}%</span> — expected when market is open</>
                    }
                  </div>
                )}
              </div>
            )}

            {/* Data source map */}
            <div className="bg-card border border-border rounded-lg p-4">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">Polygon Data Sources — All Equity Data</p>
              <div className="space-y-2.5">
                {DATA_SOURCES.map((s) => (
                  <div key={s.label} className="flex items-start gap-2.5">
                    <Check size={10} className="text-emerald-400 mt-0.5 flex-shrink-0" />
                    <div>
                      <span className="text-xs text-foreground font-medium">{s.label}</span>
                      <p className="text-[10px] font-mono text-blue-400/70 mt-0.5">{s.endpoint}</p>
                      <p className="text-[10px] text-muted-foreground/60">{s.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
              <p className="mt-3 pt-2.5 border-t border-border/60 text-[10px] text-muted-foreground/50">
                Crypto (BTC, ETH, etc.) uses Binance WS + REST — Polygon crypto requires a separate add-on tier.
              </p>
            </div>
          </>
        )}

        {!data && !loading && (
          <div className="flex flex-col items-center justify-center py-14 text-center gap-2">
            <Activity size={22} className="text-muted-foreground/25" />
            <p className="text-xs text-muted-foreground/60">Enter a symbol and click <span className="font-medium text-foreground/60">Fetch from Polygon</span> to run diagnostics</p>
          </div>
        )}

      </div>
    </div>
  );
}
