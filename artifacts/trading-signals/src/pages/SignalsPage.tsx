import { useState } from "react";
import { useListSignals, useGetSignalStats, useListSymbols, getListSignalsQueryKey, getGetSignalStatsQueryKey } from "@workspace/api-client-react";
import { TrendingUp, TrendingDown, Shield, AlertTriangle, CheckCircle, XCircle, Clock, BarChart2 } from "lucide-react";

function confidenceColor(c: number) {
  if (c >= 80) return "text-green-400";
  if (c >= 70) return "text-amber-400";
  return "text-red-400";
}

function stateLabel(state: string) {
  const map: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
    active: { label: "Active", color: "text-blue-400 bg-blue-400/10", icon: <Clock size={10} /> },
    tp_hit: { label: "TP Hit", color: "text-green-400 bg-green-400/10", icon: <CheckCircle size={10} /> },
    sl_hit: { label: "SL Hit", color: "text-red-400 bg-red-400/10", icon: <XCircle size={10} /> },
    expired: { label: "Expired", color: "text-muted-foreground bg-muted/20", icon: <Clock size={10} /> },
  };
  return map[state] ?? map.expired;
}

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}

export default function SignalsPage() {
  const [filterSymbol, setFilterSymbol] = useState<string>("");
  const [filterState, setFilterState] = useState<string>("");

  const { data: symbols = [] } = useListSymbols();
  const { data: signals = [], isLoading } = useListSignals(
    { symbol: filterSymbol || undefined, limit: 100 },
    { query: { queryKey: getListSignalsQueryKey({ symbol: filterSymbol || undefined, limit: 100 }) } }
  );
  const { data: stats } = useGetSignalStats(
    { symbol: filterSymbol || undefined },
    { query: { queryKey: getGetSignalStatsQueryKey({ symbol: filterSymbol || undefined }) } }
  );

  const filtered = filterState ? signals.filter((s) => s.state === filterState) : signals;

  return (
    <div className="h-full flex flex-col overflow-hidden" data-testid="signals-page">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border flex-shrink-0">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-base font-semibold text-foreground">Signal History</h1>
            <p className="text-xs text-muted-foreground mt-0.5">All emitted signals — immutable, bar-anchored events</p>
          </div>
          <div className="flex gap-2">
            <select
              data-testid="select-symbol-filter"
              value={filterSymbol}
              onChange={(e) => setFilterSymbol(e.target.value)}
              className="h-7 text-xs bg-card border border-border rounded px-2 text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="">All symbols</option>
              {symbols.map((s) => (
                <option key={s.id} value={s.symbol}>{s.symbol}</option>
              ))}
            </select>
            <select
              data-testid="select-state-filter"
              value={filterState}
              onChange={(e) => setFilterState(e.target.value)}
              className="h-7 text-xs bg-card border border-border rounded px-2 text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="">All states</option>
              <option value="active">Active</option>
              <option value="tp_hit">TP Hit</option>
              <option value="sl_hit">SL Hit</option>
              <option value="expired">Expired</option>
            </select>
          </div>
        </div>

        {/* Stats row */}
        {stats && (
          <div className="grid grid-cols-7 gap-2">
            {[
              { label: "Total", value: stats.total, color: "text-foreground" },
              { label: "Active", value: stats.active, color: "text-blue-400" },
              { label: "TP Hit", value: stats.tp_hit, color: "text-green-400" },
              { label: "SL Hit", value: stats.sl_hit, color: "text-red-400" },
              { label: "Expired", value: stats.expired, color: "text-muted-foreground" },
              { label: "Win Rate", value: `${(stats.winRate * 100).toFixed(1)}%`, color: stats.winRate >= 0.6 ? "text-green-400" : stats.winRate >= 0.45 ? "text-amber-400" : "text-red-400" },
              { label: "Avg Conf", value: `${stats.avgConfidence.toFixed(0)}%`, color: confidenceColor(stats.avgConfidence) },
            ].map((item) => (
              <div key={item.label} className="bg-card rounded border border-card-border px-2 py-1.5">
                <div className="text-[10px] text-muted-foreground">{item.label}</div>
                <div className={`text-sm font-mono font-semibold ${item.color}`}>{item.value}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="p-6 space-y-2">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-10 bg-muted rounded animate-pulse" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full">
            <BarChart2 size={32} className="text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">No signals found</p>
            <p className="text-xs text-muted-foreground mt-1">Signals appear as the backend emits them on bar close</p>
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card border-b border-border">
              <tr>
                {["Symbol", "Side", "Timeframe", "Entry", "SL", "TP", "RR", "Conf", "Risk", "Pattern", "State", "Time"].map((h) => (
                  <th key={h} className="text-left px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground font-medium whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((sig) => {
                const st = stateLabel(sig.state);
                return (
                  <tr key={sig.id} data-testid={`signal-row-${sig.id}`} className="hover:bg-muted/20 transition-colors">
                    <td className="px-3 py-2 font-mono font-semibold text-foreground">{sig.symbol}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center gap-1 font-mono font-bold ${sig.side === "long" ? "text-green-400" : "text-red-400"}`}>
                        {sig.side === "long" ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
                        {sig.side.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-muted-foreground">{sig.timeframe}</td>
                    <td className="px-3 py-2 font-mono text-foreground">{sig.entryPrice.toFixed(2)}</td>
                    <td className="px-3 py-2 font-mono text-amber-400">{(sig.currentSlPrice ?? sig.slPrice).toFixed(2)}</td>
                    <td className="px-3 py-2 font-mono text-green-400">{sig.tpPrice.toFixed(2)}</td>
                    <td className="px-3 py-2 font-mono text-muted-foreground">{sig.rrRatio?.toFixed(2) ?? "—"}</td>
                    <td className={`px-3 py-2 font-mono font-semibold ${confidenceColor(sig.confidence)}`}>{sig.confidence}%</td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center gap-0.5 ${sig.riskTag === "Safe" ? "text-green-400" : sig.riskTag === "Medium" ? "text-amber-400" : "text-red-400"}`}>
                        {sig.riskTag === "Safe" ? <Shield size={10} /> : <AlertTriangle size={10} />}
                        {sig.riskTag}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground truncate max-w-[120px]">{sig.pattern ?? "—"}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${st.color}`}>
                        {st.icon}{st.label}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-muted-foreground whitespace-nowrap">{timeAgo(sig.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
