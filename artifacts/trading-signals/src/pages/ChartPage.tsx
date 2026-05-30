import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { X, Brain, TrendingUp, TrendingDown } from "lucide-react";
import { WatchlistPanel } from "@/components/WatchlistPanel";
import { TradingChart } from "@/components/TradingChart";
import { SignalPanel } from "@/components/SignalPanel";
import { useMarketSocket, type SignalNew } from "@/hooks/useMarketSocket";
import { useBinanceSocket } from "@/hooks/useBinanceSocket";
import { useActiveSymbol } from "@/lib/ActiveSymbolContext";
import { getListSignalsQueryKey, getGetSignalStatsQueryKey } from "@workspace/api-client-react";

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

// ── DEV mock signals ──────────────────────────────────────────────────────────

function makeMockSignals(bars: OhlcvBar[], symbol: string): SignalNew[] {
  if (bars.length < 30) return [];
  const signals: SignalNew[] = [];
  let i = 30;
  while (i < bars.length) {
    const bar  = bars[i];
    const prev = bars.slice(Math.max(0, i - 14), i);
    const atr  = prev.reduce((s, b) => s + (b.high - b.low), 0) / (prev.length || 1);
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

// ── AI Decide result ─────────────────────────────────────────────────────────

interface AiDecideResult {
  decision:   "BUY" | "SELL" | "NO_TRADE";
  confidence: number;
  entry:      number;
  stopLoss:   number;
  takeProfit: number;
  riskReward: number;
  reasoning:  string;
  marketBias: string;
  signalId:   string | null;
  error?:     string;
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

// ── ChartPage ─────────────────────────────────────────────────────────────────

export default function ChartPage() {
  const { activeSymbol, setActiveSymbol } = useActiveSymbol();
  const queryClient = useQueryClient();

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
  const [restSignals,  setRestSignals]  = useState<SignalNew[]>([]);
  const [activeTrade,  setActiveTrade]  = useState<ActiveTrade | null>(null);
  const [tradeResult,  setTradeResult]  = useState<TradeResult | null>(null);
  const [refetchKey,   setRefetchKey]   = useState(0);
  const [generating,   setGenerating]   = useState(false);
  const signalFetchAbort = useRef<AbortController | null>(null);
  const [genMsg,       setGenMsg]       = useState<string | null>(null);
  const [devMock,      setDevMock]      = useState(false);
  const [deciding,     setDeciding]     = useState(false);
  const [aiResult,     setAiResult]     = useState<AiDecideResult | null>(null);
  const [showRuleSignals, setShowRuleSignals] = useState(true);
  const [showAiSignals,   setShowAiSignals]   = useState(true);

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
  }, [activeSymbol, stockTf, refetchKey, isStocks]);

  // ── Clear active trade on symbol/timeframe switch ─────────────────────────
  useEffect(() => {
    setActiveTrade(null);
    setTradeResult(null);
  }, [activeSymbol, stockTf]);

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

  // ── Stock-only: Generate signals ─────────────────────────────────────────
  const handleGenerate = useCallback(async () => {
    if (!activeSymbol || generating) return;
    setGenerating(true);
    setGenMsg(null);
    const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
    try {
      const r = await fetch(
        `${base}/api/signals/regenerate?symbol=${encodeURIComponent(activeSymbol)}&timeframe=${encodeURIComponent(stockTf)}`,
        { method: "POST" },
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
  }, [activeSymbol, stockTf, generating]);

  // ── Stock-only: AI Decide ─────────────────────────────────────────────────
  const handleAiDecide = useCallback(async () => {
    if (!activeSymbol || deciding) return;
    setDeciding(true);
    setAiResult(null);
    const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
    try {
      const r = await fetch(`${base}/api/ai/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: activeSymbol, timeframe: stockTf }),
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
        setRefetchKey((k) => k + 1);
        queryClient.invalidateQueries({ queryKey: getListSignalsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetSignalStatsQueryKey() });
      }
    } catch (e) {
      setAiResult({ decision: "NO_TRADE", confidence: 0, entry: 0, stopLoss: 0, takeProfit: 0, riskReward: 0, reasoning: "", marketBias: "NEUTRAL", signalId: null, error: String(e) });
    } finally {
      setDeciding(false);
    }
  }, [activeSymbol, stockTf, deciding, queryClient]);

  // ── DEV logging ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    console.groupCollapsed(
      `%c[TradingPipeline] ${displaySymbol ?? "–"} ${displayTimeframe} | bars=${bars.length} rest=${restSignals.length} ws=${wsSignals.length}`,
      "color:#22d3ee;font-weight:bold",
    );
    console.log("WS connected:", connected, "| isMarketOpen:", isMarketOpen, "| realtimeAvailable:", realtimeAvailable);
    if (isStocks && restSignals.length === 0 && bars.length > 0) {
      console.warn("⚠ No signals in DB — click ⚡ Generate to seed them");
    }
    console.groupEnd();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars.length, restSignals.length, wsSignals.length, connected]);

  // ── Stock-only: mock signals (DEV) ────────────────────────────────────────
  const mockSignals = useMemo(
    () => (import.meta.env.DEV && devMock && isStocks && activeSymbol ? makeMockSignals(bars, activeSymbol) : []),
    [devMock, bars, activeSymbol, isStocks],
  );

  const allSignalsDeduped = [...wsSignals, ...restSignals, ...mockSignals]
    .filter((sig) => !activeSymbol || sig.symbol === activeSymbol)
    .filter((sig, idx, arr) => arr.findIndex((s) => s.signalId === sig.signalId) === idx);

  const ruleSignals = showRuleSignals ? allSignalsDeduped.filter((s) => !s.isAiSignal) : [];
  const aiSignals   = showAiSignals   ? allSignalsDeduped.filter((s) =>  s.isAiSignal) : [];

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

          {/* Stock-only controls */}
          {isStocks && (
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
                  title="Toggle synthetic mock signals (DEV only)"
                >
                  MOCK
                </button>
              )}
            </div>
          )}

          {/* Stock-only: signal filters */}
          {isStocks && (
            <div className="ml-auto flex items-center gap-3 pl-3 border-l border-white/5">
              <label className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground cursor-pointer select-none hover:text-foreground transition-colors">
                <input type="checkbox" checked={showRuleSignals} onChange={(e) => setShowRuleSignals(e.target.checked)} className="accent-sky-500 w-3 h-3 cursor-pointer" />
                <span>⚡ Generate</span>
              </label>
              <label className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground cursor-pointer select-none hover:text-foreground transition-colors">
                <input type="checkbox" checked={showAiSignals} onChange={(e) => setShowAiSignals(e.target.checked)} className="accent-violet-500 w-3 h-3 cursor-pointer" />
                <span>🧠 AI</span>
              </label>
            </div>
          )}

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

        {/* ── Stock-only: AI Decision Result Card ── */}
        {isStocks && aiResult && (
          <div className={`flex-shrink-0 px-3 py-2 border-b border-white/5 flex items-start gap-2.5 text-[11px] ${
            aiResult.error ? "bg-red-500/5" :
            aiResult.decision === "BUY"  ? "bg-emerald-500/5" :
            aiResult.decision === "SELL" ? "bg-red-500/5" :
            "bg-amber-500/5"
          }`}>
            <span className={`flex-shrink-0 font-mono font-bold text-[11px] px-1.5 py-0.5 rounded leading-none mt-0.5 ${
              aiResult.error           ? "bg-red-500/20 text-red-400" :
              aiResult.decision === "BUY"  ? "bg-emerald-500/20 text-emerald-400" :
              aiResult.decision === "SELL" ? "bg-red-500/20 text-red-400" :
              "bg-amber-500/20 text-amber-400"
            }`}>
              {aiResult.error ? "ERR" : aiResult.decision}
            </span>

            {aiResult.error && (
              <span className="text-red-400 flex-1 text-[10px] font-mono leading-snug">
                {aiResult.error.slice(0, 200)}
              </span>
            )}

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

            {!aiResult.error && (
              <span className="flex-1 text-muted-foreground leading-snug text-[10px] min-w-0">
                {aiResult.decision === "NO_TRADE"
                  ? <><span className="text-amber-400 font-medium">No trade: </span>{aiResult.reasoning}</>
                  : aiResult.reasoning}
              </span>
            )}

            {!aiResult.error && aiResult.signalId && (
              <span className="flex-shrink-0 text-[9px] text-muted-foreground/60 italic leading-snug mt-0.5">→ Signal Panel</span>
            )}

            <button onClick={() => setAiResult(null)} className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors mt-0.5">
              <X size={11} />
            </button>
          </div>
        )}

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
            signals={isStocks ? ruleSignals : []}
            aiSignals={isStocks ? aiSignals : []}
            activeTrade={isStocks ? activeTrade : null}
            tradeResult={isStocks ? tradeResult : null}
            lastPrice={isStocks ? lastPrice : null}
            symbol={displaySymbol}
            timeframe={displayTimeframe}
            intervalSec={displayIntervalSec}
            isMarketOpen={isMarketOpen}
            realtimeAvailable={realtimeAvailable}
            cryptoLiveBar={cryptoLiveBar}
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
      <div className="w-56 flex-shrink-0">
        {isStocks
          ? <SignalPanel
              symbol={activeSymbol}
              newSignals={wsSignals}
              activeTrade={activeTrade}
              onActivateTrade={handleActivateTrade}
              onCloseTrade={handleCloseTrade}
              onGenerate={handleGenerate}
              generating={generating}
            />
          : <CryptoLivePanel
              symbol={cryptoSymbol}
              connected={connected}
              livePrice={livePrice}
              realtimeAvailable={realtimeAvailable}
            />
        }
      </div>
    </div>
  );
}
