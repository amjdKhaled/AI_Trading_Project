import { useState, useEffect, useCallback } from "react";
import {
  TrendingUp, TrendingDown, RefreshCw, BarChart2,
  Award, Target, Zap, Shield, Brain, Activity,
} from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

async function apiFetch<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

interface PerformanceSlice {
  total: number;
  tp_hit: number;
  sl_hit: number;
  expired: number;
  active: number;
  closed: number;
  winRate: number;
  profitFactor: number;
  avgRR: number;
  avgConf: number;
}

interface MemoryScorecard {
  noMemWinRate: number;
  withMemWinRate: number;
  noMemAvgRR: number;
  withMemAvgRR: number;
  noMemTotal: number;
  withMemTotal: number;
}

interface WeeklyTrendSlice {
  week: string;
  winRate: number;
  total: number;
  memoryImpact: number;
}

interface PerformanceSummary {
  ok: boolean;
  global: PerformanceSlice;
  bySide: Record<string, PerformanceSlice>;
  bySymbol: Record<string, PerformanceSlice>;
  byRegime: Record<string, PerformanceSlice>;
  byPattern: Record<string, PerformanceSlice>;
  memoryScorecard: MemoryScorecard;
  weeklyTrend: WeeklyTrendSlice[];
  updatedAt: string;
}

function Sparkline({ data, color = "#10b981", height = 32 }: { data: number[]; color?: string; height?: number }) {
  if (data.length < 2) return <div className="text-[10px] text-muted-foreground italic">Not enough data</div>;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const w = 200;
  const h = height;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / range) * h * 0.85 - h * 0.075;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible">
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      {data.map((v, i) => {
        const x = (i / (data.length - 1)) * w;
        const y = h - ((v - min) / range) * h * 0.85 - h * 0.075;
        return <circle key={i} cx={x} cy={y} r="2" fill={color} />;
      })}
    </svg>
  );
}

function wrColor(wr: number): string {
  const pct = wr * 100;
  return pct >= 55 ? "text-emerald-400" : pct >= 45 ? "text-amber-400" : "text-red-400";
}

function wrBar(wr: number): string {
  const pct = wr * 100;
  return pct >= 55 ? "bg-emerald-500" : pct >= 45 ? "bg-amber-500" : "bg-red-500";
}

function pfColor(pf: number): string {
  return pf >= 1.5 ? "text-emerald-400" : pf >= 1.0 ? "text-amber-400" : "text-red-400";
}

