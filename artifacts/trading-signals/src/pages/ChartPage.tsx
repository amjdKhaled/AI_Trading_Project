import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { X, Brain } from "lucide-react";
import { WatchlistPanel } from "@/components/WatchlistPanel";
import { TradingChart } from "@/components/TradingChart";
import { SignalPanel } from "@/components/SignalPanel";
import { useMarketSocket, type SignalNew } from "@/hooks/useMarketSocket";
import { useActiveSymbol } from "@/lib/ActiveSymbolContext";
import { getListSignalsQueryKey, getGetSignalStatsQueryKey } from "@workspace/api-client-react";

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
  const [bars, setBars]         = useState<OhlcvBar[]>([]);
  const [loading, setLoad]      = useState(false);
  const [error, setError]       = useState<string | null>(null);
  // Track which symbol+interval the bars in state belong to.
  // This detects the one-frame gap between a symbol change and the useEffect firing,
  // during which React would otherwise render TradingChart with stale bars.
  const [fetchedFor, setFetchedFor] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const requestKey = symbol ? `${symbol}:${interval}` : null;

  useEffect(() => {
    if (!symbol) {
      setBars([]); setLoad(false); setError(null); setFetchedFor(null);
      return;
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    // Clear stale bars and enter loading state atomically.
    // fetchedFor is deliberately NOT updated here — it remains the old symbol
    // so the staleness check below correctly returns loading=true on this render.
    setBars([]); setLoad(true); setError(null);

    const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
    fetch(
      `${base}/api/history?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`,
      { signal: ctrl.signal, cache: "no-cache" }
    )
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<OhlcvBar[]>; })
      .then((d) => {
        if (ctrl.signal.aborted) return;
        setBars(Array.isArray(d) ? d : []);
        setLoad(false);
        setFetchedFor(`${symbol}:${interval}`);
      })
      .catch((e) => {
        if (e.name === "AbortError") return;
        setError(e.message);
        setLoad(false);
      });

    return () => ctrl.abort();
  }, [symbol, interval]);

  // If the bars in state belong to a different symbol/interval than currently
  // requested, treat the component as loading to prevent a stale-data flash
  // on the first render after a symbol switch (before the useEffect fires).
  const stale = requestKey !== null && fetchedFor !== requestKey;
  return {
    bars:    stale ? [] : bars,
    loading: loading || stale,
    error:   stale ? null : error,
  };
}

interface AiDecideResult {
  decision: "BUY" | "SELL" | "NO_TRADE";
  confidence: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  riskReward: number;
  reasoning: string;
  marketBias: string;
  signalId: string | null;
  error?: string;
}

