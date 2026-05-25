import { useState, useEffect, useRef, useCallback } from "react";
import { WatchlistPanel } from "@/components/WatchlistPanel";
import { TradingChart } from "@/components/TradingChart";
import { SignalPanel } from "@/components/SignalPanel";
import { useMarketSocket, type SignalNew } from "@/hooks/useMarketSocket";

const TIMEFRAMES = ["5m", "15m"] as const;
type Timeframe = (typeof TIMEFRAMES)[number];

const TF_SECONDS: Record<Timeframe, number> = { "5m": 300, "15m": 900 };

export interface OhlcvBar {
  time: number; open: number; high: number; low: number; close: number; volume: number;
}

export interface ActiveTrade {
  signalId: string;
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  confidence: number;
  barTime: string;
  grade?: string;
  patterns?: string[];
}

export interface TradeResult {
  outcome: "tp_hit" | "sl_hit";
  exitPrice: number;
  exitTime: number;
}

function useHistoryBars(symbol: string | null, interval: Timeframe) {
  const [bars, setBars]     = useState<OhlcvBar[]>([]);
  const [loading, setLoad]  = useState(false);
  const [error, setError]   = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!symbol) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBars([]); setLoad(true); setError(null);

    const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
    fetch(`${base}/api/history?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&blended=true`, { signal: ctrl.signal })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<OhlcvBar[]>; })
      .then((d) => { if (!ctrl.signal.aborted) { setBars(Array.isArray(d) ? d : []); setLoad(false); } })
      .catch((e) => { if (e.name === "AbortError") return; setError(e.message); setLoad(false); });

    return () => ctrl.abort();
  }, [symbol, interval]);

  return { bars, loading, error };
}

