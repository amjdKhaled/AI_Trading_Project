import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { WatchlistPanel } from "@/components/WatchlistPanel";
import { TradingChart } from "@/components/TradingChart";
import { SignalPanel } from "@/components/SignalPanel";
import { useMarketSocket, type SignalNew } from "@/hooks/useMarketSocket";
import { useActiveSymbol } from "@/lib/ActiveSymbolContext";

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

// DEV only: synthetic signals from bar data to verify the rendering layer without
// requiring a seeded database or Polygon quota.
function makeMockSignals(bars: OhlcvBar[], symbol: string): SignalNew[] {
  if (bars.length < 30) return [];
  const signals: SignalNew[] = [];
  let i = 30;
  while (i < bars.length) {
    const bar = bars[i];
    const prev = bars.slice(Math.max(0, i - 14), i);
    const atr = prev.reduce((s, b) => s + (b.high - b.low), 0) / (prev.length || 1);
    if (atr > 0) {
      const isLong = bar.close > bars[Math.max(0, i - 5)].close;
      signals.push({
        type:        "signal.new" as const,
        signalId:    `dev-${symbol}-${i}`,
        symbol,
        side:        isLong ? "long" : "short",
        entryPrice:  bar.close,
        slPrice:     isLong ? bar.close - atr * 1.5 : bar.close + atr * 1.5,
        tpPrice:     isLong ? bar.close + atr * 3.0 : bar.close - atr * 3.0,
        confidence:  65 + (i % 25),
        riskTag:     "Medium",
        barTime:     new Date(bar.time * 1000).toISOString(),
        grade:       (i % 3 === 0 ? "A" : "B") as "A" | "B",
        patterns:    undefined,
        state:       "active",
        exitPrice:   null,
        exitBarTime: null,
        exitReason:  null,
      });
    }
    i += 30 + (i % 20);
  }
  return signals;
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
    fetch(`${base}/api/history?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`, { signal: ctrl.signal })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<OhlcvBar[]>; })
      .then((d) => { if (!ctrl.signal.aborted) { setBars(Array.isArray(d) ? d : []); setLoad(false); } })
      .catch((e) => { if (e.name === "AbortError") return; setError(e.message); setLoad(false); });

    return () => ctrl.abort();
  }, [symbol, interval]);

  return { bars, loading, error };
}

