import { useState, useEffect, useRef, useCallback } from "react";
import { TrendingUp, TrendingDown } from "lucide-react";
import { WatchlistPanel } from "@/components/WatchlistPanel";
import { TradingChart } from "@/components/TradingChart";
import { SignalPanel } from "@/components/SignalPanel";
import { useMarketSocket, type SignalNew } from "@/hooks/useMarketSocket";
import { useBinanceSocket } from "@/hooks/useBinanceSocket";
import { useActiveSymbol } from "@/lib/ActiveSymbolContext";
import { subscribeReplayMarkers, getReplayState, clearReplayMarkers, type ReplayMarkerItem } from "@/lib/replayStore";
import { computeOpportunityScore, type OpportunityScore, type CachedMemoryContext } from "@/lib/live-opportunity";
import { useListSymbols } from "@workspace/api-client-react";

// ── Timeframe constants ───────────────────────────────────────────────────────

const STOCK_TIMEFRAMES  = ["5m", "15m"] as const;
type StockTf = (typeof STOCK_TIMEFRAMES)[number];

const CRYPTO_TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"] as const;
type CryptoTf = (typeof CRYPTO_TIMEFRAMES)[number];

type Timeframe = StockTf | CryptoTf;

const TF_SECONDS: Record<string, number> = {
  "1m": 60, "5m": 300, "15m": 900, "30m": 1800,
  "1h": 3600, "4h": 14400, "1d": 86400,
};

// ── Crypto symbols ────────────────────────────────────────────────────────────

const CRYPTO_SYMBOLS = [
  { symbol: "BTCUSDT",   name: "Bitcoin"   },
  { symbol: "ETHUSDT",   name: "Ethereum"  },
  { symbol: "SOLUSDT",   name: "Solana"    },
  { symbol: "BNBUSDT",   name: "BNB"       },
  { symbol: "XRPUSDT",   name: "XRP"       },
  { symbol: "ADAUSDT",   name: "Cardano"   },
  { symbol: "DOGEUSDT",  name: "Dogecoin"  },
  { symbol: "AVAXUSDT",  name: "Avalanche" },
  { symbol: "DOTUSDT",   name: "Polkadot"  },
  { symbol: "MATICUSDT", name: "Polygon"   },
] as const;

type MarketType = "stocks" | "crypto";

// ── Types ─────────────────────────────────────────────────────────────────────

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

export interface ResolvedAiDecision {
  candleTime:    number;
  candidateSide: "long" | "short" | "no_trade";
  outcome:       "tp_hit" | "sl_hit" | "expired";
  confidence:    number;
}

export interface AiCandleDecision {
  symbol:            string;
  timeframe:         string;
  candleTime:        number;
  candidateSide:     "long" | "short" | "no_trade";
  verdict:           "APPROVE" | "REJECT" | "WAIT";
  confidence:        number;
  entryPrice:        number | null;
  slPrice:           number | null;
  tpPrice:           number | null;
  invalidationLevel: number | null;
  rrRatio:           number | null;
  aiReasoning:       string;
  rejectionReason:   string | null;
  newsSentiment:     "bullish" | "bearish" | "neutral";
  newsSummary:       string;
  regime:            string;
  htfBias:           string;
  session:           string;
  patterns:          string[];
  strengths:         string[];
  weaknesses:        string[];
  marketBias:        "bullish" | "bearish" | "neutral";
  technicalContext:  Record<string, unknown>;
  memoryUsed?:           boolean;
  lessonsLoaded?:        number;
  winnerAnalysisLoaded?: boolean;
  failureStatsLoaded?:   boolean;
  recentLossLoaded?:     boolean;
  memoryImpactScore?:    number;
}

export interface TradeHealthBreakdown {
  emaTrend: number; momentum: number; volume: number;
  priceProgress: number; patternIntegrity: number; memoryAlignment: number;
  historicalSimilarity: number; regimeAlignment: number;
}
export interface TradeHealth {
  score:             number;
  breakdown:         TradeHealthBreakdown;
  direction:         "improving" | "deteriorating" | "neutral";
  summary:           string;
  grade:             "A" | "B" | "C" | "D";
  memoryImpactScore: number;
}

// ── History hook ─────────────────────────────────────────────────────────────

function useHistoryBars(
  symbol:   string | null,
  interval: string,
  endpoint  = "/api/history",
) {
  const [bars,       setBars]      = useState<OhlcvBar[]>([]);
  const [loading,    setLoad]      = useState(false);
  const [error,      setError]     = useState<string | null>(null);
  const [fetchedFor, setFetchedFor] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const requestKey = symbol ? `${endpoint}:${symbol}:${interval}` : null;

  useEffect(() => {
    if (!symbol) {
      setBars([]); setLoad(false); setError(null); setFetchedFor(null);
      return;
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBars([]); setLoad(true); setError(null);

    const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
    fetch(
      `${base}${endpoint}?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`,
      { signal: ctrl.signal, cache: "no-cache" },
    )
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<OhlcvBar[]>; })
      .then((d) => {
        if (ctrl.signal.aborted) return;
        setBars(Array.isArray(d) ? d : []);
        setLoad(false);
        setFetchedFor(requestKey);
      })
      .catch((e) => {
        if (e.name === "AbortError") return;
        setError(e.message);
        setLoad(false);
      });

    return () => ctrl.abort();
  }, [symbol, interval, endpoint, requestKey]);

  const stale = requestKey !== null && fetchedFor !== requestKey;
  return {
    bars:    stale ? [] : bars,
    loading: loading || stale,
    error:   stale ? null : error,
  };
}

// ── Crypto symbol panel ───────────────────────────────────────────────────────

