import { useState, useEffect, useRef } from "react";
import { WatchlistPanel } from "@/components/WatchlistPanel";
import { TradingChart } from "@/components/TradingChart";
import { SignalPanel } from "@/components/SignalPanel";
import { useMarketSocket } from "@/hooks/useMarketSocket";

const TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w", "1M"] as const;
type Timeframe = (typeof TIMEFRAMES)[number];

const TF_SECONDS: Record<Timeframe, number> = {
  "1m":  60,
  "5m":  300,
  "15m": 900,
  "30m": 1800,
  "1h":  3600,
  "4h":  14400,
  "1d":  86400,
  "1w":  604800,
  "1M":  2592000,
};

export interface OhlcvBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function useHistoryBars(symbol: string | null, interval: Timeframe) {
  const [bars, setBars] = useState<OhlcvBar[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!symbol) return;

    // Cancel any in-flight fetch
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setBars([]);
    setLoading(true);
    setError(null);

    const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
    const url = `${base}/api/history?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`;

    fetch(url, { signal: ctrl.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<OhlcvBar[]>;
      })
      .then((data) => {
        if (!ctrl.signal.aborted) {
          setBars(Array.isArray(data) ? data : []);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (err.name === "AbortError") return;
        setError(err.message);
        setLoading(false);
      });

    return () => ctrl.abort();
  }, [symbol, interval]);

  return { bars, loading, error };
}

export default function ChartPage() {
  const [activeSymbol, setActiveSymbol] = useState<string | null>("NVDA");
  const [timeframe, setTimeframe] = useState<Timeframe>("1d");

  const { bars, loading, error } = useHistoryBars(activeSymbol, timeframe);
  const { connected, lastBar, newSignals } = useMarketSocket(
    timeframe === "1m" || timeframe === "5m" ? activeSymbol : null
  );

  return (
    <div className="flex h-full" data-testid="chart-page">
      {/* Watchlist — left panel */}
      <div className="w-44 flex-shrink-0">
        <WatchlistPanel
          activeSymbol={activeSymbol}
          onSelectSymbol={(s) => { setActiveSymbol(s); }}
          connected={connected}
        />
      </div>

      {/* Chart — center */}
      <div className="flex-1 flex flex-col min-w-0 bg-[#0b0e14]">
        {/* Timeframe toolbar */}
        <div className="flex items-center gap-0.5 px-3 py-1.5 border-b border-white/5 flex-shrink-0">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              onClick={() => setTimeframe(tf)}
              className={`px-2 py-0.5 rounded text-[11px] font-mono font-medium transition-colors ${
                tf === timeframe
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-white/5"
              }`}
            >
              {tf}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2">
            <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
            <div className="text-xs text-muted-foreground font-mono">
              Fetching {activeSymbol} {timeframe} history…
            </div>
          </div>
        ) : error ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-xs text-destructive font-mono text-center">
              <div className="mb-1">Failed to load data</div>
              <div className="text-muted-foreground">{error}</div>
            </div>
          </div>
        ) : activeSymbol ? (
          <TradingChart
            bars={bars}
            activeSignals={newSignals}
            lastBar={lastBar}
            symbol={activeSymbol}
            timeframe={timeframe}
            intervalSec={TF_SECONDS[timeframe]}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm text-muted-foreground">Select a symbol from the watchlist</p>
          </div>
        )}
      </div>

      {/* Signal panel — right */}
      <div className="w-52 flex-shrink-0">
        <SignalPanel symbol={activeSymbol} newSignals={newSignals} />
      </div>
    </div>
  );
}