export default function ChartPage() {
  const [activeSymbol, setActiveSymbol] = useState<string | null>("NVDA");
  const [timeframe, setTimeframe]       = useState<Timeframe>("5m");
  const [restSignals, setRestSignals]   = useState<SignalNew[]>([]);
  const [activeTrade, setActiveTrade]   = useState<ActiveTrade | null>(null);
  const [tradeResult, setTradeResult]   = useState<TradeResult | null>(null);

  const { bars, loading, error } = useHistoryBars(activeSymbol, timeframe);
  const { connected, lastBar, newSignals: wsSignals } = useMarketSocket(activeSymbol);

  // Fetch historical signals
  useEffect(() => {
    if (!activeSymbol) { setRestSignals([]); return; }
    const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
    fetch(`${base}/api/signals?symbol=${encodeURIComponent(activeSymbol)}&timeframe=${encodeURIComponent(timeframe)}&limit=20`)
      .then((r) => r.json())
      .then((data: unknown) => {
        if (!Array.isArray(data)) { setRestSignals([]); return; }
        const mapped: SignalNew[] = (data as Record<string, unknown>[]).map((s) => ({
          type: "signal.new" as const,
          signalId:   String(s.signalId),
          symbol:     String(s.symbol),
          side:       (s.side as string) === "long" ? ("long" as const) : ("short" as const),
          entryPrice: Number(s.entryPrice),
          slPrice:    Number(s.slPrice),
          tpPrice:    Number(s.tpPrice),
          confidence: Number(s.confidence),
          riskTag:    String(s.riskTag),
          barTime:    new Date(String(s.barTime)).toISOString(),
          grade:      s.grade as ("A+" | "A" | "B" | "Weak") | undefined,
          patterns:   Array.isArray(s.patterns) ? (s.patterns as string[]) : undefined,
        }));
        setRestSignals(mapped);
      })
      .catch(() => setRestSignals([]));
  }, [activeSymbol, timeframe]);

  // Clear active trade on symbol/timeframe switch
  useEffect(() => {
    setActiveTrade(null);
    setTradeResult(null);
  }, [activeSymbol, timeframe]);

  // Auto-exit: watch live bar for SL/TP hits
  const resultTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!activeTrade || !lastBar) return;
    if (lastBar.symbol !== activeTrade.symbol) return;

    const { side, slPrice, tpPrice } = activeTrade;
    const tpHit = side === "long" ? lastBar.high >= tpPrice : lastBar.low  <= tpPrice;
    const slHit = side === "long" ? lastBar.low  <= slPrice : lastBar.high >= slPrice;
    if (!tpHit && !slHit) return;

    const outcome   = tpHit ? "tp_hit" : "sl_hit";
    const exitPrice = tpHit ? tpPrice  : slPrice;
    setTradeResult({ outcome, exitPrice, exitTime: lastBar.time });
    setActiveTrade(null);

    // Persist to DB
    const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
    fetch(`${base}/api/signals/${encodeURIComponent(activeTrade.signalId)}/state`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: outcome, exitPrice }),
    }).catch(() => {});

    if (resultTimerRef.current) clearTimeout(resultTimerRef.current);
    resultTimerRef.current = setTimeout(() => setTradeResult(null), 6000);
  }, [lastBar, activeTrade]);

  const handleActivateTrade = useCallback((trade: ActiveTrade) => {
    if (activeTrade) return; // one trade at a time
    setTradeResult(null);
    setActiveTrade(trade);
  }, [activeTrade]);

  const handleCloseTrade = useCallback(() => {
    if (!activeTrade) return;
    setActiveTrade(null);
    // Mark as expired in DB
    const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
    fetch(`${base}/api/signals/${encodeURIComponent(activeTrade.signalId)}/state`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "expired" }),
    }).catch(() => {});
  }, [activeTrade]);

  // Deduplicate signals by signalId (WS + REST merged)
  const allSignals: SignalNew[] = [...wsSignals, ...restSignals].filter(
    (sig, idx, arr) => arr.findIndex((s) => s.signalId === sig.signalId) === idx
  );

  return (
    <div className="flex h-full" data-testid="chart-page">
      <div className="w-44 flex-shrink-0">
        <WatchlistPanel activeSymbol={activeSymbol} onSelectSymbol={setActiveSymbol} connected={connected} />
      </div>

      <div className="flex-1 flex flex-col min-w-0 bg-[#0b0e14]">
        {/* Toolbar */}
        <div className="flex items-center gap-0.5 px-3 py-1.5 border-b border-white/5 flex-shrink-0">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              onClick={() => setTimeframe(tf)}
              className={`px-3 py-0.5 rounded text-[11px] font-mono font-medium transition-colors ${
                tf === timeframe
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-white/5"
              }`}
            >
              {tf}
            </button>
          ))}

          {/* Active trade badge */}
          {activeTrade && (
            <div className={`ml-3 flex items-center gap-2 px-2.5 py-0.5 rounded text-[11px] font-mono font-semibold border ${
              activeTrade.side === "long"
                ? "border-green-500/30 bg-green-500/10 text-green-400"
                : "border-red-500/30 bg-red-500/10 text-red-400"
            }`}>
              <span className="animate-pulse w-1.5 h-1.5 rounded-full bg-current" />
              {activeTrade.side === "long" ? "▲ LONG" : "▼ SHORT"} @ {activeTrade.entryPrice.toFixed(2)}
              <button
                onClick={handleCloseTrade}
                className="ml-1 opacity-60 hover:opacity-100 transition-opacity text-[10px]"
                title="Close trade"
              >
                ✕
              </button>
            </div>
          )}

          {/* Trade result flash */}
          {tradeResult && !activeTrade && (
            <div className={`ml-3 flex items-center gap-1.5 px-2.5 py-0.5 rounded text-[11px] font-mono font-semibold animate-pulse ${
              tradeResult.outcome === "tp_hit"
                ? "bg-green-500/20 text-green-400"
                : "bg-red-500/20 text-red-400"
            }`}>
              {tradeResult.outcome === "tp_hit" ? "✓ TP HIT" : "✗ SL HIT"} @ {tradeResult.exitPrice.toFixed(2)}
            </div>
          )}
        </div>

        {loading ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2">
            <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
            <div className="text-xs text-muted-foreground font-mono">Fetching {activeSymbol} {timeframe}…</div>
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
            signals={allSignals}
            activeTrade={activeTrade}
            tradeResult={tradeResult}
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

      <div className="w-56 flex-shrink-0">
        <SignalPanel
          symbol={activeSymbol}
          newSignals={wsSignals}
          activeTrade={activeTrade}
          onActivateTrade={handleActivateTrade}
          onCloseTrade={handleCloseTrade}
        />
      </div>
    </div>
  );
}
