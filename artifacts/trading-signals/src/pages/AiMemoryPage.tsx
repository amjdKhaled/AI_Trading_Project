import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Database, BookOpen, BarChart2, Activity, RefreshCw,
  TrendingUp, TrendingDown, Minus, AlertTriangle, Clock, Filter,
} from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

async function apiFetch<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`);
  const ct = r.headers.get("content-type") ?? "";
  if (!r.ok || !ct.includes("application/json")) {
    const body = await r.text().catch(() => "");
    throw new Error(`${path}: HTTP ${r.status}${body ? " — " + body.slice(0, 120) : ""}`);
  }
  return r.json() as Promise<T>;
}

// ── Regime display helpers ────────────────────────────────────

const REGIME_LABELS: Record<string, string> = {
  trending:      "Trending",
  vol_expansion: "High Volatility",
  ranging:       "Range Market",
  chop:          "Low Volatility",
  ai_generated:  "AI Generated",
};

function regimeLabel(regime: string, htfBias?: string): string {
  if (regime === "trending") {
    if (htfBias === "bull") return "Bull Market";
    if (htfBias === "bear") return "Bear Market";
    return "Trending";
  }
  return REGIME_LABELS[regime] ?? regime;
}

const REGIME_COLOR: Record<string, string> = {
  "Bull Market":     "text-emerald-400 bg-emerald-500/10 border-emerald-500/25",
  "Bear Market":     "text-red-400 bg-red-500/10 border-red-500/25",
  "Trending":        "text-blue-400 bg-blue-500/10 border-blue-500/25",
  "High Volatility": "text-amber-400 bg-amber-500/10 border-amber-500/25",
  "Range Market":    "text-violet-400 bg-violet-500/10 border-violet-500/25",
  "Low Volatility":  "text-slate-400 bg-slate-500/10 border-slate-500/25",
};

function regimeBadge(regime: string, htfBias?: string) {
  const label = regimeLabel(regime, htfBias);
  const cls = REGIME_COLOR[label] ?? "text-muted-foreground bg-muted border-border";
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${cls}`}>
      {label}
    </span>
  );
}

// ── Failure category ──────────────────────────────────────────

const FC_LABELS: Record<string, string> = {
  news_issue:           "News Issue",
  bad_entry:            "Bad Entry",
  poor_risk:            "Poor Risk",
  pattern_failure:      "Pattern Failure",
  false_breakout:       "False Breakout",
  weak_volume:          "Weak Volume",
  trend_reversal:       "Trend Reversal",
  regime_mismatch:      "Regime Mismatch",
  incorrect_confidence: "Wrong Confidence",
  unknown:              "Unknown",
};

const FC_COLOR: Record<string, string> = {
  news_issue:           "text-orange-400",
  bad_entry:            "text-red-400",
  poor_risk:            "text-rose-400",
  pattern_failure:      "text-amber-400",
  false_breakout:       "text-yellow-400",
  weak_volume:          "text-slate-400",
  trend_reversal:       "text-purple-400",
  regime_mismatch:      "text-blue-400",
  incorrect_confidence: "text-pink-400",
  unknown:              "text-muted-foreground",
};

// ── Shared components ─────────────────────────────────────────

function WrBar({ wins, total, size = "normal" }: { wins: number; total: number; size?: "small" | "normal" }) {
  const pct = total > 0 ? (wins / total) * 100 : 0;
  const color = pct >= 55 ? "bg-emerald-500" : pct >= 45 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <div className={`flex-1 ${size === "small" ? "h-0.5" : "h-1"} bg-muted rounded-full overflow-hidden`}>
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] font-mono text-muted-foreground w-16 text-right">
        {wins}/{total} ({pct.toFixed(0)}%)
      </span>
    </div>
  );
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  if (outcome === "tp_hit")  return <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/12 text-emerald-400 border border-emerald-500/25 font-medium">WIN</span>;
  if (outcome === "sl_hit")  return <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/12 text-red-400 border border-red-500/25 font-medium">LOSS</span>;
  return <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border font-medium">EXPIRED</span>;
}

// ── Types ─────────────────────────────────────────────────────

