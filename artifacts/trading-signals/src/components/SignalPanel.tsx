import { useListSignals, useGetSignalStats, getListSignalsQueryKey, getGetSignalStatsQueryKey } from "@workspace/api-client-react";
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { TrendingUp, TrendingDown, Target, Shield, AlertTriangle, CheckCircle, XCircle, Zap, X } from "lucide-react";
import type { SignalNew } from "@/hooks/useMarketSocket";
import type { ActiveTrade } from "@/pages/ChartPage";

interface Props {
  symbol: string | null;
  newSignals: SignalNew[];
  activeTrade: ActiveTrade | null;
  onActivateTrade: (trade: ActiveTrade) => void;
  onCloseTrade: () => void;
}

function confidenceColor(c: number) {
  if (c >= 90) return "text-emerald-400";
  if (c >= 80) return "text-green-400";
  if (c >= 70) return "text-amber-400";
  return "text-red-400";
}

function riskIcon(tag: string) {
  if (tag === "Safe")   return <Shield size={9} className="text-emerald-400" />;
  if (tag === "Medium") return <AlertTriangle size={9} className="text-amber-400" />;
  return <AlertTriangle size={9} className="text-red-400" />;
}

function stateIcon(state: string) {
  if (state === "tp_hit") return <CheckCircle size={9} className="text-emerald-400" />;
  if (state === "sl_hit") return <XCircle size={9} className="text-red-400" />;
  if (state === "expired") return <XCircle size={9} className="text-muted-foreground" />;
  return null;
}

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1)  return "just now";
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function formatP(p: number) { return p.toFixed(2); }

