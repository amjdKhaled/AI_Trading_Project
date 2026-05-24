import { useListSignals, useGetSignalStats, getListSignalsQueryKey, getGetSignalStatsQueryKey } from "@workspace/api-client-react";
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { TrendingUp, TrendingDown, Target, Shield, AlertTriangle, Clock, CheckCircle, XCircle } from "lucide-react";
import type { SignalNew } from "@/hooks/useMarketSocket";

interface Props {
  symbol: string | null;
  newSignals: SignalNew[];
}

function confidenceColor(c: number) {
  if (c >= 80) return "text-green-400";
  if (c >= 70) return "text-amber-400";
  return "text-red-400";
}

function riskTagIcon(tag: string) {
  if (tag === "Safe") return <Shield size={10} className="text-green-400" />;
  if (tag === "Medium") return <AlertTriangle size={10} className="text-amber-400" />;
  return <AlertTriangle size={10} className="text-red-400" />;
}

function stateIcon(state: string) {
  if (state === "active") return <Clock size={10} className="text-blue-400" />;
  if (state === "tp_hit") return <CheckCircle size={10} className="text-green-400" />;
  if (state === "sl_hit") return <XCircle size={10} className="text-red-400" />;
  return <Clock size={10} className="text-muted-foreground" />;
}

function formatPrice(p: number) {
  return p >= 1000 ? p.toFixed(2) : p.toFixed(2);
}

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

export function SignalPanel({ symbol, newSignals }: Props) {
  const queryClient = useQueryClient();
  const { data: signals = [], isLoading } = useListSignals(
    symbol ? { symbol, limit: 20 } : { limit: 20 },
    { query: { queryKey: getListSignalsQueryKey(symbol ? { symbol, limit: 20 } : { limit: 20 }) } }
  );
  const { data: stats } = useGetSignalStats(
    symbol ? { symbol } : {},
    { query: { queryKey: getGetSignalStatsQueryKey(symbol ? { symbol } : {}) } }
  );

  // Refetch when new signals arrive via WebSocket
  useEffect(() => {
    if (newSignals.length > 0) {
      queryClient.invalidateQueries({ queryKey: getListSignalsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetSignalStatsQueryKey() });
    }
  }, [newSignals, queryClient]);

  return (
    <div className="flex flex-col h-full bg-card border-l border-border">
      {/* Stats row */}
      {stats && (
        <div className="px-3 py-2 border-b border-border">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            {symbol ? symbol : "All"} — Stats
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-background rounded p-1.5">
              <div className="text-xs text-muted-foreground">Win Rate</div>
              <div className={`text-sm font-mono font-semibold ${stats.winRate >= 0.6 ? "text-green-400" : stats.winRate >= 0.45 ? "text-amber-400" : "text-red-400"}`}>
                {(stats.winRate * 100).toFixed(1)}%
              </div>
            </div>
            <div className="bg-background rounded p-1.5">
              <div className="text-xs text-muted-foreground">Avg RR</div>
              <div className="text-sm font-mono font-semibold text-foreground">{stats.avgRR.toFixed(2)}</div>
            </div>
            <div className="bg-background rounded p-1.5">
              <div className="text-xs text-muted-foreground">Avg Conf</div>
              <div className={`text-sm font-mono font-semibold ${confidenceColor(stats.avgConfidence)}`}>
                {stats.avgConfidence.toFixed(0)}%
              </div>
            </div>
            <div className="bg-background rounded p-1.5">
              <div className="text-xs text-muted-foreground">Active</div>
              <div className="text-sm font-mono font-semibold text-blue-400">{stats.active}</div>
            </div>
          </div>
        </div>
      )}

      {/* Signals list */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Signals</span>
        {newSignals.length > 0 && (
          <span className="text-xs text-green-400 font-mono animate-pulse">+{newSignals.length} live</span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="space-y-1 p-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-16 bg-muted rounded animate-pulse" />
            ))}
          </div>
        ) : signals.length === 0 ? (
          <div className="px-3 py-6 text-center">
            <Target size={20} className="text-muted-foreground mx-auto mb-2" />
            <p className="text-xs text-muted-foreground">No signals yet</p>
            <p className="text-xs text-muted-foreground mt-1">Waiting for bar closes...</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {signals.map((sig) => (
              <div
                key={sig.id}
                data-testid={`signal-card-${sig.id}`}
                className="px-3 py-2.5 hover:bg-muted/30 transition-colors"
              >
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-1.5">
                    {sig.side === "long" ? (
                      <TrendingUp size={12} className="text-green-400 flex-shrink-0" />
                    ) : (
                      <TrendingDown size={12} className="text-red-400 flex-shrink-0" />
                    )}
                    <span className={`text-xs font-mono font-bold ${sig.side === "long" ? "text-green-400" : "text-red-400"}`}>
                      {sig.side.toUpperCase()}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">{sig.symbol}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    {stateIcon(sig.state)}
                    {riskTagIcon(sig.riskTag)}
                    <span className={`text-xs font-mono font-semibold ${confidenceColor(sig.confidence)}`}>
                      {sig.confidence}%
                    </span>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-1 text-xs font-mono">
                  <div>
                    <div className="text-muted-foreground text-[10px]">Entry</div>
                    <div className="text-foreground">{formatPrice(sig.entryPrice)}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground text-[10px]">SL</div>
                    <div className="text-amber-400">{formatPrice(sig.currentSlPrice ?? sig.slPrice)}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground text-[10px]">TP</div>
                    <div className="text-green-400">{formatPrice(sig.tpPrice)}</div>
                  </div>
                </div>
                {sig.pattern && (
                  <div className="mt-1 text-[10px] text-muted-foreground truncate">{sig.pattern} · {sig.regime}</div>
                )}
                <div className="mt-0.5 text-[10px] text-muted-foreground">{timeAgo(sig.createdAt)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