function StatCard({ label, value, sub, color }: {
  label: string; value: string; sub?: string; color?: string;
}) {
  return (
    <div className="bg-card border border-border rounded p-3 text-center">
      <div className="text-[9px] text-muted-foreground uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-base font-mono font-bold ${color ?? "text-foreground"}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

function SliceRow({ name, s, highlight }: { name: string; s: PerformanceSlice; highlight?: boolean }) {
  const wrPct = Math.round(s.winRate * 100);
  return (
    <div className={`flex items-center gap-2 px-2.5 py-1.5 text-[11px] border-b border-border/40 last:border-0 ${highlight ? "bg-primary/5" : ""}`}>
      <span className="font-mono font-semibold text-foreground w-28 flex-shrink-0 truncate">{name}</span>
      <span className="text-muted-foreground w-10 text-right flex-shrink-0">{s.total}</span>
      <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden mx-2 min-w-0">
        <div className={`h-full rounded-full ${wrBar(s.winRate)}`} style={{ width: `${wrPct}%` }} />
      </div>
      <span className={`font-mono font-bold w-10 text-right flex-shrink-0 ${wrColor(s.winRate)}`}>{wrPct}%</span>
      <span className={`font-mono w-10 text-right flex-shrink-0 ${pfColor(s.profitFactor)}`}>
        {s.profitFactor > 0 ? s.profitFactor.toFixed(2) : "—"}
      </span>
      <span className="text-blue-400 font-mono w-10 text-right flex-shrink-0">
        {s.avgRR > 0 ? s.avgRR.toFixed(2) : "—"}
      </span>
      <span className="text-muted-foreground w-12 text-right flex-shrink-0 text-[10px]">
        {s.tp_hit}W/{s.closed}C
      </span>
    </div>
  );
}

function TableHeader({ cols }: { cols: string[] }) {
  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5 text-[9px] text-muted-foreground uppercase tracking-wider border-b border-border bg-muted/30">
      <span className="w-28 flex-shrink-0">{cols[0]}</span>
      <span className="w-10 text-right flex-shrink-0">{cols[1]}</span>
      <div className="flex-1 mx-2" />
      <span className="w-10 text-right flex-shrink-0">{cols[2]}</span>
      <span className="w-10 text-right flex-shrink-0">{cols[3]}</span>
      <span className="w-10 text-right flex-shrink-0">{cols[4]}</span>
      <span className="w-12 text-right flex-shrink-0">{cols[5]}</span>
    </div>
  );
}

const REGIME_LABELS: Record<string, string> = {
  trending:      "Trending",
  vol_expansion: "High Volatility",
  ranging:       "Range Market",
  chop:          "Low Volatility",
  ai_generated:  "AI Generated",
  unknown:       "Unknown",
};

export default function PerformancePage() {
  const [summary, setSummary] = useState<PerformanceSummary | null>(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    apiFetch<PerformanceSummary>("/api/signals/performance/summary")
      .then(d => { setSummary(d); })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const symbolRows = summary
    ? Object.entries(summary.bySymbol).sort((a, b) => b[1].total - a[1].total)
    : [];
  const regimeRows = summary
    ? Object.entries(summary.byRegime).sort((a, b) => b[1].total - a[1].total)
    : [];
  const patternRows = summary
    ? Object.entries(summary.byPattern)
        .filter(([, s]) => s.closed >= 3)
        .sort((a, b) => b[1].total - a[1].total)
        .slice(0, 15)
    : [];

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="max-w-3xl mx-auto p-4 space-y-5">
        {/* Page header */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <BarChart2 size={16} className="text-primary" />
            <h1 className="text-sm font-bold text-foreground">Performance Dashboard</h1>
          </div>
          <span className="text-[10px] text-muted-foreground flex-1">
            Signal engine backtest results across all symbols
          </span>
          <button
            onClick={load}
            disabled={loading}
            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded px-3 py-2 text-xs text-red-400">
            {error}
          </div>
        )}

        {loading && !summary && (
          <div className="space-y-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-24 bg-muted rounded animate-pulse" />
            ))}
          </div>
        )}

        {summary && (
          <>
            {/* ── Global metrics ── */}
            <section>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                <Zap size={10} /> Global Signal Engine Performance
              </div>
              <div className="grid grid-cols-4 gap-2 mb-3">
                <StatCard
                  label="Win Rate"
                  value={`${Math.round(summary.global.winRate * 100)}%`}
                  sub={`${summary.global.tp_hit}W / ${summary.global.closed} closed`}
                  color={wrColor(summary.global.winRate)}
                />
                <StatCard
                  label="Profit Factor"
                  value={summary.global.profitFactor > 0 ? summary.global.profitFactor.toFixed(2) : "—"}
                  sub={summary.global.closed > 0 ? "wins/loss ratio" : "no closed trades"}
                  color={pfColor(summary.global.profitFactor)}
                />
                <StatCard
                  label="Avg R:R"
                  value={summary.global.avgRR > 0 ? summary.global.avgRR.toFixed(2) : "—"}
                  color="text-blue-400"
                />
                <StatCard
                  label="Avg Confidence"
                  value={`${summary.global.avgConf}%`}
                  color="text-violet-400"
                />
              </div>
              <div className="grid grid-cols-4 gap-2">
                <StatCard label="Total Signals" value={String(summary.global.total)} />
                <StatCard label="Active" value={String(summary.global.active)} color="text-amber-400" />
                <StatCard label="Expired" value={String(summary.global.expired)} color="text-muted-foreground" />
                <StatCard
                  label="Losses"
                  value={String(summary.global.sl_hit)}
                  color="text-red-400"
                />
              </div>
            </section>

            {/* ── LONG vs SHORT ── */}
            {(summary.bySide.long || summary.bySide.short) && (
              <section>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                  <Target size={10} /> Long vs Short Breakdown
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {(["long", "short"] as const).map(side => {
                    const s = summary.bySide[side];
                    if (!s) return null;
                    const wrPct = Math.round(s.winRate * 100);
                    const isLong = side === "long";
                    return (
                      <div key={side} className="bg-card border border-border rounded p-3">
                        <div className={`flex items-center gap-1.5 mb-2 text-[11px] font-semibold ${isLong ? "text-emerald-400" : "text-red-400"}`}>
                          {isLong ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                          {side.toUpperCase()}
                        </div>
                        <div className="grid grid-cols-2 gap-1.5 text-[10px]">
                          {[
                            ["Win Rate", `${wrPct}%`, wrColor(s.winRate)],
                            ["Profit Factor", s.profitFactor > 0 ? s.profitFactor.toFixed(2) : "—", pfColor(s.profitFactor)],
                            ["Avg R:R", s.avgRR > 0 ? s.avgRR.toFixed(2) : "—", "text-blue-400"],
                            ["Total", String(s.total), "text-foreground"],
                          ].map(([lbl, val, cls]) => (
                            <div key={lbl} className="bg-background border border-border/60 rounded px-2 py-1 text-center">
                              <div className="text-[9px] text-muted-foreground uppercase tracking-wider mb-0.5">{lbl}</div>
                              <div className={`font-mono font-bold ${cls}`}>{val}</div>
                            </div>
                          ))}
                        </div>
                        <div className="mt-2">
                          <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${wrBar(s.winRate)}`} style={{ width: `${wrPct}%` }} />
                          </div>
                          <div className="text-[9px] text-muted-foreground mt-1 text-right">
                            {s.tp_hit}W / {s.sl_hit}L / {s.expired}exp / {s.active} active
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* ── Memory Scorecard ── */}
            {(summary.memoryScorecard.noMemTotal > 0 || summary.memoryScorecard.withMemTotal > 0) && (
              <section>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                  <Brain size={10} /> Memory Scorecard
                  <span className="text-[9px] font-normal">(AI decisions: with vs without memory reflection)</span>
                </div>
                <div className="bg-card border border-border rounded p-3">
                  <div className="grid grid-cols-2 gap-4">
                    {([
                      { label: "No Memory", key: "noMem" as const, color: "text-muted-foreground", total: summary.memoryScorecard.noMemTotal, wr: summary.memoryScorecard.noMemWinRate, rr: summary.memoryScorecard.noMemAvgRR },
                      { label: "With Memory", key: "withMem" as const, color: "text-violet-400", total: summary.memoryScorecard.withMemTotal, wr: summary.memoryScorecard.withMemWinRate, rr: summary.memoryScorecard.withMemAvgRR },
                    ]).map(({ label, color, total, wr, rr }) => (
                      <div key={label}>
                        <div className={`text-[10px] font-semibold mb-1.5 ${color}`}>{label}</div>
                        <div className="grid grid-cols-3 gap-1.5 text-[10px]">
                          {[
                            ["Win Rate", `${Math.round(wr * 100)}%`, wrColor(wr)],
                            ["Avg R:R",  rr > 0 ? rr.toFixed(2) : "—", "text-blue-400"],
                            ["Decisions", String(total), "text-foreground"],
                          ].map(([lbl, val, cls]) => (
                            <div key={lbl} className="bg-background border border-border/60 rounded px-1.5 py-1 text-center">
                              <div className="text-[9px] text-muted-foreground uppercase tracking-wider mb-0.5">{lbl}</div>
                              <div className={`font-mono font-bold ${cls}`}>{val}</div>
                            </div>
                          ))}
                        </div>
                        <div className="mt-1.5 h-1 bg-muted rounded-full overflow-hidden">
                          <div className={`h-full rounded-full ${wrBar(wr)}`} style={{ width: `${Math.round(wr * 100)}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                  {summary.memoryScorecard.withMemTotal > 0 && summary.memoryScorecard.noMemTotal > 0 && (() => {
                    const delta = summary.memoryScorecard.withMemWinRate - summary.memoryScorecard.noMemWinRate;
                    const pct = Math.round(delta * 100);
                    const isPos = delta > 0.005;
                    const isNeg = delta < -0.005;
                    return (
                      <div className={`mt-2 text-[10px] font-mono text-center ${isPos ? "text-emerald-400" : isNeg ? "text-red-400" : "text-muted-foreground"}`}>
                        Memory {isPos ? "improved" : isNeg ? "reduced" : "had no net effect on"} win rate by {isPos ? "+" : ""}{pct}pp
                      </div>
                    );
                  })()}
                </div>
              </section>
            )}

            {/* ── AI Evolution ── */}
            {summary.weeklyTrend.length > 0 && (() => {
              const trend = summary.weeklyTrend;
              const last4 = trend.slice(-4).filter(t => t.total >= 3);
              const aiTrend: "improving" | "stable" | "declining" | "insufficient" = (() => {
                if (last4.length < 2) return "insufficient";
                const first = last4.slice(0, Math.ceil(last4.length / 2)).reduce((s, t) => s + t.winRate, 0) / Math.ceil(last4.length / 2);
                const last  = last4.slice(-Math.floor(last4.length / 2)).reduce((s, t) => s + t.winRate, 0) / Math.floor(last4.length / 2);
                const delta = last - first;
                return delta > 0.03 ? "improving" : delta < -0.03 ? "declining" : "stable";
              })();
              const trendColor = aiTrend === "improving" ? "text-emerald-400" : aiTrend === "declining" ? "text-red-400" : "text-amber-400";
              const trendLabel = aiTrend === "improving" ? "↑ Improving" : aiTrend === "declining" ? "↓ Declining" : aiTrend === "stable" ? "→ Stable" : "— Insufficient data";
              return (
                <section>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                    <Activity size={10} /> AI Evolution
                    <span className={`text-[10px] font-bold ${trendColor}`}>{trendLabel}</span>
                  </div>
                  <div className="bg-card border border-border rounded p-3 space-y-3">
                    {/* Win Rate sparkline */}
                    <div>
                      <div className="text-[10px] text-muted-foreground mb-1.5">Win Rate over time</div>
                      <Sparkline data={trend.map(t => t.winRate * 100)} color="#10b981" height={40} />
                      <div className="flex justify-between text-[9px] text-muted-foreground mt-0.5">
                        <span>{trend[0]?.week}</span>
                        <span>{trend[trend.length - 1]?.week}</span>
                      </div>
                    </div>
                    {/* Memory impact sparkline */}
                    <div>
                      <div className="text-[10px] text-muted-foreground mb-1.5">Memory Impact over time <span className="text-[9px]">(lessons/signals per week)</span></div>
                      <Sparkline data={trend.map(t => t.memoryImpact)} color="#a78bfa" height={30} />
                    </div>
                    {/* Weekly table */}
                    <div className="overflow-x-auto">
                      <table className="w-full text-[10px] font-mono">
                        <thead>
                          <tr className="text-muted-foreground border-b border-border">
                            <th className="text-left pb-1 font-normal">Week</th>
                            <th className="text-right pb-1 font-normal">Signals</th>
                            <th className="text-right pb-1 font-normal">Win Rate</th>
                            <th className="text-right pb-1 font-normal">Memory↑</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[...trend].reverse().map(t => (
                            <tr key={t.week} className="border-b border-border/30">
                              <td className="py-0.5 text-foreground">{t.week}</td>
                              <td className="py-0.5 text-right text-muted-foreground">{t.total}</td>
                              <td className={`py-0.5 text-right font-bold ${wrColor(t.winRate)}`}>{Math.round(t.winRate * 100)}%</td>
                              <td className="py-0.5 text-right text-violet-400">{t.memoryImpact > 0 ? t.memoryImpact.toFixed(2) : "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </section>
              );
            })()}

            {/* ── By Symbol leaderboard ── */}
            {symbolRows.length > 0 && (
              <section>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                  <Award size={10} /> Symbol Leaderboard
                </div>
                <div className="bg-card border border-border rounded overflow-hidden">
                  <TableHeader cols={["Symbol", "Total", "Win Rate", "PF", "Avg RR", "W/C"]} />
                  {symbolRows.map(([sym, s]) => (
                    <SliceRow key={sym} name={sym} s={s} />
                  ))}
                </div>
              </section>
            )}

            {/* ── By Regime ── */}
            {regimeRows.length > 0 && (
              <section>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                  <Shield size={10} /> Regime Breakdown
                </div>
                <div className="bg-card border border-border rounded overflow-hidden">
                  <TableHeader cols={["Regime", "Total", "Win Rate", "PF", "Avg RR", "W/C"]} />
                  {regimeRows.map(([regime, s]) => (
                    <SliceRow key={regime} name={REGIME_LABELS[regime] ?? regime} s={s} />
                  ))}
                </div>
              </section>
            )}

            {/* ── Setup / Pattern leaderboard ── */}
            {patternRows.length > 0 && (
              <section>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                  <TrendingUp size={10} /> Setup Leaderboard
                  <span className="text-[9px] font-normal">(min 3 closed)</span>
                </div>
                <div className="bg-card border border-border rounded overflow-hidden">
                  <TableHeader cols={["Pattern / Setup", "Total", "Win Rate", "PF", "Avg RR", "W/C"]} />
                  {patternRows.map(([pat, s]) => (
                    <SliceRow key={pat} name={pat.replace(/_/g, " ")} s={s} />
                  ))}
                </div>
              </section>
            )}

            {summary.global.total === 0 && (
              <div className="text-center py-16 text-xs text-muted-foreground">
                No signals in the database yet. Run signal generation first.
              </div>
            )}

            <div className="text-[10px] text-muted-foreground text-right">
              Updated {new Date(summary.updatedAt).toLocaleTimeString()}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