export default function ChartPage() {
  const { activeSymbol, setActiveSymbol } = useActiveSymbol();
  const queryClient = useQueryClient();
  const [timeframe, setTimeframe]         = useState<Timeframe>("5m");
  const [restSignals, setRestSignals]   = useState<SignalNew[]>([]);
  const [activeTrade, setActiveTrade]   = useState<ActiveTrade | null>(null);
  const [tradeResult, setTradeResult]   = useState<TradeResult | null>(null);
  const [refetchKey,  setRefetchKey]    = useState(0);
  const [generating,  setGenerating]    = useState(false);
  const signalFetchAbort = useRef<AbortController | null>(null);
  const [genMsg,      setGenMsg]        = useState<string | null>(null);
  const [devMock,     setDevMock]       = useState(false);
  const [deciding,    setDeciding]      = useState(false);
  const [aiResult,    setAiResult]      = useState<AiDecideResult | null>(null);

  const { bars, loading, error } = useHistoryBars(activeSymbol, timeframe);
  const { connected, lastPrice, isMarketOpen, realtimeAvailable, newSignals: wsSignals } = useMarketSocket(activeSymbol);

  // Fetch historical signals
  useEffect(() => {
    // Cancel any in-flight fetch for the previous symbol/timeframe to prevent
    // a slow NVDA response from overwriting TSLA's restSignals after a switch.
    signalFetchAbort.current?.abort();
    const ctrl = new AbortController();
    signalFetchAbort.current = ctrl;

    if (!activeSymbol) { setRestSignals([]); return; }

    // Immediately clear stale signals from the previous symbol so the panel
    // shows the loading skeleton instead of the old symbol's data.
    setRestSignals([]);

    const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
    // Fetch up to 3000 signals — the backtested engine generates 1k–3k signals
    // across full intraday history. Viewport culling in TradingChart keeps
    // rendering fast regardless of how many signals are loaded.
    fetch(
      `${base}/api/signals?symbol=${encodeURIComponent(activeSymbol)}&timeframe=${encodeURIComponent(timeframe)}&limit=3000`,
      { cache: "no-cache", signal: ctrl.signal }
    )
      .then((r) => r.json())
      .then((data: unknown) => {
        if (ctrl.signal.aborted) return;
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
      .catch((e) => { if ((e as Error).name !== "AbortError") setRestSignals([]); });
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

  const handleAiDecide = useCallback(async () => {
    if (!activeSymbol || deciding) return;
    setDeciding(true);
    setAiResult(null);
    const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
    try {
      const r = await fetch(`${base}/api/ai/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: activeSymbol, timeframe }),
      });
      const ct = r.headers.get("content-type") ?? "";
      if (!ct.includes("application/json")) {
        throw new Error(`Server returned ${ct || "non-JSON"} — is the API server running?`);
      }
      const data = await r.json() as AiDecideResult & { ok?: boolean; error?: string; hint?: string };
      if (!r.ok) {
        setAiResult({ decision: "NO_TRADE", confidence: 0, entry: 0, stopLoss: 0, takeProfit: 0, riskReward: 0, reasoning: "", marketBias: "NEUTRAL", signalId: null, error: data.error ?? data.hint ?? `HTTP ${r.status}` });
        return;
      }
      setAiResult(data);
      if (data.signalId) {
        // Refresh chart markers and the signal panel list
        setRefetchKey((k) => k + 1);
        queryClient.invalidateQueries({ queryKey: getListSignalsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetSignalStatsQueryKey() });
      }
    } catch (e) {
      setAiResult({ decision: "NO_TRADE", confidence: 0, entry: 0, stopLoss: 0, takeProfit: 0, riskReward: 0, reasoning: "", marketBias: "NEUTRAL", signalId: null, error: String(e) });
    } finally {
      setDeciding(false);
    }
  }, [activeSymbol, timeframe, deciding, queryClient]);

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

            <button
              onClick={handleAiDecide}
              disabled={deciding || !activeSymbol}
              className="flex items-center gap-1 px-2.5 py-0.5 rounded text-[11px] font-mono font-medium border border-primary/40 text-primary hover:border-primary/70 hover:bg-primary/10 transition-colors disabled:opacity-40"
              title="Ask Ollama to analyze current market conditions and decide BUY / SELL / NO_TRADE"
            >
              {deciding
                ? <><span className="inline-block w-2.5 h-2.5 border border-current border-t-transparent rounded-full animate-spin" /> Analyzing…</>
                : <><Brain size={11} /> AI Decide</>}
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

        {/* AI Decision Result Card */}
        {aiResult && (
          <div className={`flex-shrink-0 px-3 py-2 border-b border-white/5 flex items-start gap-2.5 text-[11px] ${
            aiResult.error ? "bg-red-500/5" :
            aiResult.decision === "BUY"      ? "bg-emerald-500/5" :
            aiResult.decision === "SELL"     ? "bg-red-500/5" :
            "bg-amber-500/5"
          }`}>
            {/* Decision badge */}
            <span className={`flex-shrink-0 font-mono font-bold text-[11px] px-1.5 py-0.5 rounded leading-none mt-0.5 ${
              aiResult.error           ? "bg-red-500/20 text-red-400" :
              aiResult.decision === "BUY"  ? "bg-emerald-500/20 text-emerald-400" :
              aiResult.decision === "SELL" ? "bg-red-500/20 text-red-400" :
              "bg-amber-500/20 text-amber-400"
            }`}>
              {aiResult.error ? "ERR" : aiResult.decision}
            </span>

            {/* Error message */}
            {aiResult.error && (
              <span className="text-red-400 flex-1 text-[10px] font-mono leading-snug">
                {aiResult.error.slice(0, 200)}
              </span>
            )}

            {/* Trade levels */}
            {!aiResult.error && aiResult.decision !== "NO_TRADE" && (
              <div className="flex-shrink-0 flex gap-2.5 font-mono text-[10px] items-baseline">
                <span className="text-muted-foreground">Entry <span className="text-foreground font-semibold">{aiResult.entry.toFixed(2)}</span></span>
                <span className="text-muted-foreground">SL <span className="text-red-400 font-semibold">{aiResult.stopLoss.toFixed(2)}</span></span>
                <span className="text-muted-foreground">TP <span className="text-emerald-400 font-semibold">{aiResult.takeProfit.toFixed(2)}</span></span>
                <span className="text-muted-foreground">RR <span className="text-foreground">{aiResult.riskReward.toFixed(2)}×</span></span>
                <span className={`font-semibold ${aiResult.confidence >= 80 ? "text-emerald-400" : aiResult.confidence >= 70 ? "text-amber-400" : "text-red-400"}`}>
                  {aiResult.confidence}%
                </span>
                <span className="text-muted-foreground/70 text-[9px]">{aiResult.marketBias}</span>
              </div>
            )}

            {/* Reasoning */}
            {!aiResult.error && (
              <span className="flex-1 text-muted-foreground leading-snug text-[10px] min-w-0">
                {aiResult.decision === "NO_TRADE"
                  ? <><span className="text-amber-400 font-medium">No trade: </span>{aiResult.reasoning}</>
                  : aiResult.reasoning
                }
              </span>
            )}

            {/* Signal Panel hint */}
            {!aiResult.error && aiResult.signalId && (
              <span className="flex-shrink-0 text-[9px] text-muted-foreground/60 italic leading-snug mt-0.5">
                → Signal Panel
              </span>
            )}

            {/* Dismiss */}
            <button
              onClick={() => setAiResult(null)}
              className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors mt-0.5"
            >
              <X size={11} />
            </button>
          </div>
        )}

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
            key={`${activeSymbol}-${timeframe}`}
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