interface AiLesson {
  id: number;
  signalId: string;
  symbol: string;
  side: string;
  strategy: string;
  regime: string;
  session: string;
  htfBias: string;
  outcome: string;
  lesson: string;
  weaknesses: string[];
  failureCategory: string;
  trapType: string | null;
  continuationProbability: number;
  confidence: number;
  grade: string;
  rrRatio: number;
  entryPrice: number;
  exitPrice: number | null;
  createdAt: string;
}

interface AiPattern {
  id: number;
  symbol: string;
  regime: string;
  side: string;
  strategy: string;
  patternTags: string[];
  session: string;
  htfBias: string;
  outcome: string;
  confidence: number;
  rrRatio: number;
  volumeState: string;
  signalId: string;
  createdAt: string;
}

interface AiMarketRegime {
  id: number;
  symbol: string;
  timeframe: string;
  regime: string;
  htfBias: string;
  atr: number | null;
  rsi: number | null;
  macd: number | null;
  vwapDiff: number | null;
  snapshottedAt: string;
}

// ── Grouped pattern type ──────────────────────────────────────

interface PatternGroup {
  key: string;
  symbol: string;
  regime: string;
  htfBias: string;
  side: string;
  strategy: string;
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  avgRR: number;
}

// ── Tab: Lessons ──────────────────────────────────────────────