export function SignalPanel({ symbol, newSignals, activeTrade, onActivateTrade, onCloseTrade }: Props) {
  const queryClient = useQueryClient();

  const { data: rawSignals, isLoading } = useListSignals(
    symbol ? { symbol, limit: 20 } : { limit: 20 },
    { query: { queryKey: getListSignalsQueryKey(symbol ? { symbol, limit: 20 } : { limit: 20 }) } }
  );
  // Guard: the API might return null or an error object when the server is
  // unreachable or the DB is empty — always fall back to an empty array.
  const signals = Array.isArray(rawSignals) ? rawSignals : [];

  const { data: rawStats } = useGetSignalStats(
    symbol ? { symbol } : {},
    { query: { queryKey: getGetSignalStatsQueryKey(symbol ? { symbol } : {}) } }
  );
  // Guard: coerce each numeric field so .toFixed() never runs on undefined/null.
  const stats = rawStats && typeof rawStats === "object" && "total" in rawStats
    ? {
        ...rawStats,
        winRate:       Number(rawStats.winRate       ?? 0),
        avgRR:         Number(rawStats.avgRR         ?? 0),
        avgConfidence: Number(rawStats.avgConfidence ?? 0),
        active:        rawStats.active               ?? 0,
      }
    : null;

  useEffect(() => {
    if (newSignals.length > 0) {
      queryClient.invalidateQueries({ queryKey: getListSignalsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetSignalStatsQueryKey() });
    }
  }, [newSignals, queryClient]);

  return (
    <div className="flex flex-col h-full bg-card border-l border-border">

      {/* Stats */}
      {stats && (
        <div className="px-3 py-2 border-b border-border">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            {symbol ?? "All"} — Stats
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {[
              { label: "Win Rate", value: `${(stats.winRate * 100).toFixed(1)}%`, color: stats.winRate >= 0.6 ? "text-emerald-400" : stats.winRate >= 0.45 ? "text-amber-400" : "text-red-400" },
              { label: "Avg RR",   value: stats.avgRR.toFixed(2),                color: "text-foreground" },
              { label: "Avg Conf", value: `${stats.avgConfidence.toFixed(0)}%`,  color: confidenceColor(stats.avgConfidence) },
              { label: "Active",   value: String(stats.active),                  color: "text-blue-400" },
            ].map((item) => (
              <div key={item.label} className="bg-background rounded p-1.5">
                <div className="text-[10px] text-muted-foreground">{item.label}</div>
                <div className={`text-sm font-mono font-semibold ${item.color}`}>{item.value}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Active trade summary */}
      {activeTrade && (
        <div className={`mx-2 my-1.5 rounded-md border p-2 ${
          activeTrade.side === "long"
            ? "border-green-500/30 bg-green-500/8"
            : "border-red-500/30 bg-red-500/8"
        }`}>
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full animate-pulse bg-current" style={{ color: activeTrade.side === "long" ? "#26a69a" : "#ef5350" }} />
              <span className={`text-[11px] font-mono font-bold ${activeTrade.side === "long" ? "text-green-400" : "text-red-400"}`}>
                {activeTrade.side === "long" ? "▲ LONG" : "▼ SHORT"} ACTIVE
              </span>
            </div>
            <button onClick={onCloseTrade} className="text-muted-foreground hover:text-foreground transition-colors">
              <X size={11} />
            </button>
          </div>
          <div className="grid grid-cols-3 gap-1 text-[10px] font-mono">
            <div><div className="text-muted-foreground">Entry</div><div className="text-foreground font-semibold">{formatP(activeTrade.entryPrice)}</div></div>
            <div><div className="text-muted-foreground">SL</div><div className="text-red-400 font-semibold">{formatP(activeTrade.slPrice)}</div></div>
            <div><div className="text-muted-foreground">TP</div><div className="text-green-400 font-semibold">{formatP(activeTrade.tpPrice)}</div></div>
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground font-mono">
            RR {(Math.abs(activeTrade.tpPrice - activeTrade.entryPrice) / Math.abs(activeTrade.entryPrice - activeTrade.slPrice || 1)).toFixed(2)} · {activeTrade.confidence}% conf
            {activeTrade.grade && <span className="ml-1 text-amber-400">{activeTrade.grade}</span>}
          </div>
        </div>
      )}

      {/* Signal list header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Signals</span>
        {newSignals.length > 0 && (
          <span className="text-[10px] text-green-400 font-mono animate-pulse">+{newSignals.length} live</span>
        )}
      </div>

      {/* Signal list */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="space-y-1 p-2">
            {[1, 2, 3].map((i) => <div key={i} className="h-16 bg-muted rounded animate-pulse" />)}
          </div>
        ) : signals.length === 0 ? (
          <div className="px-3 py-6 text-center">
            <Target size={18} className="text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-xs text-muted-foreground mb-1">No signals for {symbol ?? "this symbol"}</p>
            <p className="text-[10px] text-muted-foreground/60 leading-relaxed px-2">
              Signals appear automatically as the AI analyzes each candle close.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {signals.map((sig) => {
              const isThisActive = activeTrade?.signalId === sig.signalId;
              const isClosed = sig.state === "tp_hit" || sig.state === "sl_hit" || sig.state === "expired";
              const canActivate = !activeTrade && !isClosed && sig.state === "active";

              return (
                <div
                  key={sig.id}
                  data-testid={`signal-card-${sig.id}`}
                  className={`px-3 py-2.5 transition-colors ${
                    isThisActive ? "bg-primary/8 border-l-2 border-primary" : "hover:bg-muted/30"
                  }`}
                >
                  {/* Row 1: direction + badges */}
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-1.5">
                      {sig.side === "long"
                        ? <TrendingUp size={11} className="text-emerald-400 flex-shrink-0" />
                        : <TrendingDown size={11} className="text-red-400 flex-shrink-0" />}
                      <span className={`text-[11px] font-mono font-bold ${sig.side === "long" ? "text-emerald-400" : "text-red-400"}`}>
                        {sig.side.toUpperCase()}
                      </span>
                      <span className="font-mono text-[10px] text-muted-foreground">{sig.symbol}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      {stateIcon(sig.state)}
                      {riskIcon(sig.riskTag)}
                      {(() => {
                        const g = (sig as { grade?: string }).grade;
                        return g ? (
                          <span className={`text-[9px] font-bold px-1 rounded ${g === "A+" ? "bg-emerald-500/20 text-emerald-400" : "bg-amber-500/20 text-amber-400"}`}>
                            {g}
                          </span>
                        ) : null;
                      })()}
                      <span className={`text-[11px] font-mono font-semibold ${confidenceColor(sig.confidence)}`}>
                        {sig.confidence}%
                      </span>
                    </div>
                  </div>

                  {/* Row 2: prices */}
                  <div className="grid grid-cols-3 gap-1 text-[10px] font-mono mb-1.5">
                    <div><div className="text-muted-foreground">Entry</div><div className="text-foreground">{formatP(sig.entryPrice)}</div></div>
                    <div><div className="text-muted-foreground">SL</div><div className="text-red-400">{formatP(sig.currentSlPrice ?? sig.slPrice)}</div></div>
                    <div><div className="text-muted-foreground">TP</div><div className="text-emerald-400">{formatP(sig.tpPrice)}</div></div>
                  </div>

                  {/* Row 3: pattern + time */}
                  {sig.pattern && (
                    <div className="text-[9px] text-muted-foreground truncate mb-1">{sig.pattern}</div>
                  )}
                  <div className="flex items-center justify-between">
                    <span className="text-[9px] text-muted-foreground">{timeAgo(sig.createdAt)}</span>

                    {/* Action button */}
                    {isThisActive ? (
                      <button
                        onClick={onCloseTrade}
                        className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-mono font-semibold bg-muted text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <X size={8} /> Close
                      </button>
                    ) : canActivate ? (
                      <button
                        onClick={() => onActivateTrade({
                          signalId:   sig.signalId,
                          symbol:     sig.symbol,
                          side:       sig.side as "long" | "short",
                          entryPrice: sig.entryPrice,
                          slPrice:    sig.slPrice,
                          tpPrice:    sig.tpPrice,
                          confidence: sig.confidence,
                          barTime:    new Date(sig.barTime).toISOString(),
                          grade:      (sig as { grade?: string }).grade,
                          patterns:   sig.pattern ? [sig.pattern] : [],
                        })}
                        className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-mono font-semibold transition-colors ${
                          sig.side === "long"
                            ? "bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30"
                            : "bg-red-500/20 text-red-400 hover:bg-red-500/30"
                        }`}
                      >
                        <Zap size={8} /> Trade
                      </button>
                    ) : isClosed ? (
                      <span className={`text-[9px] font-mono font-semibold ${
                        sig.state === "tp_hit" ? "text-emerald-400" : "text-red-400"
                      }`}>
                        {sig.state === "tp_hit" ? "✓ TP" : sig.state === "sl_hit" ? "✗ SL" : "Expired"}
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