export default function ChartPage() {
  const { activeSymbol, setActiveSymbol } = useActiveSymbol();
  const [timeframe, setTimeframe]         = useState<Timeframe>("5m");
  const [restSignals, setRestSignals]   = useState<SignalNew[]>([]);
  const [activeTrade, setActiveTrade]   = useState<ActiveTrade | null>(null);
  const [tradeResult, setTradeResult]   = useState<TradeResult | null>(null);
  const [refetchKey,  setRefetchKey]    = useState(0);
  const [generating,  setGenerating]    = useState(false);
  const [genMsg,      setGenMsg]        = useState<string | null>(null);
  const [devMock,     setDevMock]       = useState(false);

  const { bars, loading, error } = useHistoryBars(activeSymbol, timeframe);
  const { connected, lastPrice, isMarketOpen, realtimeAvailable, newSignals: wsSignals } = useMarketSocket(activeSymbol);

  // Fetch historical signals
  useEffect(() => {
    if (!activeSymbol) { setRestSignals([]); return; }
    const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
    // Fetch up to 3000 signals — the backtested engine generates 1k–3k signals
    // across full intraday history. Viewport culling in TradingChart keeps
    // rendering fast regardless of how many signals are loaded.
    // cache: 'no-cache' forces a fresh response after every regenerate.
    fetch(`${base}/api/signals?symbol=${encodeURIComponent(activeSymbol)}&timeframe=${encodeURIComponent(timeframe)}&limit=3000`, { cache: "no-cache" })
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
          state:      (s.state as SignalNew["state"]) ?? "active",
          exitPrice:  s.exitPrice == null ? null : Number(s.exitPrice),
          exitBarTime: s.exitBarTime == null ? null : new Date(String(s.exitBarTime)).toISOString(),
          exitReason:  s.exitReason == null ? null : String(s.exitReason),
        }));
        setRestSignals(mapped);
      })
      .catch(() => setRestSignals([]));
  // refetchKey bumps after a successful /regenerate call to trigger a fresh fetch
  }, [activeSymbol, timeframe, refetchKey]);

  // Clear active trade on symbol/timeframe switch
  useEffect(() => {
    setActiveTrade(null);
    setTradeResult(null);
  }, [activeSymbol, timeframe]);

  // Auto-exit: watch live price stream for SL/TP hits
  const resultTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!activeTrade || !lastPrice) return;
    if (lastPrice.symbol !== activeTrade.symbol) return;

    const { side, slPrice, tpPrice } = activeTrade;
    const price = lastPrice.price;
    // Check whether the latest trade price crosses the SL or TP level.
    // Using the raw trade price (not inferred H/L) is correct and simpler —
    // the level is hit the moment an actual transaction occurs at that price.
    const tpHit = side === "long" ? price >= tpPrice : price <= tpPrice;
    const slHit = side === "long" ? price <= slPrice : price >= slPrice;
    if (!tpHit && !slHit) return;

    const outcome   = tpHit ? "tp_hit" : "sl_hit";
    const exitPrice = tpHit ? tpPrice  : slPrice;
    setTradeResult({ outcome, exitPrice, exitTime: lastPrice.timestamp });
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
  }, [lastPrice, activeTrade]);

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

  const handleGenerate = useCallback(async () => {
    if (!activeSymbol || generating) return;
    setGenerating(true);
    setGenMsg(null);
    const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
    try {
      const r = await fetch(
        `${base}/api/signals/regenerate?symbol=${encodeURIComponent(activeSymbol)}&timeframe=${encodeURIComponent(timeframe)}`,
        { method: "POST" }
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json() as { ok: boolean; inserted?: number; backtest?: { winRate?: number | null }; error?: string };
      if (data.ok) {
        const wr = data.backtest?.winRate != null ? ` · ${data.backtest.winRate}% WR` : "";
        setGenMsg(`✓ ${data.inserted ?? 0} signals${wr}`);
        setRefetchKey((k) => k + 1);
      } else {
        setGenMsg(`✗ ${data.error ?? "failed"}`);
      }
    } catch (e) {
      setGenMsg(`✗ ${String(e)} — Polygon 429? Wait ~60s then retry`);
    } finally {
      setGenerating(false);
    }
  }, [activeSymbol, timeframe, generating]);

  // DEV: log the full signal pipeline on each meaningful state change so the
  // browser console reveals exactly where the pipeline is broken.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    console.groupCollapsed(
      `%c[TradingPipeline] ${activeSymbol ?? "–"} ${timeframe} | bars=${bars.length} rest=${restSignals.length} ws=${wsSignals.length}`,
      "color:#22d3ee;font-weight:bold"
    );
    console.log("WS connected:", connected, "| isMarketOpen:", isMarketOpen, "| realtimeAvailable:", realtimeAvailable);
    if (restSignals.length === 0 && bars.length > 0) {
      console.warn("⚠ No signals in DB — click ⚡ Generate to seed them (Polygon rate limit may apply)");
    }
    console.groupEnd();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars.length, restSignals.length, wsSignals.length, connected]);

  // DEV: synthetic signals for rendering-layer verification (toggle via MOCK button)
  const mockSignals = useMemo(
    () => (import.meta.env.DEV && devMock && activeSymbol ? makeMockSignals(bars, activeSymbol) : []),
    [devMock, bars, activeSymbol]
  );

  // Deduplicate signals by signalId (WS + REST + optional mock merged).
  // Filter by activeSymbol so stale WS signals from a previously viewed
  // symbol can't bleed onto the new symbol's chart after switching.
  const allSignals: SignalNew[] = [...wsSignals, ...restSignals, ...mockSignals]
    .filter((sig) => !activeSymbol || sig.symbol === activeSymbol)
    .filter((sig, idx, arr) => arr.findIndex((s) => s.signalId === sig.signalId) === idx);

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

          {/* Signal generation controls */}
          <div className="flex items-center gap-1.5 ml-2">
            <button
              onClick={handleGenerate}
              disabled={generating || !activeSymbol}
              className="flex items-center gap-1 px-2.5 py-0.5 rounded text-[11px] font-mono font-medium border border-white/10 text-muted-foreground hover:text-foreground hover:border-white/20 transition-colors disabled:opacity-40"
              title="Run the signal engine against Polygon history for this symbol+timeframe"
            >
              {generating
                ? <><span className="inline-block w-2.5 h-2.5 border border-current border-t-transparent rounded-full animate-spin" />  Gen…</>
                : "⚡ Generate"}
            </button>
            {genMsg && (
              <span className={`text-[10px] font-mono ${genMsg.startsWith("✓") ? "text-emerald-400" : "text-amber-400"}`}>
                {genMsg}
              </span>
            )}
            {import.meta.env.DEV && (
              <button
                onClick={() => setDevMock((v) => !v)}
                className={`px-2 py-0.5 rounded text-[10px] font-mono border transition-colors ${devMock ? "border-amber-500/50 text-amber-400 bg-amber-500/10" : "border-white/10 text-muted-foreground hover:text-foreground"}`}
                title="Toggle synthetic mock signals to verify the rendering layer (DEV only — never stored in DB)"
              >
                MOCK
              </button>
            )}
          </div>

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
            lastPrice={lastPrice}
            symbol={activeSymbol}
            timeframe={timeframe}
            intervalSec={TF_SECONDS[timeframe]}
            isMarketOpen={isMarketOpen}
            realtimeAvailable={realtimeAvailable}
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
          onGenerate={handleGenerate}
          generating={generating}
        />
      </div>
    </div>
  );
}