function LessonsTab({ lessons, loading }: { lessons: AiLesson[]; loading: boolean }) {
  const [symbolFilter, setSymbolFilter]     = useState("ALL");
  const [outcomeFilter, setOutcomeFilter]   = useState("ALL");
  const [fcFilter, setFcFilter]             = useState("ALL");
  const [expanded, setExpanded]             = useState<number | null>(null);

  const symbols = useMemo(() =>
    ["ALL", ...Array.from(new Set(lessons.map(l => l.symbol))).sort()], [lessons]);

  const filtered = useMemo(() => lessons.filter(l => {
    if (symbolFilter !== "ALL" && l.symbol !== symbolFilter) return false;
    if (outcomeFilter !== "ALL" && l.outcome !== outcomeFilter) return false;
    if (fcFilter !== "ALL" && l.failureCategory !== fcFilter) return false;
    return true;
  }), [lessons, symbolFilter, outcomeFilter, fcFilter]);

  if (loading) return <LoadingSkeleton />;

  return (
    <div className="space-y-3">
      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        <Filter size={11} className="text-muted-foreground" />
        <select value={symbolFilter} onChange={e => setSymbolFilter(e.target.value)}
          className="h-6 text-[11px] bg-background border border-border rounded px-1.5 text-foreground font-mono focus:outline-none">
          {symbols.map(s => <option key={s}>{s}</option>)}
        </select>
        <select value={outcomeFilter} onChange={e => setOutcomeFilter(e.target.value)}
          className="h-6 text-[11px] bg-background border border-border rounded px-1.5 text-foreground focus:outline-none">
          <option value="ALL">All Outcomes</option>
          <option value="tp_hit">Win (TP Hit)</option>
          <option value="sl_hit">Loss (SL Hit)</option>
          <option value="expired">Expired</option>
        </select>
        <select value={fcFilter} onChange={e => setFcFilter(e.target.value)}
          className="h-6 text-[11px] bg-background border border-border rounded px-1.5 text-foreground focus:outline-none">
          <option value="ALL">All Categories</option>
          {Object.entries(FC_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <span className="text-[10px] text-muted-foreground ml-auto">{filtered.length} lessons</span>
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <div className="text-center py-12 text-xs text-muted-foreground">
          No lessons match the current filters.
        </div>
      ) : (
        <div className="space-y-1.5">
          {filtered.map(l => (
            <div
              key={l.id}
              className="bg-card border border-border rounded overflow-hidden cursor-pointer hover:border-border/80 transition-colors"
              onClick={() => setExpanded(expanded === l.id ? null : l.id)}
            >
              {/* Row header */}
              <div className="flex items-start gap-2 p-2.5">
                <OutcomeBadge outcome={l.outcome} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap mb-1">
                    <span className="text-[11px] font-mono font-semibold text-foreground">{l.symbol}</span>
                    <span className={`text-[10px] font-medium ${l.side === "long" ? "text-emerald-400" : "text-red-400"}`}>
                      {l.side.toUpperCase()}
                    </span>
                    {regimeBadge(l.regime, l.htfBias)}
                    <span className="text-[10px] text-muted-foreground">{l.strategy}</span>
                    {l.failureCategory !== "unknown" && l.outcome !== "tp_hit" && (
                      <span className={`text-[10px] font-medium ${FC_COLOR[l.failureCategory] ?? "text-muted-foreground"}`}>
                        {FC_LABELS[l.failureCategory] ?? l.failureCategory}
                      </span>
                    )}
                    <span className="text-[10px] text-muted-foreground ml-auto">
                      {new Date(l.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </span>
                  </div>
                  <p className="text-[11px] text-foreground leading-relaxed">{l.lesson}</p>
                </div>
              </div>

              {/* Expanded detail */}
              {expanded === l.id && (
                <div className="border-t border-border bg-background/60 p-2.5 space-y-2">
                  <div className="grid grid-cols-4 gap-2">
                    {[
                      ["Confidence", `${l.confidence}%`, "text-foreground"],
                      ["Grade",      l.grade,             "text-blue-400"],
                      ["RR Ratio",   `${l.rrRatio?.toFixed(2) ?? "—"}`, "text-emerald-400"],
                      ["Cont. Prob", `${(l.continuationProbability * 100).toFixed(0)}%`, "text-amber-400"],
                    ].map(([lbl, val, cls]) => (
                      <div key={lbl} className="text-center bg-card rounded p-1.5 border border-border">
                        <div className="text-[9px] text-muted-foreground uppercase tracking-wider mb-0.5">{lbl}</div>
                        <div className={`text-xs font-mono font-semibold ${cls}`}>{val}</div>
                      </div>
                    ))}
                  </div>
                  {l.weaknesses?.length > 0 && (
                    <div>
                      <div className="text-[10px] text-muted-foreground mb-1 flex items-center gap-1">
                        <AlertTriangle size={9} /> Weaknesses
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {l.weaknesses.map((w, i) => (
                          <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                            {w}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {l.trapType && (
                    <div className="text-[11px] text-amber-400 flex items-center gap-1">
                      <AlertTriangle size={10} /> Trap detected: {l.trapType}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Tab: Patterns ─────────────────────────────────────────────

function PatternsTab({ patterns, loading }: { patterns: AiPattern[]; loading: boolean }) {
  const [symbolFilter, setSymbolFilter] = useState("ALL");
  const [sideFilter, setSideFilter]     = useState("ALL");

  const symbols = useMemo(() =>
    ["ALL", ...Array.from(new Set(patterns.map(p => p.symbol))).sort()], [patterns]);

  const filtered = useMemo(() => patterns.filter(p => {
    if (symbolFilter !== "ALL" && p.symbol !== symbolFilter) return false;
    if (sideFilter !== "ALL" && p.side !== sideFilter) return false;
    return true;
  }), [patterns, symbolFilter, sideFilter]);

  const groups = useMemo<PatternGroup[]>(() => {
    const map = new Map<string, AiPattern[]>();
    for (const p of filtered) {
      const key = `${p.symbol}|${p.regime}|${p.htfBias}|${p.side}|${p.strategy}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    }
    return Array.from(map.values()).map(rows => {
      const wins   = rows.filter(r => r.outcome === "tp_hit").length;
      const rrs    = rows.map(r => r.rrRatio).filter(r => r > 0);
      const avgRR  = rrs.length > 0 ? rrs.reduce((s, r) => s + r, 0) / rrs.length : 0;
      return {
        key:      `${rows[0].symbol}|${rows[0].regime}|${rows[0].htfBias}|${rows[0].side}|${rows[0].strategy}`,
        symbol:   rows[0].symbol,
        regime:   rows[0].regime,
        htfBias:  rows[0].htfBias,
        side:     rows[0].side,
        strategy: rows[0].strategy,
        total:    rows.length,
        wins,
        losses:   rows.length - wins,
        winRate:  rows.length > 0 ? wins / rows.length : 0,
        avgRR,
      };
    }).sort((a, b) => b.total - a.total);
  }, [filtered]);

  if (loading) return <LoadingSkeleton />;

  return (
    <div className="space-y-3">
      <div className="flex gap-2 items-center">
        <Filter size={11} className="text-muted-foreground" />
        <select value={symbolFilter} onChange={e => setSymbolFilter(e.target.value)}
          className="h-6 text-[11px] bg-background border border-border rounded px-1.5 text-foreground font-mono focus:outline-none">
          {symbols.map(s => <option key={s}>{s}</option>)}
        </select>
        <select value={sideFilter} onChange={e => setSideFilter(e.target.value)}
          className="h-6 text-[11px] bg-background border border-border rounded px-1.5 text-foreground focus:outline-none">
          <option value="ALL">Both Sides</option>
          <option value="long">Long Only</option>
          <option value="short">Short Only</option>
        </select>
        <span className="text-[10px] text-muted-foreground ml-auto">{groups.length} setups · {filtered.length} trades</span>
      </div>

      {groups.length === 0 ? (
        <div className="text-center py-12 text-xs text-muted-foreground">No pattern data yet.</div>
      ) : (
        <div className="grid grid-cols-1 gap-1.5">
          {groups.map(g => (
            <div key={g.key} className="bg-card border border-border rounded p-2.5">
              <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                <span className="text-[11px] font-mono font-bold text-foreground">{g.symbol}</span>
                <span className={`text-[10px] font-medium ${g.side === "long" ? "text-emerald-400" : "text-red-400"}`}>
                  {g.side === "long" ? <TrendingUp size={10} className="inline mr-0.5" /> : <TrendingDown size={10} className="inline mr-0.5" />}
                  {g.side.toUpperCase()}
                </span>
                {regimeBadge(g.regime, g.htfBias)}
                <span className="text-[10px] text-muted-foreground">{g.strategy}</span>
                <span className="ml-auto text-[10px] font-mono text-emerald-400">avg RR {g.avgRR.toFixed(2)}</span>
              </div>
              <WrBar wins={g.wins} total={g.total} size="small" />
              <div className="flex gap-3 mt-1 text-[10px] text-muted-foreground">
                <span className="text-emerald-400">{g.wins}W</span>
                <span className="text-red-400">{g.losses}L</span>
                <span>{g.total} trades</span>
                <span className="ml-auto font-mono font-semibold text-foreground">
                  {(g.winRate * 100).toFixed(0)}% WR
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Tab: Regimes ──────────────────────────────────────────────

function RegimesTab({ regimes, loading }: { regimes: AiMarketRegime[]; loading: boolean }) {
  const [symbolFilter, setSymbolFilter] = useState("ALL");

  const symbols = useMemo(() =>
    ["ALL", ...Array.from(new Set(regimes.map(r => r.symbol))).sort()], [regimes]);

  const filtered = useMemo(() =>
    regimes.filter(r => symbolFilter === "ALL" || r.symbol === symbolFilter), [regimes, symbolFilter]);

  const distribution = useMemo(() => {
    const dist: Record<string, number> = {};
    for (const r of filtered) {
      const label = regimeLabel(r.regime, r.htfBias);
      dist[label] = (dist[label] ?? 0) + 1;
    }
    const total = Object.values(dist).reduce((s, n) => s + n, 0);
    return Object.entries(dist)
      .map(([label, count]) => ({ label, count, pct: total > 0 ? count / total * 100 : 0 }))
      .sort((a, b) => b.count - a.count);
  }, [filtered]);

  if (loading) return <LoadingSkeleton />;

  return (
    <div className="space-y-4">
      <div className="flex gap-2 items-center">
        <Filter size={11} className="text-muted-foreground" />
        <select value={symbolFilter} onChange={e => setSymbolFilter(e.target.value)}
          className="h-6 text-[11px] bg-background border border-border rounded px-1.5 text-foreground font-mono focus:outline-none">
          {symbols.map(s => <option key={s}>{s}</option>)}
        </select>
        <span className="text-[10px] text-muted-foreground ml-auto">{filtered.length} snapshots</span>
      </div>

      {/* Distribution chart */}
      {distribution.length > 0 && (
        <div className="bg-card border border-border rounded p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Regime Distribution
          </div>
          <div className="space-y-2">
            {distribution.map(({ label, count, pct }) => {
              const cls = REGIME_COLOR[label] ?? "text-muted-foreground";
              const barCls = cls.split(" ").find(c => c.startsWith("text-"))
                ?.replace("text-", "bg-") ?? "bg-muted";
              return (
                <div key={label}>
                  <div className="flex justify-between text-[11px] mb-1">
                    <span className={cls.split(" ")[0]}>{label}</span>
                    <span className="font-mono text-muted-foreground">{count} ({pct.toFixed(0)}%)</span>
                  </div>
                  <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                    <div className={`h-full rounded-full ${barCls} opacity-70`} style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Recent regime timeline */}
      <div className="bg-card border border-border rounded p-3">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
          <Clock size={10} /> Recent Regime Timeline
        </div>
        {filtered.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No regime data yet. Regime snapshots are captured automatically each time you click "AI Decide".
          </p>
        ) : (
          <div className="space-y-1">
            {filtered.slice(0, 60).map(r => {
              const label = regimeLabel(r.regime, r.htfBias);
              const cls = REGIME_COLOR[label] ?? "text-muted-foreground bg-muted border-border";
              const ts = new Date(r.snapshottedAt);
              return (
                <div key={r.id} className="flex items-center gap-2 text-[11px] py-1 border-b border-border/40 last:border-0">
                  <span className="text-[10px] font-mono text-muted-foreground w-20 flex-shrink-0">
                    {ts.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    {" "}{ts.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}
                  </span>
                  <span className="font-mono font-bold text-foreground w-10 flex-shrink-0">{r.symbol}</span>
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${cls} flex-shrink-0`}>
                    {label}
                  </span>
                  <div className="flex gap-2 ml-auto text-[10px] font-mono text-muted-foreground">
                    {r.rsi   != null && <span>RSI {r.rsi.toFixed(0)}</span>}
                    {r.atr   != null && <span>ATR {r.atr.toFixed(2)}</span>}
                    {r.vwapDiff != null && (
                      <span className={r.vwapDiff >= 0 ? "text-emerald-400" : "text-red-400"}>
                        VWAP {r.vwapDiff > 0 ? "+" : ""}{r.vwapDiff.toFixed(1)}%
                      </span>
                    )}
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

// ── Tab: Setups (top historical similarity groups) ────────────

function SetupsTab({ memory, loading }: { memory: AiMemoryData | null; loading: boolean }) {
  if (loading) return <LoadingSkeleton />;
  const matches = memory?.topSimilarityMatches ?? [];

  if (matches.length === 0) {
    return (
      <div className="text-center py-12 text-xs text-muted-foreground">
        No historical setups yet. Run "AI Decide" multiple times to build the pattern database.
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="text-[10px] text-muted-foreground mb-2">
        Historical setup groups ranked by win rate (min 3 trades).
      </div>
      {matches.map((m, i) => (
        <div key={i} className="bg-card border border-border rounded p-2.5">
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <span className="text-[10px] font-mono text-muted-foreground">{i + 1}.</span>
            <span className="text-[11px] font-mono font-bold text-foreground">{m.symbol}</span>
            <span className={`text-[10px] font-medium ${m.side === "long" ? "text-emerald-400" : "text-red-400"}`}>
              {m.side === "long" ? <TrendingUp size={10} className="inline mr-0.5" /> : <TrendingDown size={10} className="inline mr-0.5" />}
              {m.side.toUpperCase()}
            </span>
            <span className="text-[10px] text-muted-foreground">{m.regime} · {m.strategy}</span>
            <span className="ml-auto text-[10px] font-mono text-emerald-400">avg RR {m.avgRR.toFixed(2)}</span>
          </div>
          <div className="flex items-center gap-2 mb-1">
            <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${m.winRate >= 0.55 ? "bg-emerald-500" : m.winRate >= 0.45 ? "bg-amber-500" : "bg-red-500"}`}
                style={{ width: `${m.winRate * 100}%` }}
              />
            </div>
            <span className="text-[11px] font-mono font-bold text-foreground">{(m.winRate * 100).toFixed(0)}% WR</span>
          </div>
          <div className="text-[10px] text-muted-foreground">{m.sampleSize} trades in history</div>
        </div>
      ))}
    </div>
  );
}

// ── Skeleton loader ───────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="space-y-2">
      {[1, 2, 3, 4, 5].map(i => (
        <div key={i} className="h-14 bg-muted rounded animate-pulse" />
      ))}
    </div>
  );
}

// ── Root data ─────────────────────────────────────────────────

interface AiMemoryData {
  totalTrades:            number;
  lessonsCount:           number;
  patternsCount:          number;
  similarityMatchesCount: number;
  topSimilarityMatches:   Array<{
    symbol: string; regime: string; side: string; strategy: string;
    winRate: number; sampleSize: number; avgRR: number;
  }>;
  regimeStats:   Record<string, { wins: number; losses: number; total: number }>;
  strategyStats: Record<string, { wins: number; losses: number; total: number }>;
  symbolStats:   Record<string, { wins: number; losses: number; total: number }>;
  recentLessons: string[];
  updatedAt:     string;
}

// ── Diagnostics types ─────────────────────────────────────────

interface DiagData {
  tables: {
    ai_lessons:        number;
    ai_patterns:       number;
    ai_market_regimes: number;
    ai_chart_analyses: number;
  };
  symbols:     string[];
  symbolCount: number;
}

// ── Main page ─────────────────────────────────────────────────

type TabId = "lessons" | "patterns" | "regimes" | "setups";

const TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: "lessons",  label: "Lessons",  icon: <BookOpen size={11} /> },
  { id: "patterns", label: "Patterns", icon: <Activity size={11} /> },
  { id: "regimes",  label: "Regimes",  icon: <BarChart2 size={11} /> },
  { id: "setups",   label: "Setups",   icon: <TrendingUp size={11} /> },
];

export default function AiMemoryPage() {
  const [activeTab, setActiveTab] = useState<TabId>("lessons");
  const [memory, setMemory]       = useState<AiMemoryData | null>(null);
  const [lessons, setLessons]     = useState<AiLesson[]>([]);
  const [patterns, setPatterns]   = useState<AiPattern[]>([]);
  const [regimes, setRegimes]     = useState<AiMarketRegime[]>([]);
  const [loading, setLoading]     = useState(true);
  const [tabLoading, setTabLoading] = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [diag, setDiag]             = useState<DiagData | null>(null);
  const [diagOpen, setDiagOpen]     = useState(false);

  const fetchMemory = useCallback(async () => {
    try {
      const m = await apiFetch<AiMemoryData & { ok: boolean }>(`/api/ai/memory`);
      setMemory(m);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const fetchDiag = useCallback(async () => {
    try {
      const d = await apiFetch<DiagData & { ok: boolean }>(`/api/ai/diagnostics`);
      setDiag(d);
    } catch { /* diagnostics are non-critical — ignore errors */ }
  }, []);

  const fetchTabData = useCallback(async (tab: TabId) => {
    setTabLoading(true);
    try {
      if (tab === "lessons") {
        const d = await apiFetch<{ lessons: AiLesson[] }>(`/api/ai/lessons?limit=300`);
        setLessons(d.lessons ?? []);
      } else if (tab === "patterns") {
        const d = await apiFetch<{ patterns: AiPattern[] }>(`/api/ai/patterns?limit=500`);
        setPatterns(d.patterns ?? []);
      } else if (tab === "regimes") {
        const d = await apiFetch<{ regimes: AiMarketRegime[] }>(`/api/ai/regimes?limit=500`);
        setRegimes(d.regimes ?? []);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTabLoading(false);
    }
  }, []);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    await Promise.all([fetchMemory(), fetchTabData("lessons"), fetchDiag()]);
    setLoading(false);
  }, [fetchMemory, fetchTabData, fetchDiag]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const handleTabChange = (tab: TabId) => {
    setActiveTab(tab);
    if (tab !== "setups") fetchTabData(tab);
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="space-y-2 w-72">
          {[1, 2, 3].map(i => <div key={i} className="h-8 bg-muted rounded animate-pulse" />)}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <div className="max-w-lg space-y-3">
          <p className="text-sm text-red-400">Could not load AI memory data</p>
          <pre className="text-[11px] bg-card border border-border rounded p-3 text-amber-300 whitespace-pre-wrap font-mono">{error}</pre>
          <button onClick={fetchAll}
            className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground font-medium hover:opacity-90 flex items-center gap-1.5">
            <RefreshCw size={11} /> Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-5 py-3.5 border-b border-border flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Database size={15} className="text-primary" />
            <div>
              <h1 className="text-sm font-semibold text-foreground">AI Memory Library</h1>
              <p className="text-[11px] text-muted-foreground mt-0.5">Lessons · Pattern History · Market Regimes · Historical Setups</p>
            </div>
          </div>
          <button onClick={fetchAll}
            className="p-1.5 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground">
            <RefreshCw size={13} />
          </button>
        </div>

        {/* KPIs */}
        <div className="grid grid-cols-4 gap-2 mt-3">
          {[
            { label: "Lessons",  value: memory?.lessonsCount ?? 0,           color: "text-emerald-400" },
            { label: "Patterns", value: memory?.patternsCount ?? 0,          color: "text-blue-400" },
            { label: "Setups",   value: memory?.similarityMatchesCount ?? 0, color: "text-violet-400" },
            { label: "Symbols",  value: Object.keys(memory?.symbolStats ?? {}).length, color: "text-amber-400" },
          ].map(k => (
            <div key={k.label} className="bg-card border border-border rounded px-3 py-2 text-center">
              <div className="text-[9px] text-muted-foreground uppercase tracking-wider mb-0.5">{k.label}</div>
              <div className={`text-xl font-mono font-bold ${k.color}`}>{k.value}</div>
            </div>
          ))}
        </div>

        {/* Diagnostics panel */}
        <div className="mt-2">
          <button
            onClick={() => setDiagOpen(o => !o)}
            className="flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
          >
            <Database size={10} />
            <span>Diagnostics</span>
            <span className="text-[9px] opacity-50">{diagOpen ? "▲" : "▼"}</span>
          </button>

          {diagOpen && (
            <div className="mt-2 bg-card border border-border rounded overflow-hidden">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <th className="text-left px-3 py-1.5 text-muted-foreground font-medium">Table</th>
                    <th className="text-right px-3 py-1.5 text-muted-foreground font-medium">DB (raw)</th>
                    <th className="text-right px-3 py-1.5 text-muted-foreground font-medium">API summary</th>
                    <th className="text-right px-3 py-1.5 text-muted-foreground font-medium">Loaded</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    {
                      name: "ai_lessons",
                      db:      diag?.tables.ai_lessons        ?? "—",
                      api:     memory?.lessonsCount            ?? "—",
                      loaded:  lessons.length,
                    },
                    {
                      name: "ai_patterns",
                      db:      diag?.tables.ai_patterns        ?? "—",
                      api:     memory?.patternsCount           ?? "—",
                      loaded:  patterns.length,
                    },
                    {
                      name: "ai_market_regimes",
                      db:      diag?.tables.ai_market_regimes  ?? "—",
                      api:     "—",
                      loaded:  regimes.length,
                    },
                    {
                      name: "ai_chart_analyses",
                      db:      diag?.tables.ai_chart_analyses  ?? "—",
                      api:     "—",
                      loaded:  "—",
                    },
                  ].map(row => {
                    const mismatch = typeof row.db === "number" && typeof row.api === "number" && row.db !== row.api;
                    return (
                      <tr key={row.name} className={`border-b border-border/50 last:border-0 ${mismatch ? "bg-amber-500/5" : ""}`}>
                        <td className="px-3 py-1.5 font-mono text-muted-foreground">{row.name}</td>
                        <td className={`text-right px-3 py-1.5 font-mono ${mismatch ? "text-amber-400 font-bold" : "text-foreground"}`}>{String(row.db)}</td>
                        <td className={`text-right px-3 py-1.5 font-mono ${mismatch ? "text-amber-400 font-bold" : "text-foreground"}`}>{String(row.api)}</td>
                        <td className="text-right px-3 py-1.5 font-mono text-muted-foreground">{String(row.loaded)}</td>
                      </tr>
                    );
                  })}
                  <tr className="border-t border-border bg-muted/20">
                    <td className="px-3 py-1.5 font-mono text-muted-foreground">symbols</td>
                    <td className="text-right px-3 py-1.5 font-mono text-foreground">{diag?.symbolCount ?? "—"}</td>
                    <td className="text-right px-3 py-1.5 font-mono text-foreground">{Object.keys(memory?.symbolStats ?? {}).length || "—"}</td>
                    <td className="text-right px-3 py-1.5 font-mono text-muted-foreground">
                      {diag?.symbols.join(", ") || "—"}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-0.5 px-5 pt-2 border-b border-border flex-shrink-0">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => handleTabChange(t.id)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors border-b-2 -mb-px ${
              activeTab === t.id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0 overflow-auto p-4">
        {activeTab === "lessons"  && <LessonsTab  lessons={lessons}   loading={tabLoading} />}
        {activeTab === "patterns" && <PatternsTab patterns={patterns} loading={tabLoading} />}
        {activeTab === "regimes"  && <RegimesTab  regimes={regimes}   loading={tabLoading} />}
        {activeTab === "setups"   && <SetupsTab   memory={memory}     loading={false} />}
      </div>
    </div>
  );
}