function CryptoSymbolPanel({
  activeSymbol, onSelect, connected, livePrice,
}: {
  activeSymbol: string;
  onSelect:     (s: string) => void;
  connected:    boolean;
  livePrice:    number | null;
}) {
  return (
    <div className="flex flex-col h-full bg-background border-r border-white/5 select-none">
      <div className="px-3 py-2 border-b border-white/5 flex items-center gap-1.5">
        <TrendingUp size={12} className="text-amber-400" />
        <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Crypto</span>
        <span className={`ml-auto w-1.5 h-1.5 rounded-full ${connected ? "bg-emerald-400" : "bg-muted-foreground/40"}`} />
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {CRYPTO_SYMBOLS.map(({ symbol, name }) => (
          <button
            key={symbol}
            onClick={() => onSelect(symbol)}
            className={`w-full text-left px-3 py-2 transition-colors text-[11px] ${
              symbol === activeSymbol
                ? "bg-primary/10 text-foreground"
                : "text-muted-foreground hover:bg-white/4 hover:text-foreground"
            }`}
          >
            <div className="font-semibold font-mono">
              {symbol.replace("USDT", "")}
              <span className="text-muted-foreground/50">/USDT</span>
            </div>
            <div className="flex items-center justify-between mt-0.5">
              <span className="text-[10px] text-muted-foreground/60">{name}</span>
              {symbol === activeSymbol && livePrice != null && (
                <span className="text-[10px] font-mono text-amber-400">
                  {livePrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Crypto live panel (right sidebar when in crypto mode) ─────────────────────

function CryptoLivePanel({
  symbol, connected, livePrice, realtimeAvailable,
}: {
  symbol:             string;
  connected:          boolean;
  livePrice:          number | null;
  realtimeAvailable:  boolean;
}) {
  return (
    <div className="flex flex-col h-full bg-background border-l border-white/5 select-none p-3 gap-3">
      <div className="flex items-center gap-1.5">
        <TrendingDown size={12} className="text-amber-400" />
        <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Live</span>
        <span className={`ml-auto w-1.5 h-1.5 rounded-full ${connected ? "bg-emerald-400 animate-pulse" : "bg-muted-foreground/40"}`} />
      </div>

      <div className="bg-card border border-white/8 rounded p-3 text-center">
        <div className="text-[10px] text-muted-foreground mb-1">{symbol}</div>
        {livePrice != null ? (
          <div className="text-lg font-mono font-bold text-amber-400">
            {livePrice.toLocaleString("en-US", {
              minimumFractionDigits: symbol.startsWith("BTC") ? 2 : 4,
              maximumFractionDigits: symbol.startsWith("BTC") ? 2 : 4,
            })}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground/40">Connecting…</div>
        )}
      </div>

      {!realtimeAvailable && (
        <div className="text-[10px] text-amber-400/80 text-center">
          WS unavailable — reload to retry
        </div>
      )}

      <div className="flex-1 flex items-end">
        <div className="w-full text-[9px] text-muted-foreground/50 text-center">
          Binance · 24/7 · No signals
        </div>
      </div>
    </div>
  );
}

// ── ActiveTradePanel ──────────────────────────────────────────────────────────

function ActiveTradePanel({
  decision, health, currentPrice,
}: { decision: AiCandleDecision; health: TradeHealth; currentPrice?: number }) {
  const isLong     = decision.candidateSide === "long";
  const col        = isLong ? "#00ff88" : "#ff3346";
  const scoreColor = health.score >= 70 ? "#00ff88" : health.score >= 45 ? "#f59e0b" : "#ef5350";
  const gradeColor = health.grade === "A" ? "#00ff88" : health.grade === "B" ? "#22d3ee" :
                     health.grade === "C" ? "#f59e0b" : "#ef5350";
  const dirIcon  = health.direction === "improving" ? "↑" : health.direction === "deteriorating" ? "↓" : "→";
  const dirColor = health.direction === "improving" ? "#00ff88" : health.direction === "deteriorating" ? "#ef5350" : "#6b7280";

  const entry = decision.entryPrice ?? 0;
  const sl    = decision.slPrice    ?? 0;
  const tp    = decision.tpPrice    ?? 0;
  const risk  = Math.abs(entry - sl);

  const liveRR = currentPrice != null && risk > 0
    ? (isLong ? (currentPrice - entry) / risk : (entry - currentPrice) / risk)
    : null;
  const pnlPct = currentPrice != null && entry > 0
    ? (isLong ? (currentPrice - entry) / entry : (entry - currentPrice) / entry) * 100
    : null;
  const liveRRColor = liveRR == null ? "#6b7280" : liveRR >= 1 ? "#00ff88" : liveRR >= 0 ? "#f59e0b" : "#ef5350";
  const pnlColor    = pnlPct == null ? "#6b7280" : pnlPct >= 0 ? "#00ff88" : "#ef5350";

  const fmt = (v: number) => v.toFixed(2);

  const dims = [
    { label: "EMA",    val: health.breakdown.emaTrend,             max: 20 },
    { label: "RSI",    val: health.breakdown.momentum,             max: 15 },
    { label: "Vol",    val: health.breakdown.volume,               max: 10 },
    { label: "Prog",   val: health.breakdown.priceProgress,        max: 20 },
    { label: "Setup",  val: health.breakdown.patternIntegrity,     max: 10 },
    { label: "Mem",    val: health.breakdown.memoryAlignment,      max: 10 },
    { label: "Hist",   val: health.breakdown.historicalSimilarity, max: 10 },
    { label: "Regime", val: health.breakdown.regimeAlignment,      max: 5  },
  ];

  const reasoning = decision.aiReasoning?.trim() ?? "";
  const reasoningSnip = reasoning.length > 90 ? reasoning.slice(0, 87) + "…" : reasoning;

  return (
    <div className="border-t border-white/5 p-2.5 flex flex-col gap-1.5 bg-[#0b0e14] select-none flex-shrink-0">
      {/* ── Header: score + grade + direction ── */}
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/60 font-mono">
          Trade Health
        </span>
        <div className="flex items-center gap-1.5">
          <span style={{ color: dirColor }} className="text-[10px] font-bold">{dirIcon}</span>
          <span style={{ color: gradeColor }}
            className="text-[9px] font-black font-mono border px-1 rounded"
            title="Grade">
            {health.grade}
          </span>
          <span style={{ color: scoreColor }} className="text-[17px] font-black font-mono leading-none">
            {health.score}
          </span>
          <span className="text-[9px] text-muted-foreground/40 font-mono">/100</span>
        </div>
      </div>

      {/* ── Score bar ── */}
      <div className="w-full h-1 bg-white/5 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500"
          style={{ width: `${health.score}%`, background: scoreColor }} />
      </div>

      {/* ── Entry / SL / TP ── */}
      <div className="grid grid-cols-3 gap-x-1 text-[8px] font-mono">
        <div className="flex flex-col"><span className="text-muted-foreground/40">Entry</span><span className="text-white/70">${fmt(entry)}</span></div>
        <div className="flex flex-col"><span className="text-muted-foreground/40">SL</span><span className="text-[#ef5350]">${fmt(sl)}</span></div>
        <div className="flex flex-col"><span className="text-muted-foreground/40">TP</span><span className="text-[#00ff88]">${fmt(tp)}</span></div>
      </div>

      {/* ── Current Price / Live R:R / P&L ── */}
      <div className="grid grid-cols-3 gap-x-1 text-[8px] font-mono border-t border-white/5 pt-1">
        <div className="flex flex-col">
          <span className="text-muted-foreground/40">Current</span>
          <span className="text-white/70">{currentPrice != null ? `$${fmt(currentPrice)}` : "—"}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-muted-foreground/40">Live R:R</span>
          <span style={{ color: liveRRColor }}>{liveRR != null ? `${liveRR.toFixed(2)}x` : "—"}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-muted-foreground/40">P&amp;L</span>
          <span style={{ color: pnlColor }}>{pnlPct != null ? `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%` : "—"}</span>
        </div>
      </div>

      {/* ── Memory impact score ── */}
      <div className="flex items-center gap-1.5 text-[8px] font-mono border-t border-white/5 pt-1">
        <span className="text-muted-foreground/40">Mem Impact</span>
        <div className="flex-1 h-[2px] bg-white/5 rounded-full overflow-hidden">
          <div className="h-full rounded-full"
            style={{ width: `${health.memoryImpactScore}%`,
              background: health.memoryImpactScore >= 70 ? "#00ff88" : health.memoryImpactScore >= 40 ? "#f59e0b" : "#ef5350" }} />
        </div>
        <span style={{ color: health.memoryImpactScore >= 70 ? "#00ff88" : health.memoryImpactScore >= 40 ? "#f59e0b" : "#ef5350" }}>
          {Math.round(health.memoryImpactScore)}%
        </span>
      </div>

      {/* ── 8 dimension mini-bars ── */}
      <div className="flex flex-col gap-[3px]">
        {dims.map(({ label, val, max }) => {
          const pct    = max > 0 ? val / max : 0;
          const dimCol = pct >= 0.7 ? "#00ff88" : pct >= 0.4 ? "#f59e0b" : "#ef5350";
          return (
            <div key={label} className="flex items-center gap-1.5">
              <span className="text-[7px] font-mono text-muted-foreground/40 w-9 flex-shrink-0">{label}</span>
              <div className="flex-1 h-[2px] bg-white/5 rounded-full overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${pct * 100}%`, background: dimCol }} />
              </div>
              <span className="text-[7px] font-mono text-muted-foreground/40 w-4 text-right">{val}</span>
            </div>
          );
        })}
      </div>

      {/* ── Health summary ── */}
      <div className="text-[7.5px] text-muted-foreground/50 leading-relaxed font-mono border-t border-white/5 pt-1">
        {health.summary}
      </div>

      {/* ── AI reasoning snippet ── */}
      {reasoningSnip && (
        <div className="text-[7.5px] text-muted-foreground/40 leading-relaxed font-mono italic line-clamp-2"
          title={reasoning}>
          "{reasoningSnip}"
        </div>
      )}

      {/* ── Footer: direction + entry R:R + confidence ── */}
      <div className="flex items-center gap-1.5 text-[8px] font-mono border-t border-white/5 pt-1">
        <span style={{ color: col }} className="font-bold">{isLong ? "▲ LONG" : "▼ SHORT"}</span>
        <span className="text-muted-foreground/30">·</span>
        <span className="text-muted-foreground/50">R:R {decision.rrRatio?.toFixed(1) ?? "—"}</span>
        <span className="text-muted-foreground/30">·</span>
        <span className="text-muted-foreground/50">{decision.confidence}% conf</span>
      </div>
    </div>
  );
}

// ── ChartPage ─────────────────────────────────────────────────────────────────

export default function ChartPage() {
  const { activeSymbol, setActiveSymbol } = useActiveSymbol();

  // ── Market type state (persisted) ──────────────────────────────────────────
  const [marketType, setMarketTypeRaw] = useState<MarketType>(() => {
    try { return (localStorage.getItem("signal-market-type") as MarketType | null) ?? "stocks"; }
    catch { return "stocks"; }
  });
  const setMarketType = useCallback((m: MarketType) => {
    setMarketTypeRaw(m);
    try { localStorage.setItem("signal-market-type", m); } catch {}
  }, []);

  const [cryptoSymbol, setCryptoSymbolRaw] = useState<string>(() => {
    try { return localStorage.getItem("signal-crypto-symbol") ?? "BTCUSDT"; }
    catch { return "BTCUSDT"; }
  });
  const setCryptoSymbol = useCallback((s: string) => {
    setCryptoSymbolRaw(s);
    try { localStorage.setItem("signal-crypto-symbol", s); } catch {}
  }, []);

  // ── Timeframes ────────────────────────────────────────────────────────────
  const [stockTf,  setStockTf]  = useState<StockTf>("5m");
  const [cryptoTf, setCryptoTf] = useState<CryptoTf>("5m");

  // ── Stock-specific state ──────────────────────────────────────────────────
  const [restSignals,    setRestSignals]    = useState<SignalNew[]>([]);
  const [activeTrade,    setActiveTrade]    = useState<ActiveTrade | null>(null);
  const [tradeResult,    setTradeResult]    = useState<TradeResult | null>(null);
  const signalFetchAbort = useRef<AbortController | null>(null);
  const [aiDecisions,       setAiDecisions]       = useState<AiCandleDecision[]>([]);
  const [aiAnalyzing,       setAiAnalyzing]       = useState(false);
  const [latestApproved,    setLatestApproved]    = useState<AiCandleDecision | null>(null);
  const [tradeHealth,       setTradeHealth]       = useState<TradeHealth | null>(null);
  const [resolvedDecisions, setResolvedDecisions] = useState<ResolvedAiDecision[]>([]);
  const [replayMarkers,     setReplayMarkers]     = useState<ReplayMarkerItem[]>(() => getReplayState().markers);

  const [liveModeEnabled, setLiveModeEnabled] = useState(() => {
    try { return localStorage.getItem("live-mode") === "true"; } catch { return false; }
  });
  const [liveOpportunity, setLiveOpportunity] = useState<OpportunityScore | null>(null);
  const [livePanelOpen, setLivePanelOpen]     = useState(true);
  const [watchlistOpps, setWatchlistOpps]     = useState<Record<string, OpportunityScore>>({});
  const memCtxRef        = useRef<CachedMemoryContext | null>(null);
  const memFetchedSymRef = useRef<string | null>(null);
  const liveEvalLastRef  = useRef<number>(0);
  const wlFetchingRef    = useRef(false);

  const { data: rawSymbolList } = useListSymbols();
  const watchlistSymbols: string[] = Array.isArray(rawSymbolList)
    ? (rawSymbolList as { symbol?: string; name?: string }[]).map(s => s.symbol ?? "").filter(Boolean)
    : [];

  // Subscribe to replayStore updates (fired when AiMemoryPage completes a replay job)
  useEffect(() => {
    return subscribeReplayMarkers((_key, markers) => setReplayMarkers(markers));
  }, []);

  // Clear replay markers only when activeSymbol *changes* to a different symbol.
  // Using a ref so initial mount does NOT clear markers that were set before navigating here.
  const prevSymbolRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (prevSymbolRef.current !== undefined && prevSymbolRef.current !== activeSymbol) {
      clearReplayMarkers();
    }
    prevSymbolRef.current = activeSymbol;
  }, [activeSymbol]);

  const isStocks = marketType === "stocks";
  const isCrypto = marketType === "crypto";

  // ── History (both always mounted, null symbol disables the inactive one) ──
  const { bars: stockBars, loading: stockLoading, error: stockError } = useHistoryBars(
    isStocks ? activeSymbol : null,
    stockTf,
    "/api/history",
  );
  const { bars: cryptoBars, loading: cryptoLoading, error: cryptoError } = useHistoryBars(
    isCrypto ? cryptoSymbol : null,
    cryptoTf,
    "/api/crypto/history",
  );

  const bars    = isStocks ? stockBars    : cryptoBars;
  const loading = isStocks ? stockLoading : cryptoLoading;
  const error   = isStocks ? stockError   : cryptoError;

  // ── Sockets (both always mounted, null symbol disables the inactive one) ──
  const stockSocket  = useMarketSocket(isStocks ? activeSymbol : null);
  const binanceSocket = useBinanceSocket(isCrypto ? cryptoSymbol : null, cryptoTf);

  const connected          = isStocks ? stockSocket.connected         : binanceSocket.connected;
  const lastPrice          = isStocks ? stockSocket.lastPrice         : binanceSocket.lastPrice;
  const isMarketOpen       = isStocks ? stockSocket.isMarketOpen      : true;
  const realtimeAvailable  = isStocks ? stockSocket.realtimeAvailable : binanceSocket.realtimeAvailable;
  const wsSignals          = isStocks ? stockSocket.newSignals        : [];
  const cryptoLiveBar      = isCrypto ? binanceSocket.liveBar         : null;

  // Effective display values
  const displaySymbol      = isStocks ? (activeSymbol ?? "") : cryptoSymbol;
  const displayTimeframe   = isStocks ? stockTf : cryptoTf;
  const displayIntervalSec = TF_SECONDS[displayTimeframe] ?? 300;

  // ── Stock-only: fetch historical signals ──────────────────────────────────
  useEffect(() => {
    if (!isStocks) { setRestSignals([]); return; }
    signalFetchAbort.current?.abort();
    const ctrl = new AbortController();
    signalFetchAbort.current = ctrl;

    if (!activeSymbol) { setRestSignals([]); return; }
    setRestSignals([]);

    const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
    fetch(
      `${base}/api/signals?symbol=${encodeURIComponent(activeSymbol)}&timeframe=${encodeURIComponent(stockTf)}&limit=3000`,
      { cache: "no-cache", signal: ctrl.signal },
    )
      .then((r) => r.json())
      .then((data: unknown) => {
        if (ctrl.signal.aborted) return;
        if (!Array.isArray(data)) { setRestSignals([]); return; }
        const mapped: SignalNew[] = (data as Record<string, unknown>[]).map((s) => {
          const meta = (s.metadata ?? {}) as Record<string, unknown>;
          const isAi = s.regime === "ai_generated" ||
                       meta.aiDecision === true ||
                       String(s.signalId ?? "").startsWith("AI");
          return {
            type:        "signal.new" as const,
            signalId:    String(s.signalId),
            symbol:      String(s.symbol),
            side:        (s.side as string) === "long" ? ("long" as const) : ("short" as const),
            entryPrice:  Number(s.entryPrice),
            slPrice:     Number(s.slPrice),
            tpPrice:     Number(s.tpPrice),
            confidence:  Number(s.confidence),
            riskTag:     String(s.riskTag),
            barTime:     new Date(String(s.barTime)).toISOString(),
            grade:       s.grade as ("A+" | "A" | "B" | "Weak") | undefined,
            patterns:    Array.isArray(s.patterns) ? (s.patterns as string[]) : undefined,
            state:       (s.state as SignalNew["state"]) ?? "active",
            exitPrice:   s.exitPrice  == null ? null : Number(s.exitPrice),
            exitBarTime: s.exitBarTime == null ? null : new Date(String(s.exitBarTime)).toISOString(),
            exitReason:  s.exitReason  == null ? null : String(s.exitReason),
            isAiSignal:   isAi || undefined,
            aiReasoning:  typeof meta.reasoning  === "string" ? meta.reasoning  : undefined,
            aiMarketBias: typeof meta.marketBias === "string" ? meta.marketBias : undefined,
          };
        });
        setRestSignals(mapped);
      })
      .catch((e) => { if ((e as Error).name !== "AbortError") setRestSignals([]); });
  }, [activeSymbol, stockTf, isStocks]);

  // ── Clear active trade + AI decisions on symbol/timeframe switch ─────────────────────────
  useEffect(() => {
    setActiveTrade(null);
    setTradeResult(null);
    setAiDecisions([]);
    setAiAnalyzing(false);
    setLatestApproved(null);
    setTradeHealth(null);
  }, [activeSymbol, stockTf]);

  // ── Load latest APPROVED AI decision from DB ─────────────────────────────
  useEffect(() => {
    if (!isStocks || !activeSymbol) { setLatestApproved(null); return; }
    const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
    fetch(`${base}/api/signals/ai-active?symbol=${encodeURIComponent(activeSymbol)}&timeframe=${encodeURIComponent(stockTf)}`)
      .then(r => r.ok ? r.json() : null)
      .then((data: { ok: boolean; decision: AiCandleDecision | null } | null) => {
        setLatestApproved(data?.decision ?? null);
      })
      .catch(() => {});
  }, [activeSymbol, stockTf, isStocks]);

  // ── Fetch trade health score whenever the active approved decision changes ─
  useEffect(() => {
    if (!latestApproved || !activeSymbol || !isStocks) { setTradeHealth(null); return; }
    const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
    fetch(`${base}/api/signals/ai-active/health?symbol=${encodeURIComponent(activeSymbol)}&timeframe=${encodeURIComponent(stockTf)}`)
      .then(r => r.ok ? r.json() : null)
      .then((data: { ok: boolean; health: TradeHealth | null } | null) => {
        setTradeHealth(data?.health ?? null);
      })
      .catch(() => {});
  }, [latestApproved, activeSymbol, stockTf, isStocks]);

  // ── Load resolved AI decision history from DB ─────────────────────────────
  useEffect(() => {
    if (!isStocks || !activeSymbol) { setResolvedDecisions([]); return; }
    const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
    fetch(`${base}/api/signals/ai-decisions-history?symbol=${encodeURIComponent(activeSymbol)}&timeframe=${encodeURIComponent(stockTf)}`)
      .then(r => r.ok ? r.json() : null)
      .then((data: { ok: boolean; decisions: ResolvedAiDecision[] } | null) => {
        setResolvedDecisions(data?.decisions ?? []);
      })
      .catch(() => {});
  }, [activeSymbol, stockTf, isStocks]);

  // ── Live opportunity: clear immediately on context changes ────────────────
  // Prevents stale pre-signal overlays when the user switches symbol/tf/market-type.
  const prevLiveCtxRef = useRef({ symbol: "", tf: "", isStocks: true });
  useEffect(() => {
    const prev = prevLiveCtxRef.current;
    if (prev.symbol !== (activeSymbol ?? "") || prev.tf !== stockTf || prev.isStocks !== isStocks) {
      setLiveOpportunity(null);
      setWatchlistOpps({});
      memFetchedSymRef.current = null;
      liveEvalLastRef.current  = 0;
      prevLiveCtxRef.current = { symbol: activeSymbol ?? "", tf: stockTf, isStocks };
    }
  }, [activeSymbol, stockTf, isStocks]);

  // ── Live opportunity: cache memory context per symbol (direction-aware) ───
  useEffect(() => {
    if (!liveModeEnabled || !isStocks || !activeSymbol) return;
    if (memFetchedSymRef.current === activeSymbol) return;
    const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
    // Fetch overall symbol stats + trade-level data for per-direction win rates
    Promise.all([
      fetch(`${base}/api/ai/memory`).then(r => r.ok ? r.json() : null),
      fetch(`${base}/api/ai/memory/trades?symbol=${encodeURIComponent(activeSymbol)}&limit=100`).then(r => r.ok ? r.json() : null),
    ]).then(([memData, tradesData]: [
      { symbolStats?: Record<string, { wins: number; losses: number; total: number }> } | null,
      { trades?: { direction?: string; outcome?: string }[] } | null,
    ]) => {
      if (!activeSymbol) return;
      const sym    = memData?.symbolStats?.[activeSymbol];
      const trades = tradesData?.trades ?? [];

      // Compute per-direction win rates from trade history
      const dirStats: Record<string, { wins: number; total: number }> = {};
      for (const t of trades) {
        const dir = t.direction?.toUpperCase();
        if (dir !== "LONG" && dir !== "SHORT") continue;
        if (!dirStats[dir]) dirStats[dir] = { wins: 0, total: 0 };
        dirStats[dir].total++;
        if (t.outcome === "win" || t.outcome === "tp_hit") dirStats[dir].wins++;
      }
      const calcWR = (d: string) => {
        const s = dirStats[d];
        return s && s.total >= 5 ? s.wins / s.total : null;
      };

      memCtxRef.current = {
        symbol:    activeSymbol,
        winRate:   sym && sym.total >= 5 ? sym.wins / sym.total : null,
        fetchedAt: Date.now(),
        directionWinRate: { LONG: calcWR("LONG"), SHORT: calcWR("SHORT") },
      };
      memFetchedSymRef.current = activeSymbol;
    }).catch(() => {});
  }, [liveModeEnabled, isStocks, activeSymbol]);

  // ── Live opportunity: evaluate on price ticks (throttled to 15 s) ─────────
  useEffect(() => {
    if (!liveModeEnabled || !isStocks || !isMarketOpen || !activeSymbol || !lastPrice) {
      // Clear stale opportunity whenever any precondition fails
      setLiveOpportunity(null);
      return;
    }
    const now = Date.now();
    if (now - liveEvalLastRef.current < 15_000) return;
    liveEvalLastRef.current = now;
    if (bars.length < 55) return;
    const score = computeOpportunityScore(bars, lastPrice.price, memCtxRef.current);
    // Always set the full score (including below-threshold) for the always-on badge display.
    // The pre-signal chart marker checks score >= 65 independently.
    setLiveOpportunity(score);
  }, [lastPrice, liveModeEnabled, isStocks, isMarketOpen, activeSymbol, bars]);

  // ── Live opportunity: score all watchlist symbols (background, staggered) ─
  // Fetches the last 62 bars from server cache and computes indicator scores
  // for each non-active symbol. Results are ranked in the Live Setup panel.
  useEffect(() => {
    if (!liveModeEnabled || !isStocks || !isMarketOpen) return;
    if (watchlistSymbols.length <= 1 || wlFetchingRef.current) return;
    const otherSymbols = watchlistSymbols.filter(s => s !== activeSymbol);
    if (otherSymbols.length === 0) return;

    wlFetchingRef.current = true;
    const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
    const tf   = stockTf;

    (async () => {
      for (let idx = 0; idx < otherSymbols.length; idx++) {
        const sym = otherSymbols[idx];
        if (idx > 0) await new Promise(r => setTimeout(r, 4000)); // stagger to avoid 429
        try {
          const resp = await fetch(`${base}/api/history?symbol=${encodeURIComponent(sym)}&interval=${tf}`);
          if (!resp.ok) continue;
          const data = await resp.json() as { bars?: { time: number; open: number; high: number; low: number; close: number; volume: number }[] };
          const barsArr = data.bars ?? [];
          if (barsArr.length < 55) continue;
          const latestPrice = barsArr[barsArr.length - 1].close;
          const opp = computeOpportunityScore(barsArr, latestPrice);
          setWatchlistOpps(prev => ({ ...prev, [sym]: opp }));
        } catch { /* skip */ }
      }
      wlFetchingRef.current = false;
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveModeEnabled, isStocks, isMarketOpen, watchlistSymbols.join(","), activeSymbol, stockTf]);

  // ── Candle-close AI pipeline ───────────────────────────────────────────────
  const handleCandleClose = useCallback(async (barTime: number) => {
    if (!isStocks || !activeSymbol || aiAnalyzing) return;
    setLiveOpportunity(null);
    setAiAnalyzing(true);
    const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
    try {
      const res = await fetch(`${base}/api/signals/candle-decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: activeSymbol, timeframe: stockTf, candleTime: barTime }),
      });
      if (!res.ok) return;
      const dec = await res.json() as AiCandleDecision;
      setAiDecisions((prev) => {
        const filtered = prev.filter((d) => d.candleTime !== dec.candleTime);
        return [dec, ...filtered].slice(0, 50);
      });
      // Refresh active approved decision overlay if this candle triggered an approval
      if (dec.verdict === "APPROVE") {
        fetch(`${base}/api/signals/ai-active?symbol=${encodeURIComponent(activeSymbol)}&timeframe=${encodeURIComponent(stockTf)}`)
          .then(r => r.ok ? r.json() : null)
          .then((data: { ok: boolean; decision: AiCandleDecision | null } | null) => {
            setLatestApproved(data?.decision ?? null);
          })
          .catch(() => {});
      }
      // Re-fetch resolved decision markers so newly resolved outcomes appear on the chart
      fetch(`${base}/api/signals/ai-decisions-history?symbol=${encodeURIComponent(activeSymbol)}&timeframe=${encodeURIComponent(stockTf)}`)
        .then(r => r.ok ? r.json() : null)
        .then((data: { ok: boolean; decisions: ResolvedAiDecision[] } | null) => {
          setResolvedDecisions(data?.decisions ?? []);
        })
        .catch(() => {});
      // Refresh health score on every candle close while a trade is active
      fetch(`${base}/api/signals/ai-active/health?symbol=${encodeURIComponent(activeSymbol)}&timeframe=${encodeURIComponent(stockTf)}`)
        .then(r => r.ok ? r.json() : null)
        .then((data: { ok: boolean; health: TradeHealth | null } | null) => {
          setTradeHealth(data?.health ?? null);
        })
        .catch(() => {});
    } catch {
      // never break the chart
    } finally {
      setAiAnalyzing(false);
    }
  }, [isStocks, activeSymbol, stockTf, aiAnalyzing]);

  // ── Auto-exit: watch live price for SL/TP hits ────────────────────────────
  const resultTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!activeTrade || !lastPrice) return;
    if (lastPrice.symbol !== activeTrade.symbol) return;

    const { side, slPrice, tpPrice } = activeTrade;
    const price = lastPrice.price;
    const tpHit = side === "long" ? price >= tpPrice : price <= tpPrice;
    const slHit = side === "long" ? price <= slPrice : price >= slPrice;
    if (!tpHit && !slHit) return;

    const outcome   = tpHit ? "tp_hit" : "sl_hit";
    const exitPrice = tpHit ? tpPrice  : slPrice;
    setTradeResult({ outcome, exitPrice, exitTime: lastPrice.timestamp });
    setActiveTrade(null);

    const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
    fetch(`${base}/api/signals/${encodeURIComponent(activeTrade.signalId)}/state`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: outcome, exitPrice }),
    }).catch(() => {});

    if (resultTimerRef.current) clearTimeout(resultTimerRef.current);
    resultTimerRef.current = setTimeout(() => setTradeResult(null), 6000);
  }, [lastPrice, activeTrade]);

  // ── Live-tick auto-exit: watch lastPrice against latestApproved AI decision ──
  useEffect(() => {
    if (!latestApproved || !lastPrice || !activeSymbol || !isStocks) return;
    if (lastPrice.symbol !== latestApproved.symbol) return;

    const { candidateSide, entryPrice, slPrice, tpPrice } = latestApproved;
    if (entryPrice == null || slPrice == null || tpPrice == null) return;

    const price  = lastPrice.price;
    const isLong = candidateSide === "long";
    const tpHit  = isLong ? price >= tpPrice : price <= tpPrice;
    const slHit  = isLong ? price <= slPrice  : price >= slPrice;
    if (!tpHit && !slHit) return;

    const outcome      = tpHit ? "tp_hit" as const : "sl_hit" as const;
    const outcomePrice = tpHit ? tpPrice : slPrice;

    // Immediately remove from active display to prevent duplicate calls
    setLatestApproved(null);

    const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
    // Resolve in DB and fire reflection (fire-and-forget from frontend perspective)
    fetch(`${base}/api/signals/ai-active/resolve`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: activeSymbol, timeframe: stockTf, outcome, outcomePrice }),
    })
      .then(() => new Promise<void>((r) => setTimeout(r, 800)))
      .then(() =>
        fetch(
          `${base}/api/signals/ai-decisions-history?symbol=${encodeURIComponent(activeSymbol)}&timeframe=${encodeURIComponent(stockTf)}`,
        ),
      )
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { ok: boolean; decisions: ResolvedAiDecision[] } | null) => {
        setResolvedDecisions(data?.decisions ?? []);
      })
      .catch(() => {});
  }, [lastPrice, latestApproved, activeSymbol, stockTf, isStocks]);

  const handleActivateTrade = useCallback((trade: ActiveTrade) => {
    if (activeTrade) return;
    setTradeResult(null);
    setActiveTrade(trade);
  }, [activeTrade]);

  const handleCloseTrade = useCallback(() => {
    if (!activeTrade) return;
    setActiveTrade(null);
    const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
    fetch(`${base}/api/signals/${encodeURIComponent(activeTrade.signalId)}/state`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "expired" }),
    }).catch(() => {});
  }, [activeTrade]);

  // ── DEV logging ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    console.groupCollapsed(
      `%c[TradingPipeline] ${displaySymbol ?? "–"} ${displayTimeframe} | bars=${bars.length} rest=${restSignals.length} ws=${wsSignals.length}`,
      "color:#22d3ee;font-weight:bold",
    );
    console.log("WS connected:", connected, "| isMarketOpen:", isMarketOpen, "| realtimeAvailable:", realtimeAvailable);
    console.groupEnd();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars.length, restSignals.length, wsSignals.length, connected]);

  // All historical signals → compact marker layer; no split needed.
  const allSignals = [...wsSignals, ...restSignals]
    .filter((sig) => !activeSymbol || sig.symbol === activeSymbol)
    .filter((sig, idx, arr) => arr.findIndex((s) => s.signalId === sig.signalId) === idx);

  const livePrice = lastPrice?.price ?? null;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full" data-testid="chart-page">

      {/* ── Left panel ── */}
      <div className="w-44 flex-shrink-0">
        {isStocks
          ? <WatchlistPanel activeSymbol={activeSymbol} onSelectSymbol={setActiveSymbol} connected={connected} />
          : <CryptoSymbolPanel activeSymbol={cryptoSymbol} onSelect={setCryptoSymbol} connected={connected} livePrice={livePrice} />
        }
      </div>

      <div className="flex-1 flex flex-col min-w-0 bg-[#0b0e14]">

        {/* ── Toolbar ── */}
        <div className="flex items-center gap-0.5 px-3 py-1.5 border-b border-white/5 flex-shrink-0">

          {/* Market type toggle */}
          <div className="flex items-center mr-2 border border-white/10 rounded overflow-hidden">
            <button
              onClick={() => setMarketType("stocks")}
              className={`px-2.5 py-0.5 text-[11px] font-mono font-medium transition-colors ${
                isStocks
                  ? "bg-sky-500/20 text-sky-400"
                  : "text-muted-foreground hover:text-foreground hover:bg-white/5"
              }`}
            >
              Stocks
            </button>
            <button
              onClick={() => setMarketType("crypto")}
              className={`px-2.5 py-0.5 text-[11px] font-mono font-medium transition-colors border-l border-white/10 ${
                isCrypto
                  ? "bg-amber-500/20 text-amber-400"
                  : "text-muted-foreground hover:text-foreground hover:bg-white/5"
              }`}
            >
              Crypto
            </button>
          </div>

          {/* Timeframe buttons */}
          {isStocks
            ? STOCK_TIMEFRAMES.map((tf) => (
                <button
                  key={tf}
                  onClick={() => setStockTf(tf)}
                  className={`px-3 py-0.5 rounded text-[11px] font-mono font-medium transition-colors ${
                    tf === stockTf
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-white/5"
                  }`}
                >
                  {tf}
                </button>
              ))
            : CRYPTO_TIMEFRAMES.map((tf) => (
                <button
                  key={tf}
                  onClick={() => setCryptoTf(tf)}
                  className={`px-3 py-0.5 rounded text-[11px] font-mono font-medium transition-colors ${
                    tf === cryptoTf
                      ? "bg-amber-500 text-amber-950"
                      : "text-muted-foreground hover:text-foreground hover:bg-white/5"
                  }`}
                >
                  {tf}
                </button>
              ))
          }

          {/* Stock-only: Live Mode toggle + opportunity badge */}
          {isStocks && (
            <button
              onClick={() => {
                const next = !liveModeEnabled;
                setLiveModeEnabled(next);
                try { localStorage.setItem("live-mode", String(next)); } catch {}
                if (!next) setLiveOpportunity(null);
              }}
              title={
                liveModeEnabled && isMarketOpen ? "Live Mode ON — evaluating pre-signals" :
                liveModeEnabled ? "Live Mode ON (market closed)" : "Enable Live Mode"
              }
              className={`ml-auto px-2.5 py-0.5 rounded text-[11px] font-mono font-medium border transition-colors ${
                liveModeEnabled && isMarketOpen
                  ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-400"
                  : liveModeEnabled
                  ? "border-amber-500/30 bg-amber-500/10 text-amber-400"
                  : "border-white/10 text-muted-foreground hover:text-foreground hover:bg-white/5"
              }`}
            >
              ◈ Live
            </button>
          )}
          {isStocks && liveModeEnabled && isMarketOpen && (() => {
            const sc  = liveOpportunity?.score ?? 0;
            const dir = liveOpportunity?.direction ?? "NONE";
            const isHigh = sc >= 80;
            const isMid  = sc >= 65 && sc < 80;
            const col    = isHigh
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
              : isMid
              ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
              : "border-red-500/25 bg-red-500/8 text-red-400/70";
            return (
              <div className={`flex items-center gap-1.5 px-2.5 py-0.5 rounded border text-[11px] font-mono ${col}`}>
                <span className={`font-bold ${sc >= 65 && dir !== "NONE" ? "animate-pulse" : "opacity-50"}`}>
                  {dir === "LONG" ? "▲" : dir === "SHORT" ? "▼" : "◆"}
                </span>
                <span className="font-black">{sc}</span>
                <span className="opacity-40 text-[9px]">/100</span>
                {liveOpportunity && dir !== "NONE" && (
                  <span className="opacity-75 text-[9px] truncate max-w-[5rem]">{liveOpportunity.setupLabel}</span>
                )}
              </div>
            );
          })()}

          {/* Crypto: live badge */}
          {isCrypto && (
            <div className="ml-auto flex items-center gap-1.5 text-[10px] font-mono">
              <span className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-emerald-400 animate-pulse" : "bg-muted-foreground/40"}`} />
              <span className="text-muted-foreground">{connected ? "Live" : "Connecting…"}</span>
            </div>
          )}

          {/* Stock-only: active trade badge */}
          {isStocks && activeTrade && (
            <div className={`ml-3 flex items-center gap-2 px-2.5 py-0.5 rounded text-[11px] font-mono font-semibold border ${
              activeTrade.side === "long"
                ? "border-green-500/30 bg-green-500/10 text-green-400"
                : "border-red-500/30 bg-red-500/10 text-red-400"
            }`}>
              <span className="animate-pulse w-1.5 h-1.5 rounded-full bg-current" />
              {activeTrade.side === "long" ? "▲ LONG" : "▼ SHORT"} @ {activeTrade.entryPrice.toFixed(2)}
              <button onClick={handleCloseTrade} className="ml-1 opacity-60 hover:opacity-100 transition-opacity text-[10px]" title="Close trade">✕</button>
            </div>
          )}

          {/* Stock-only: trade result flash */}
          {isStocks && tradeResult && !activeTrade && (
            <div className={`ml-3 flex items-center gap-1.5 px-2.5 py-0.5 rounded text-[11px] font-mono font-semibold animate-pulse ${
              tradeResult.outcome === "tp_hit" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"
            }`}>
              {tradeResult.outcome === "tp_hit" ? "✓ TP HIT" : "✗ SL HIT"} @ {tradeResult.exitPrice.toFixed(2)}
            </div>
          )}
        </div>

        {/* ── Chart ── */}
        {loading ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2">
            <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
            <div className="text-xs text-muted-foreground font-mono">Fetching {displaySymbol} {displayTimeframe}…</div>
          </div>
        ) : error ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-xs text-destructive font-mono text-center">
              <div className="mb-1">Failed to load data</div>
              <div className="text-muted-foreground">{error}</div>
            </div>
          </div>
        ) : displaySymbol ? (
          <TradingChart
            key={`${displaySymbol}-${displayTimeframe}`}
            bars={bars}
            signals={isStocks ? allSignals : []}
            aiSignals={[]}
            activeTrade={isStocks ? activeTrade : null}
            tradeResult={isStocks ? tradeResult : null}
            lastPrice={isStocks ? lastPrice : null}
            symbol={displaySymbol}
            timeframe={displayTimeframe}
            intervalSec={displayIntervalSec}
            isMarketOpen={isMarketOpen}
            realtimeAvailable={realtimeAvailable}
            cryptoLiveBar={cryptoLiveBar}
            aiDecisions={isStocks ? aiDecisions : []}
            onCandleClose={isStocks ? handleCandleClose : undefined}
            aiAnalyzing={isStocks ? aiAnalyzing : false}
            activeApprovedDecision={isStocks ? latestApproved : null}
            healthScore={isStocks && tradeHealth ? tradeHealth.score : undefined}
            resolvedAiDecisions={isStocks ? resolvedDecisions : []}
            replayMarkers={isStocks ? replayMarkers : []}
            liveOpportunity={
              isStocks && liveModeEnabled &&
              liveOpportunity && liveOpportunity.score >= 65 && liveOpportunity.direction !== "NONE"
                ? liveOpportunity
                : null
            }
          />
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm text-muted-foreground">
              {isStocks ? "Select a symbol from the watchlist" : "Select a crypto pair"}
            </p>
          </div>
        )}
      </div>

      {/* ── Right panel ── */}
      <div className="w-56 flex-shrink-0 flex flex-col">
        <div className="flex-1 min-h-0 overflow-hidden">
          {isStocks
            ? <SignalPanel
                symbol={activeSymbol}
                newSignals={wsSignals}
                activeTrade={activeTrade}
                onActivateTrade={handleActivateTrade}
                onCloseTrade={handleCloseTrade}
              />
            : <CryptoLivePanel
                symbol={cryptoSymbol}
                connected={connected}
                livePrice={livePrice}
                realtimeAvailable={realtimeAvailable}
              />
          }
        </div>
        {isStocks && latestApproved && tradeHealth && (
          <ActiveTradePanel decision={latestApproved} health={tradeHealth} currentPrice={livePrice ?? undefined} />
        )}
        {/* ── Live Setup Watchlist ───────────────────────────────────────────
             Collapsible — only visible when Live Mode is enabled.
             Shows ranked opportunities for all watchlist symbols (top 3). */}
        {isStocks && liveModeEnabled && (
          <div className="border-t border-white/5 flex-shrink-0 select-none">
            <button
              onClick={() => setLivePanelOpen(v => !v)}
              className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors"
            >
              <span className={`w-1.5 h-1.5 rounded-full ${isMarketOpen ? "bg-emerald-400 animate-pulse" : "bg-muted-foreground/30"}`} />
              Live Setup
              <span className="ml-auto opacity-50">{livePanelOpen ? "▾" : "▸"}</span>
            </button>
            {livePanelOpen && (
              <div className="px-2.5 pb-2.5 space-y-1.5">
                {!isMarketOpen ? (
                  <p className="text-[9px] text-muted-foreground/40 font-mono">Market closed</p>
                ) : (() => {
                  // Merge active-symbol opportunity with other watchlist scores, rank by score desc
                  const allOpps: { symbol: string; opp: OpportunityScore }[] = [];
                  if (activeSymbol && liveOpportunity) {
                    allOpps.push({ symbol: activeSymbol, opp: liveOpportunity });
                  }
                  for (const [sym, opp] of Object.entries(watchlistOpps)) {
                    allOpps.push({ symbol: sym, opp });
                  }
                  // Sort by score descending, take top 3
                  const ranked = allOpps
                    .filter(e => e.opp.score > 0)
                    .sort((a, b) => b.opp.score - a.opp.score)
                    .slice(0, 3);

                  if (ranked.length === 0) {
                    return <p className="text-[9px] text-muted-foreground/40 font-mono">Monitoring… no setups detected</p>;
                  }

                  return ranked.map(({ symbol, opp }) => {
                    const isHigh = opp.score >= 80;
                    const isMid  = opp.score >= 65;
                    const borderCls = isHigh
                      ? "border-emerald-500/25 bg-emerald-500/5"
                      : isMid
                      ? "border-amber-500/25 bg-amber-500/5"
                      : "border-white/5 bg-white/[0.02]";
                    const scoreCls = isHigh ? "text-emerald-400" : isMid ? "text-amber-400" : "text-muted-foreground/60";
                    const barCls   = isHigh ? "bg-emerald-500" : isMid ? "bg-amber-500" : "bg-white/20";
                    const dirCls   = opp.direction === "LONG" ? "text-emerald-400" : opp.direction === "SHORT" ? "text-red-400" : "text-muted-foreground/50";

                    return (
                      <div key={symbol} className={`rounded p-1.5 border ${borderCls}`}>
                        <div className="flex items-center gap-1 mb-0.5">
                          <span className="text-[10px] font-bold font-mono text-foreground/70">{symbol}</span>
                          {opp.direction !== "NONE" && (
                            <span className={`text-[9px] font-bold font-mono ${dirCls}`}>
                              {opp.direction === "LONG" ? "▲" : "▼"}
                            </span>
                          )}
                          <span className={`ml-auto text-[12px] font-black font-mono ${scoreCls}`}>{opp.score}</span>
                        </div>
                        {opp.direction !== "NONE" && (
                          <div className="text-[7.5px] text-muted-foreground/50 font-mono truncate mb-1">{opp.setupLabel}</div>
                        )}
                        <div className="w-full h-[2px] bg-white/5 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full ${barCls}`} style={{ width: `${opp.score}%` }} />
                        </div>
                        {opp.dampened && (
                          <div className="text-[7px] text-amber-400/60 font-mono mt-0.5">⚠ Mem dampened</div>
                        )}
                      </div>
                    );
                  });
                })()}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
