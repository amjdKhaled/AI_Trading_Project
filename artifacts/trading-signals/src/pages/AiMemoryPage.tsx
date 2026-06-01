import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Database, BookOpen, BarChart2, Activity, RefreshCw,
  TrendingUp, TrendingDown, Minus, AlertTriangle, Clock, Filter,
  GraduationCap, Zap, Brain, CheckCircle, XCircle, Play,
} from "lucide-react";
import { setReplayMarkers, clearReplayMarkers } from "@/lib/replayStore";
import { useActiveSymbol } from "@/lib/ActiveSymbolContext";

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
  news_issue:                "News Issue",
  bad_entry:                 "Bad Entry",
  poor_risk:                 "Poor Risk",
  pattern_failure:           "Pattern Failure",
  false_breakout:            "False Breakout",
  weak_volume:               "Weak Volume",
  trend_reversal:            "Trend Reversal",
  regime_mismatch:           "Regime Mismatch",
  incorrect_confidence:      "Wrong Confidence",
  entry_timing:              "Entry Timing",
  stop_placement:            "Stop Placement",
  takeprofit_placement:      "TP Placement",
  support_resistance_failure:"S/R Failure",
  trend_structure_break:     "Structure Break",
  unknown:                   "Unknown",
};

const FC_COLOR: Record<string, string> = {
  news_issue:                "text-orange-400",
  bad_entry:                 "text-red-400",
  poor_risk:                 "text-rose-400",
  pattern_failure:           "text-amber-400",
  false_breakout:            "text-yellow-400",
  weak_volume:               "text-slate-400",
  trend_reversal:            "text-purple-400",
  regime_mismatch:           "text-blue-400",
  incorrect_confidence:      "text-pink-400",
  entry_timing:              "text-red-300",
  stop_placement:            "text-rose-300",
  takeprofit_placement:      "text-amber-300",
  support_resistance_failure:"text-orange-300",
  trend_structure_break:     "text-violet-400",
  unknown:                   "text-muted-foreground",
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
  reasoning: string;
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

// ── Batch progress types ───────────────────────────────────────

interface BatchProgress {
  running:          boolean;
  total:            number;
  alreadyProcessed: number;
  processed:        number;
  failed:           number;
  aiUsed:           boolean;
  startedAt:        number;
  completedAt?:     number;
}

interface LearnAllResult {
  ok:               boolean;
  total:            number;
  alreadyProcessed: number;
  processed:        number;
  failed:           number;
  symbols:          string[];
  aiUsed:           boolean;
}

// ── Grouped pattern type ───────────────────────────────────────

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

                  {/* Lesson text (full — may be truncated in the summary row) */}
                  <div>
                    <div className="text-[10px] text-muted-foreground mb-1 flex items-center gap-1 uppercase tracking-wider">
                      <BookOpen size={9} /> Generated Lesson
                    </div>
                    <p className="text-[11px] text-foreground leading-relaxed bg-muted/20 rounded px-2 py-1.5 border border-border/40">
                      {l.lesson}
                    </p>
                  </div>

                  {/* AI Reasoning — populated only when Qwen3 was used */}
                  {l.reasoning ? (
                    <div>
                      <div className="text-[10px] text-violet-400 mb-1 flex items-center gap-1 uppercase tracking-wider">
                        <Brain size={9} /> Qwen3 Analysis
                      </div>
                      <p className="text-[11px] text-foreground/90 leading-relaxed bg-violet-500/5 rounded px-2 py-1.5 border border-violet-500/20 whitespace-pre-line">
                        {l.reasoning}
                      </p>
                    </div>
                  ) : (
                    <div className="text-[10px] text-muted-foreground italic flex items-center gap-1.5">
                      <Brain size={9} /> No AI reasoning — lesson generated by statistical rules
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

// ── Tools tab types ───────────────────────────────────────────

interface OllamaStatus {
  available: boolean;
  model:     string;
  endpoint:  string;
  message:   string;
}

interface ClosedSignal {
  signalId:   string;
  side:       string;
  pattern:    string | null;
  state:      string;
  barTime:    string;
  confidence: number;
}

interface ReflectResult {
  ok:          boolean;
  signalId:    string;
  aiUsed:      boolean;
  reflection?: {
    lesson:                  string;
    weaknesses:              string[];
    trapType:                string | null;
    continuationProbability: number;
    reasoning:               string;
  };
  warning?: string;
  error?:   string;
}

// ── Replay types ─────────────────────────────────────────────
interface ReplayPassStats {
  approve: number; wait: number; reject: number;
  total: number; approveRate: number;
  avgConf: number; avgRR: number;
  winRate: number; profitFactor: number; maxDrawdown: number; simulated: number;
  avgTradeGrade: string;
  topLessons: string[]; topRejectLessons: string[];
}
interface ReplayCandleResult {
  candleTime: number;
  noMem:   { decision: string; confidence: number; entry: number | null; stopLoss: number | null; takeProfit: number | null; rr: number | null };
  withMem: { decision: string; confidence: number; entry: number | null; stopLoss: number | null; takeProfit: number | null; rr: number | null; lessons: string[]; memoryUsed: boolean };
}
interface ReplayDecisionDiff {
  candleTime: number;
  direction: "memory_added" | "memory_removed" | "conf_boost" | "conf_drop";
  noMemVerdict: string; withMemVerdict: string;
  noMemConf: number; withMemConf: number;
  keyLesson: string | null;
}
interface ReplayJobResult {
  symbol: string; timeframe: string; processed: number;
  candles?: ReplayCandleResult[];
  noMem:   ReplayPassStats;
  withMem: ReplayPassStats;
  delta:   { removedByMemory: number; addedByMemory: number; changedByMemory: number; avgConfChange: number; approveRateDelta: number };
  learningScore: number;
  decisionDiffs: ReplayDecisionDiff[];
}

// ── Tab: Tools (Ollama + Reflect + Import) ─────────────────────

interface ToolsTabProps {
  ollamaStatus:   OllamaStatus | null;
  activeSymbol:   string | null;
  closedSignals:  ClosedSignal[];
  reflectId:      string;
  setReflectId:   (id: string) => void;
  reflecting:     boolean;
  reflectResult:  ReflectResult | null;
  onReflect:      () => void;
  batchSymbol:    string;
  setBatchSymbol: (s: string) => void;
  batching:       boolean;
  batchResult:    string | null;
  onBatchImport:  () => void;
  // Replay
  replaySymbol:   string;
  setReplaySymbol:(s: string) => void;
  replayTf:       string;
  setReplayTf:    (s: string) => void;
  replayLimit:    number;
  setReplayLimit: (n: number) => void;
  replayRunning:  boolean;
  replayProgress: number;
  replayTotal:    number;
  replayResult:   ReplayJobResult | null;
  replayError:    string | null;
  onStartReplay:  () => void;
}

function ToolsTab({
  ollamaStatus, activeSymbol, closedSignals,
  reflectId, setReflectId, reflecting, reflectResult, onReflect,
  batchSymbol, setBatchSymbol, batching, batchResult, onBatchImport,
  replaySymbol, setReplaySymbol, replayTf, setReplayTf,
  replayLimit, setReplayLimit, replayRunning, replayProgress,
  replayTotal, replayResult, replayError, onStartReplay,
}: ToolsTabProps) {
  return (
    <div className="max-w-lg space-y-4">
      {/* Ollama status */}
      <div className="bg-card border border-border rounded p-3">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2.5 flex items-center gap-1.5">
          <Brain size={11} /> AI Engine Status
        </div>
        {ollamaStatus ? (
          <div className="space-y-2">
            <div className={`flex items-center gap-2 text-[11px] px-2.5 py-1.5 rounded border ${
              ollamaStatus.available
                ? "border-emerald-500/30 bg-emerald-500/8 text-emerald-400"
                : "border-red-500/30 bg-red-500/8 text-red-400"
            }`}>
              {ollamaStatus.available ? <CheckCircle size={12} /> : <XCircle size={12} />}
              <span className="font-mono font-medium">
                {ollamaStatus.available ? "Ollama online" : "Ollama offline"}
              </span>
            </div>
            {ollamaStatus.available && (
              <div className="text-[10px] text-muted-foreground font-mono">
                model: {ollamaStatus.model} · {ollamaStatus.endpoint}
              </div>
            )}
            {!ollamaStatus.available && (
              <div className="text-[11px] text-amber-400/90 flex items-start gap-1.5">
                <AlertTriangle size={11} className="flex-shrink-0 mt-0.5" />
                <span>{ollamaStatus.message}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="text-[11px] text-muted-foreground">Checking…</div>
        )}
      </div>

      {/* Bootstrap Memory */}
      <div className="bg-card border border-border rounded p-3">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
          <BookOpen size={11} /> Bootstrap Memory
        </div>
        <p className="text-[11px] text-muted-foreground mb-2.5">
          Store all closed trades for a symbol into memory (fast, no AI required).
        </p>
        <input
          value={batchSymbol}
          onChange={e => setBatchSymbol(e.target.value.toUpperCase())}
          placeholder="TSLA"
          className="w-full h-7 text-xs bg-background border border-border rounded px-2 mb-2 text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <button
          onClick={onBatchImport}
          disabled={batching || !batchSymbol.trim()}
          className="w-full h-7 text-xs rounded bg-primary text-primary-foreground font-medium hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-1.5"
        >
          {batching
            ? <><RefreshCw size={11} className="animate-spin" /> Importing…</>
            : "Import Trades"}
        </button>
        {batchResult && (
          <p className="mt-2 text-[11px] text-muted-foreground">{batchResult}</p>
        )}
      </div>

      {/* Reflect on Trade */}
      <div className="bg-card border border-border rounded p-3">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
          <Brain size={11} /> Reflect on Trade
        </div>
        <p className="text-[11px] text-muted-foreground mb-2.5">
          {ollamaStatus?.available
            ? "Pick a closed trade for Ollama to analyze and extract a lesson."
            : "Ollama offline — reflection stores trade data without AI lesson."}
        </p>
        {closedSignals.length === 0 ? (
          <p className="text-[11px] text-muted-foreground italic mb-2">
            No closed signals for {activeSymbol ?? "this symbol"} yet.
          </p>
        ) : (
          <select
            value={reflectId}
            onChange={e => setReflectId(e.target.value)}
            className="w-full h-7 text-[11px] bg-background border border-border rounded px-1.5 mb-2 text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-ring"
          >
            {closedSignals.map(s => {
              const date = new Date(s.barTime).toLocaleDateString("en-US", { month: "short", day: "numeric" });
              return (
                <option key={s.signalId} value={s.signalId}>
                  {s.side.toUpperCase()} · {s.pattern ?? "signal"} · {date} · {s.state.replace("_", " ")}
                </option>
              );
            })}
          </select>
        )}
        <button
          onClick={onReflect}
          disabled={reflecting || !reflectId.trim() || closedSignals.length === 0}
          className="w-full h-7 text-xs rounded bg-primary text-primary-foreground font-medium hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-1.5"
        >
          {reflecting
            ? <><RefreshCw size={11} className="animate-spin" /> Reflecting…</>
            : <><Zap size={11} /> Run Reflection</>}
        </button>
        {reflectResult && (
          <div className="mt-3 space-y-2">
            <div className={`flex items-center gap-1.5 text-[11px] font-medium ${reflectResult.ok ? "text-emerald-400" : "text-red-400"}`}>
              {reflectResult.ok ? <CheckCircle size={11} /> : <XCircle size={11} />}
              {reflectResult.ok
                ? (reflectResult.aiUsed ? "AI reflection complete" : "Stored (no AI)")
                : "Failed"}
            </div>
            {reflectResult.reflection && (
              <div className="text-[11px] text-foreground bg-background rounded p-2 border border-border">
                <div className="text-[10px] text-muted-foreground mb-1">Lesson</div>
                {reflectResult.reflection.lesson}
              </div>
            )}
            {reflectResult.reflection?.reasoning && (
              <div className="text-[11px] text-muted-foreground bg-background rounded p-2 border border-border">
                <div className="text-[10px] text-muted-foreground mb-1">Reasoning</div>
                {reflectResult.reflection.reasoning}
              </div>
            )}
            {reflectResult.warning && (
              <div className="text-[11px] text-amber-400">{reflectResult.warning}</div>
            )}
            {reflectResult.error && (
              <div className="text-[11px] text-red-400">{reflectResult.error}</div>
            )}
          </div>
        )}
      </div>

      {/* Chart Replay */}
      <div className="bg-card border border-border rounded p-3">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
          <Play size={11} /> Chart Replay — Memory vs No-Memory
        </div>
        <p className="text-[11px] text-muted-foreground mb-2.5">
          Re-runs AI decisions on historical candles twice — first without memory, then with memory — and shows a comparison report. Memory-enhanced APPROVE signals appear as violet diamonds on the chart.
        </p>
        <div className="flex gap-2 mb-2">
          <input
            value={replaySymbol}
            onChange={e => setReplaySymbol(e.target.value.toUpperCase())}
            placeholder={activeSymbol ?? "TSLA"}
            className="flex-1 h-7 text-xs bg-background border border-border rounded px-2 text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <select
            value={replayTf}
            onChange={e => setReplayTf(e.target.value)}
            className="h-7 text-[11px] bg-background border border-border rounded px-1.5 text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="5m">5m</option>
            <option value="15m">15m</option>
            <option value="1h">1h</option>
          </select>
          <input
            type="number"
            min={5} max={200}
            value={replayLimit}
            onChange={e => setReplayLimit(Math.max(5, Math.min(200, Number(e.target.value))))}
            className="w-14 h-7 text-xs bg-background border border-border rounded px-2 text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-ring"
            title="Number of candles"
          />
        </div>
        <button
          onClick={onStartReplay}
          disabled={replayRunning}
          className="w-full h-7 text-xs rounded bg-violet-600 text-white font-medium hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-1.5"
        >
          {replayRunning
            ? <><RefreshCw size={11} className="animate-spin" /> Replaying…</>
            : <><Play size={11} /> Run Replay</>}
        </button>
        {replayRunning && replayTotal > 0 && (
          <div className="space-y-0.5">
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>Progress</span>
              <span>{replayProgress} / {replayTotal} candles</span>
            </div>
            <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-violet-500 rounded-full transition-all duration-300"
                style={{ width: `${Math.round((replayProgress / replayTotal) * 100)}%` }}
              />
            </div>
          </div>
        )}
        {replayError && (
          <p className="mt-2 text-[11px] text-red-400">{replayError}</p>
        )}
        {replayResult && (
          <div className="mt-3 space-y-2">
            {/* Header: candle count + Learning Score badge */}
            <div className="flex items-center gap-2">
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex-1">
                {replayResult.processed} candles · {replayResult.symbol} {replayResult.timeframe}
              </div>
              {(() => {
                const ls = replayResult.learningScore;
                const col = ls >= 70 ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                          : ls >= 45 ? "bg-amber-500/15 text-amber-400 border-amber-500/30"
                          : "bg-red-500/15 text-red-400 border-red-500/30";
                return (
                  <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded border ${col}`}>
                    Learning Score {ls}/100
                  </span>
                );
              })()}
            </div>

            {/* Comparison table — two passes side by side */}
            <div className="text-[10px] font-mono">
              <div className="grid grid-cols-3 gap-x-1 mb-0.5">
                <div className="text-muted-foreground" />
                <div className="text-center text-muted-foreground">No Memory</div>
                <div className="text-center text-violet-400">With Memory</div>
              </div>
              {([
                {
                  label: "Total decisions",
                  noVal: String(replayResult.noMem.total),
                  memVal: String(replayResult.withMem.total),
                  noNum: undefined, memNum: undefined,
                },
                {
                  label: "Approve rate",
                  noVal: `${Math.round(replayResult.noMem.approveRate * 100)}%`,
                  memVal: `${Math.round(replayResult.withMem.approveRate * 100)}%`,
                  noNum: replayResult.noMem.approveRate,
                  memNum: replayResult.withMem.approveRate,
                },
                {
                  label: "Approve ✓",
                  noVal: String(replayResult.noMem.approve),
                  memVal: String(replayResult.withMem.approve),
                  noNum: replayResult.noMem.approve,
                  memNum: replayResult.withMem.approve,
                },
                {
                  label: "Wait ~",
                  noVal: String(replayResult.noMem.wait),
                  memVal: String(replayResult.withMem.wait),
                  noNum: undefined, memNum: undefined,
                  fixedClass: "text-amber-400",
                },
                {
                  label: "Reject ✗",
                  noVal: String(replayResult.noMem.reject),
                  memVal: String(replayResult.withMem.reject),
                  noNum: undefined, memNum: undefined,
                  fixedClass: "text-red-400",
                },
                {
                  label: "Avg conf",
                  noVal: String(replayResult.noMem.avgConf),
                  memVal: String(replayResult.withMem.avgConf),
                  noNum: replayResult.noMem.avgConf,
                  memNum: replayResult.withMem.avgConf,
                },
                {
                  label: "Avg R:R",
                  noVal: replayResult.noMem.avgRR > 0 ? replayResult.noMem.avgRR.toFixed(2) : "—",
                  memVal: replayResult.withMem.avgRR > 0 ? replayResult.withMem.avgRR.toFixed(2) : "—",
                  noNum: replayResult.noMem.avgRR,
                  memNum: replayResult.withMem.avgRR,
                },
                {
                  label: `Win Rate (${replayResult.withMem.simulated} sim)`,
                  noVal: replayResult.noMem.simulated > 0 ? `${Math.round(replayResult.noMem.winRate * 100)}%` : "—",
                  memVal: replayResult.withMem.simulated > 0 ? `${Math.round(replayResult.withMem.winRate * 100)}%` : "—",
                  noNum: replayResult.noMem.winRate,
                  memNum: replayResult.withMem.winRate,
                },
                {
                  label: "Profit Factor",
                  noVal: replayResult.noMem.simulated > 0 ? replayResult.noMem.profitFactor.toFixed(2) : "—",
                  memVal: replayResult.withMem.simulated > 0 ? replayResult.withMem.profitFactor.toFixed(2) : "—",
                  noNum: replayResult.noMem.profitFactor,
                  memNum: replayResult.withMem.profitFactor,
                },
                {
                  label: "Avg Trade Grade",
                  noVal: replayResult.noMem.simulated > 0 ? replayResult.noMem.avgTradeGrade : "—",
                  memVal: replayResult.withMem.simulated > 0 ? replayResult.withMem.avgTradeGrade : "—",
                  noNum: undefined, memNum: undefined,
                  fixedClass: (() => {
                    const g = replayResult.withMem.avgTradeGrade;
                    return g === "A" ? "text-emerald-400" : g === "B" ? "text-blue-400" : g === "C" ? "text-amber-400" : "text-red-400";
                  })(),
                },
                {
                  label: "Max Drawdown",
                  noVal: replayResult.noMem.simulated > 0 ? `${replayResult.noMem.maxDrawdown.toFixed(1)}R` : "—",
                  memVal: replayResult.withMem.simulated > 0 ? `${replayResult.withMem.maxDrawdown.toFixed(1)}R` : "—",
                  noNum: replayResult.noMem.maxDrawdown,
                  memNum: replayResult.withMem.maxDrawdown,
                  lowerIsBetter: true,
                },
              ] as Array<{ label: string; noVal: string; memVal: string; noNum?: number; memNum?: number; fixedClass?: string; lowerIsBetter?: boolean }>).map((row, i) => {
                let memClass = "text-foreground";
                if (row.fixedClass) {
                  memClass = row.fixedClass;
                } else if (row.memNum !== undefined && row.noNum !== undefined) {
                  const better = row.lowerIsBetter ? row.memNum < row.noNum : row.memNum > row.noNum;
                  const worse  = row.lowerIsBetter ? row.memNum > row.noNum : row.memNum < row.noNum;
                  if (better) memClass = "text-emerald-400";
                  else if (worse) memClass = "text-amber-400";
                }
                return (
                  <div key={i} className="grid grid-cols-3 gap-x-1 py-0.5 border-t border-border/40">
                    <div className="text-muted-foreground truncate">{row.label}</div>
                    <div className="text-center text-foreground">{row.noVal}</div>
                    <div className={`text-center ${memClass}`}>{row.memVal}</div>
                  </div>
                );
              })}
            </div>

            {/* Delta summary */}
            <div className="flex gap-2 text-[10px] font-mono flex-wrap">
              <span className={replayResult.delta.addedByMemory > 0 ? "text-emerald-400" : "text-muted-foreground"}>
                +{replayResult.delta.addedByMemory} added
              </span>
              <span className="text-muted-foreground">·</span>
              <span className={replayResult.delta.removedByMemory > 0 ? "text-amber-400" : "text-muted-foreground"}>
                −{replayResult.delta.removedByMemory} removed
              </span>
              <span className="text-muted-foreground">·</span>
              <span className={replayResult.delta.changedByMemory > 0 ? "text-blue-400" : "text-muted-foreground"}>
                ~{replayResult.delta.changedByMemory} changed
              </span>
              <span className="text-muted-foreground">·</span>
              <span className={replayResult.delta.approveRateDelta >= 0 ? "text-emerald-400" : "text-red-400"}>
                AR {replayResult.delta.approveRateDelta >= 0 ? "+" : ""}{Math.round(replayResult.delta.approveRateDelta * 100)}%
              </span>
              <span className="text-muted-foreground">·</span>
              <span className={replayResult.delta.avgConfChange >= 0 ? "text-emerald-400" : "text-red-400"}>
                conf {replayResult.delta.avgConfChange >= 0 ? "+" : ""}{replayResult.delta.avgConfChange}
              </span>
            </div>

            {/* Decision diffs */}
            {replayResult.decisionDiffs.length > 0 && (
              <div className="text-[10px]">
                <div className="font-semibold text-muted-foreground mb-1">
                  Decision divergences ({replayResult.decisionDiffs.length})
                </div>
                <div className="space-y-0.5 max-h-28 overflow-y-auto">
                  {replayResult.decisionDiffs.slice(0, 15).map((d, i) => {
                    const ts = new Date(d.candleTime * 1000);
                    const label = d.direction === "memory_added"   ? { text: "+MEM",   cls: "text-emerald-400" }
                                : d.direction === "memory_removed" ? { text: "−MEM",   cls: "text-amber-400" }
                                : d.direction === "conf_boost"     ? { text: "↑CONF",  cls: "text-blue-400" }
                                :                                    { text: "↓CONF",  cls: "text-red-400" };
                    return (
                      <div key={i} className="flex flex-col border-l-2 border-border/40 pl-1.5 py-0.5 gap-0.5">
                        <div className="flex items-center gap-2 font-mono text-muted-foreground">
                          <span className="text-[9px] w-16 flex-shrink-0">
                            {ts.toLocaleDateString([], { month: "short", day: "numeric" })} {ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                          </span>
                          <span className={`font-bold flex-shrink-0 w-10 ${label.cls}`}>{label.text}</span>
                          <span className="text-[9px]">{d.noMemVerdict}→{d.withMemVerdict}</span>
                          <span className="text-[9px] ml-auto">{d.noMemConf}→{d.withMemConf}</span>
                        </div>
                        {d.keyLesson && (
                          <div className="text-[9px] text-violet-300/80 truncate pl-26" style={{ paddingLeft: "6.5rem" }}>
                            ↳ {d.keyLesson}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {replayResult.decisionDiffs.length > 15 && (
                    <div className="text-[9px] text-muted-foreground/60 pl-1.5">
                      +{replayResult.decisionDiffs.length - 15} more divergences
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Top lessons memory applied */}
            {replayResult.withMem.topLessons.length > 0 && (
              <div className="text-[10px] text-muted-foreground">
                <div className="font-semibold text-foreground mb-1">Top lessons applied by memory</div>
                <ul className="space-y-0.5">
                  {replayResult.withMem.topLessons.map((l, i) => (
                    <li key={i} className="truncate">· {l}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Top failure categories */}
            {replayResult.withMem.topRejectLessons.length > 0 && (
              <div className="text-[10px] text-muted-foreground">
                <div className="font-semibold text-amber-400 mb-1">Top failure categories (memory still said no)</div>
                <ul className="space-y-0.5">
                  {replayResult.withMem.topRejectLessons.map((l, i) => (
                    <li key={i} className="truncate">· {l}</li>
                  ))}
                </ul>
              </div>
            )}

            <p className="text-[10px] text-violet-400/80">
              Violet ◇ diamonds on the chart = memory-enhanced APPROVE signals
            </p>
          </div>
        )}
      </div>
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

// ── AI Decision Stats ─────────────────────────────────────────

interface AiDecisionRegimeStat {
  tp_hit:  number;
  sl_hit:  number;
  expired: number;
  total:   number;
  winRate: number;
}

interface AiDecisionStatsData {
  total:    number;
  resolved: number;
  tp_hit:   number;
  sl_hit:   number;
  expired:  number;
  winRate:  number;
  avgRR:    number;
  byRegime: Record<string, AiDecisionRegimeStat>;
}

interface RecentDecisionMemory {
  candleTime:           number;
  candidateSide:        string;
  verdict:              string;
  confidence:           number;
  regime:               string;
  memoryUsed?:          boolean;
  lessonsLoaded?:       number;
  winnerAnalysisLoaded?: boolean;
  failureStatsLoaded?:   boolean;
  recentLossLoaded?:     boolean;
  memoryImpactScore?:   number;
}

function AiDecisionStatsCard({
  stats,
  loading,
  activeSymbol,
}: {
  stats:         AiDecisionStatsData | null;
  loading:       boolean;
  activeSymbol?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [recentDecisions, setRecentDecisions] = useState<RecentDecisionMemory[]>([]);
  const [recentDLoading, setRecentDLoading]   = useState(false);

  useEffect(() => {
    if (!expanded) return;
    setRecentDLoading(true);
    const qs = activeSymbol ? `?symbol=${encodeURIComponent(activeSymbol)}&limit=10` : "?limit=10";
    fetch(`${BASE}/api/signals/ai-recent-decisions${qs}`)
      .then(r => r.ok ? r.json() : null)
      .then((data: { ok: boolean; decisions: RecentDecisionMemory[] } | null) => {
        setRecentDecisions(data?.decisions ?? []);
      })
      .catch(() => {})
      .finally(() => setRecentDLoading(false));
  }, [expanded, activeSymbol]);

  if (loading) {
    return <div className="h-24 bg-muted rounded animate-pulse" />;
  }

  if (!stats) return null;

  const { total, resolved, tp_hit, sl_hit, expired, winRate, avgRR, byRegime } = stats;
  const closed   = tp_hit + sl_hit;
  const wrPct    = Math.round(winRate * 100);
  const wrColor  = wrPct >= 55 ? "text-emerald-400" : wrPct >= 45 ? "text-amber-400" : "text-red-400";
  const barColor = wrPct >= 55 ? "bg-emerald-500" : wrPct >= 45 ? "bg-amber-500" : "bg-red-500";

  const regimeRows = Object.entries(byRegime)
    .map(([regime, s]) => ({ regime, ...s }))
    .sort((a, b) => b.total - a.total);

  return (
    <div className="mt-3 bg-card border border-border rounded overflow-hidden">
      {/* Header row */}
      <button
        onClick={() => setExpanded(o => !o)}
        className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-muted/30 transition-colors text-left"
      >
        <Zap size={11} className="text-primary flex-shrink-0" />
        <span className="text-[11px] font-semibold text-foreground flex-1">AI Decision Engine Performance</span>
        {resolved === 0 ? (
          <span className="text-[10px] text-muted-foreground">No resolved decisions yet</span>
        ) : (
          <span className={`text-[11px] font-mono font-bold ${wrColor}`}>
            {wrPct}% WR
          </span>
        )}
        <span className="text-[9px] text-muted-foreground opacity-50 ml-1">{expanded ? "▲" : "▼"}</span>
      </button>

      {/* Always-visible mini summary */}
      {resolved > 0 && (
        <div className="px-3 pb-2.5 grid grid-cols-5 gap-1.5">
          {[
            { label: "Total",    value: total,    color: "text-foreground" },
            { label: "Resolved", value: resolved, color: "text-muted-foreground" },
            { label: "Wins",     value: tp_hit,   color: "text-emerald-400" },
            { label: "Losses",   value: sl_hit,   color: "text-red-400" },
            { label: "Avg R:R",  value: avgRR.toFixed(2), color: "text-blue-400" },
          ].map(({ label, value, color }) => (
            <div key={label} className="bg-background border border-border rounded px-2 py-1.5 text-center">
              <div className="text-[9px] text-muted-foreground uppercase tracking-wider mb-0.5">{label}</div>
              <div className={`text-xs font-mono font-semibold ${color}`}>{value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Win rate bar */}
      {resolved > 0 && (
        <div className="px-3 pb-2.5">
          <div className="flex items-center gap-2">
            <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden">
              <div className={`h-full rounded-full ${barColor}`} style={{ width: `${wrPct}%` }} />
            </div>
            <span className="text-[10px] font-mono text-muted-foreground w-24 text-right">
              {tp_hit}W / {closed} closed ({wrPct}%)
            </span>
          </div>
          {expired > 0 && (
            <div className="text-[10px] text-muted-foreground mt-0.5">
              {expired} expired (not counted in WR)
            </div>
          )}
        </div>
      )}

      {/* Expanded: regime breakdown */}
      {expanded && regimeRows.length > 0 && (
        <div className="border-t border-border bg-background/60 px-3 py-2.5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            By Regime
          </div>
          <div className="space-y-1.5">
            {regimeRows.map(({ regime, tp_hit: tw, sl_hit: sl, expired: ex, total: tot, winRate: wr }) => {
              const rPct   = Math.round(wr * 100);
              const rColor = rPct >= 55 ? "bg-emerald-500" : rPct >= 45 ? "bg-amber-500" : "bg-red-500";
              const label  = REGIME_LABELS[regime] ?? regime;
              return (
                <div key={regime}>
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-[10px] text-muted-foreground w-24 truncate flex-shrink-0">{label}</span>
                    <div className="flex-1 h-0.5 bg-muted rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${rColor}`} style={{ width: `${rPct}%` }} />
                    </div>
                    <span className="text-[10px] font-mono text-muted-foreground w-20 text-right flex-shrink-0">
                      {tw}W/{tw + sl}C {ex > 0 ? `+${ex}exp` : ""} ({rPct}%)
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {expanded && (
        <div className="border-t border-border bg-background/60 px-3 py-2.5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            Recent Decision Memory Diagnostics
          </div>
          {recentDLoading ? (
            <div className="h-8 bg-muted/40 rounded animate-pulse" />
          ) : recentDecisions.length === 0 ? (
            <p className="text-[10px] text-muted-foreground">No decisions recorded yet.</p>
          ) : (
            <div className="space-y-1.5">
              {recentDecisions.map((d) => {
                const ts   = new Date(d.candleTime * 1000);
                const hhmm = ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                const date = ts.toLocaleDateString([], { month: "short", day: "numeric" });
                const vColor =
                  d.verdict === "APPROVE" ? "text-emerald-400" :
                  d.verdict === "REJECT"  ? "text-red-400"     : "text-amber-400";
                const sColor =
                  d.candidateSide === "long"  ? "text-emerald-400" :
                  d.candidateSide === "short" ? "text-red-400"     : "text-muted-foreground";
                const memOk   = d.memoryUsed === true;
                const impScore = d.memoryImpactScore ?? 0;
                const impColor = impScore >= 70 ? "text-violet-400" : impScore >= 40 ? "text-blue-400" : "text-muted-foreground";
                return (
                  <div key={d.candleTime} className="flex items-center gap-1.5 text-[10px] font-mono border border-border/40 rounded px-2 py-1 bg-background/40">
                    <span className="text-muted-foreground w-16 flex-shrink-0">{date} {hhmm}</span>
                    <span className={`w-10 font-semibold flex-shrink-0 ${vColor}`}>{d.verdict.slice(0, 3)}</span>
                    <span className={`w-10 flex-shrink-0 ${sColor}`}>{d.candidateSide === "no_trade" ? "–" : d.candidateSide.toUpperCase()}</span>
                    <span className="text-muted-foreground w-14 flex-shrink-0 truncate">{d.regime || "–"}</span>
                    {/* Memory Used badge */}
                    <span className={`px-1 py-0 rounded text-[9px] border flex-shrink-0 ${
                      memOk
                        ? "bg-violet-500/10 text-violet-400 border-violet-500/20"
                        : "bg-muted/30 text-muted-foreground border-border/40"
                    }`}>
                      {memOk ? "MEM ✓" : "MEM ✗"}
                    </span>
                    {/* Lessons count */}
                    {memOk && (
                      <span className="text-muted-foreground flex-shrink-0">
                        {d.lessonsLoaded ?? 0}L
                      </span>
                    )}
                    {/* Active source pills */}
                    {memOk && (
                      <div className="flex gap-0.5 flex-shrink-0">
                        {d.winnerAnalysisLoaded && <span className="text-[8px] px-0.5 rounded bg-emerald-500/10 text-emerald-400">W</span>}
                        {d.failureStatsLoaded   && <span className="text-[8px] px-0.5 rounded bg-red-500/10 text-red-400">F</span>}
                        {d.recentLossLoaded     && <span className="text-[8px] px-0.5 rounded bg-amber-500/10 text-amber-400">L</span>}
                      </div>
                    )}
                    {/* Impact score */}
                    {memOk && (
                      <span className={`ml-auto flex-shrink-0 font-bold ${impColor}`}>
                        {impScore}
                      </span>
                    )}
                  </div>
                );
              })}
              <p className="text-[9px] text-muted-foreground mt-1">
                MEM=memory used · L=lessons · W=winner · F=failure · L=loss · score=impact (0-100)
              </p>
            </div>
          )}
        </div>
      )}
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

type TabId = "lessons" | "patterns" | "regimes" | "setups" | "tools";

const TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: "lessons",  label: "Lessons",  icon: <BookOpen size={11} /> },
  { id: "patterns", label: "Patterns", icon: <Activity size={11} /> },
  { id: "regimes",  label: "Regimes",  icon: <BarChart2 size={11} /> },
  { id: "setups",   label: "Setups",   icon: <TrendingUp size={11} /> },
  { id: "tools",    label: "Tools",    icon: <Brain size={11} /> },
];

export default function AiMemoryPage() {
  const { activeSymbol } = useActiveSymbol();
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
  const [learningAll, setLearningAll] = useState(false);
  const [learnWithAi, setLearnWithAi] = useState(false);
  const [learnResult, setLearnResult] = useState<LearnAllResult | null>(null);
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(null);
  const [decisionStats, setDecisionStats] = useState<AiDecisionStatsData | null>(null);
  const [decisionStatsLoading, setDecisionStatsLoading] = useState(false);

  // ── Tools tab state ─────────────────────────────────────────
  const [ollamaStatus,  setOllamaStatus]  = useState<OllamaStatus | null>(null);
  const [reflectId,     setReflectId]     = useState("");
  const [reflecting,    setReflecting]    = useState(false);
  const [reflectResult, setReflectResult] = useState<ReflectResult | null>(null);
  const [closedSignals, setClosedSignals] = useState<ClosedSignal[]>([]);
  const [batchSymbol,   setBatchSymbol]   = useState("");
  const [batching,      setBatching]      = useState(false);
  const [batchResult,   setBatchResult]   = useState<string | null>(null);

  // ── Replay tab state ────────────────────────────────────────
  const [replaySymbol,   setReplaySymbol]   = useState("");
  const [replayTf,       setReplayTf]       = useState("5m");
  const [replayLimit,    setReplayLimit]    = useState(50);
  const [replayJobId,    setReplayJobId]    = useState<string | null>(null);
  const [replayRunning,  setReplayRunning]  = useState(false);
  const [replayProgress, setReplayProgress] = useState(0);
  const [replayTotal,    setReplayTotal]    = useState(0);
  const [replayResult,   setReplayResult]   = useState<ReplayJobResult | null>(null);
  const [replayError,    setReplayError]    = useState<string | null>(null);

  // ── Replay handlers ──────────────────────────────────────────
  const handleStartReplay = useCallback(async () => {
    const sym = (replaySymbol.trim() || activeSymbol || "").toUpperCase();
    if (!sym) return;
    setReplayRunning(true);
    setReplayResult(null);
    setReplayError(null);
    setReplayProgress(0);
    clearReplayMarkers();
    try {
      const res = await fetch(`${BASE}/api/signals/replay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: sym, timeframe: replayTf, limit: replayLimit }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { jobId: string };
      setReplayJobId(data.jobId);
    } catch (e) {
      setReplayError((e as Error).message);
      setReplayRunning(false);
    }
  }, [activeSymbol, replaySymbol, replayTf, replayLimit]);

  // Poll for replay job completion
  useEffect(() => {
    if (!replayJobId) return;
    let cancelled = false;
    const poll = async () => {
      while (!cancelled) {
        await new Promise<void>(r => setTimeout(r, 1800));
        if (cancelled) break;
        try {
          const status = await apiFetch<{
            status: "running" | "done" | "error";
            progress: number; total: number;
            result?: ReplayJobResult; error?: string;
          }>(`/api/signals/replay/${replayJobId}`);
          if (cancelled) break;
          setReplayProgress(status.progress);
          setReplayTotal(status.total);
          if (status.status === "done" && status.result) {
            setReplayResult(status.result);
            setReplayRunning(false);
            setReplayJobId(null);
            // Push memory-enhanced APPROVE candles as chart markers
            const markers = (status.result.candles ?? [])
              .filter(c =>
                (c.withMem.decision === "LONG" || c.withMem.decision === "SHORT") &&
                c.withMem.confidence >= 80,
              )
              .map(c => ({
                candleTime: c.candleTime,
                decision:   c.withMem.decision as "LONG" | "SHORT",
                confidence: c.withMem.confidence,
                entry:      c.withMem.entry,
                stopLoss:   c.withMem.stopLoss,
                takeProfit: c.withMem.takeProfit,
                rrRatio:    c.withMem.rr,
              }));
            const sym = (replaySymbol.trim() || activeSymbol || "").toUpperCase();
            setReplayMarkers(`${sym}-${replayTf}`, markers);
            break;
          } else if (status.status === "error") {
            setReplayError(status.error ?? "Unknown error");
            setReplayRunning(false);
            setReplayJobId(null);
            break;
          }
        } catch { /* keep polling on transient network errors */ }
      }
    };
    void poll();
    return () => { cancelled = true; };
  }, [replayJobId, activeSymbol, replaySymbol, replayTf]);

  const fetchMemory = useCallback(async () => {
    try {
      const m = await apiFetch<AiMemoryData & { ok: boolean }>(`/api/ai/memory`);
      setMemory(m);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const fetchDecisionStats = useCallback(async () => {
    setDecisionStatsLoading(true);
    try {
      const params = activeSymbol ? `?symbol=${encodeURIComponent(activeSymbol)}&timeframe=5m` : "";
      const s = await apiFetch<AiDecisionStatsData>(`/api/signals/ai-decision-stats${params}`);
      setDecisionStats(s);
    } catch { /* non-critical */ }
    finally { setDecisionStatsLoading(false); }
  }, [activeSymbol]);

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
    await Promise.all([fetchMemory(), fetchTabData("lessons"), fetchDiag(), fetchDecisionStats()]);
    setLoading(false);
  }, [fetchMemory, fetchTabData, fetchDiag, fetchDecisionStats]);

  const fetchOllama = useCallback(async () => {
    try {
      const s = await apiFetch<OllamaStatus>(`/api/ai/status`);
      setOllamaStatus(s);
    } catch { /* non-critical */ }
  }, []);

  const handleReflect = useCallback(async () => {
    if (!reflectId.trim()) return;
    setReflecting(true);
    setReflectResult(null);
    try {
      const r = await fetch(`${BASE}/api/ai/reflect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signalId: reflectId.trim(), useAi: ollamaStatus?.available }),
      });
      const d = await r.json() as ReflectResult;
      setReflectResult(d);
      if (d.ok) void fetchMemory();
    } catch (e) {
      setReflectResult({ ok: false, signalId: reflectId, aiUsed: false, error: String(e) });
    } finally {
      setReflecting(false);
    }
  }, [reflectId, ollamaStatus, fetchMemory]);

  const handleBatchImport = useCallback(async () => {
    if (!batchSymbol.trim()) return;
    setBatching(true);
    setBatchResult(null);
    try {
      const r = await fetch(`${BASE}/api/ai/reflect/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: batchSymbol.toUpperCase(), useAi: false, limit: 200 }),
      });
      const d = await r.json() as { processed: number; errors: number; total: number };
      setBatchResult(`Stored ${d.processed}/${d.total} trades. Errors: ${d.errors}`);
      void fetchAll();
    } catch (e) {
      setBatchResult(`Error: ${String(e)}`);
    } finally {
      setBatching(false);
    }
  }, [batchSymbol, fetchAll]);

  const handleLearnAll = useCallback(async () => {
    setLearningAll(true);
    setLearnResult(null);
    setBatchProgress(null);
    try {
      const r = await fetch(`${BASE}/api/ai/learn-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ useAi: learnWithAi }),
      });
      const d = await r.json() as LearnAllResult;
      if (d.ok) {
        setLearnResult(d);
        await fetchAll();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLearningAll(false);
    }
  }, [fetchAll, learnWithAi]);

  useEffect(() => { fetchAll(); }, [fetchAll]);
  useEffect(() => { fetchOllama(); }, [fetchOllama]);
  useEffect(() => { void fetchDecisionStats(); }, [fetchDecisionStats]);

  // Poll /api/ai/learn-progress every 2 s while a batch is running
  useEffect(() => {
    if (!learningAll) return;
    const poll = async () => {
      try {
        const p = await apiFetch<{ ok: boolean; progress: BatchProgress | null }>(`/api/ai/learn-progress`);
        if (p.progress) setBatchProgress(p.progress);
      } catch { /* non-critical */ }
    };
    void poll();
    const id = setInterval(() => { void poll(); }, 2000);
    return () => clearInterval(id);
  }, [learningAll]);

  // Load closed signals for the active symbol (for Reflect dropdown)
  useEffect(() => {
    if (!activeSymbol) return;
    fetch(`${BASE}/api/signals?symbol=${encodeURIComponent(activeSymbol)}&timeframe=5m&limit=200`)
      .then(r => r.ok ? r.json() : [])
      .then((rows: ClosedSignal[]) => {
        const closed = Array.isArray(rows) ? rows.filter(r => r.state !== "active") : [];
        setClosedSignals(closed);
        if (closed.length > 0 && !reflectId) setReflectId(closed[0].signalId);
      })
      .catch(() => setClosedSignals([]));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSymbol]);

  // Default batch symbol to active symbol
  useEffect(() => {
    if (activeSymbol && !batchSymbol) setBatchSymbol(activeSymbol);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSymbol]);

  const handleTabChange = (tab: TabId) => {
    setActiveTab(tab);
    if (tab !== "setups" && tab !== "tools") fetchTabData(tab);
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
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Database size={15} className="text-primary" />
            <div>
              <h1 className="text-sm font-semibold text-foreground">AI Memory Library</h1>
              <p className="text-[11px] text-muted-foreground mt-0.5">Lessons · Pattern History · Market Regimes · Historical Setups</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Auto Learn status — always ON: server auto-reflects every closed trade */}
            <span className="flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <Zap size={9} /> Auto Learn: ON
            </span>

            {/* AI Reflection toggle — same visual family as Auto Learn: ON */}
            <button
              onClick={() => !learningAll && setLearnWithAi(v => !v)}
              disabled={learningAll}
              title="Uses Qwen3 to analyze every trade and generate lessons."
              className={`flex items-center gap-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                learnWithAi
                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                  : "bg-muted/20 text-muted-foreground border-border"
              }`}
            >
              <span className={`relative inline-flex h-3.5 w-6 flex-shrink-0 items-center rounded-full transition-colors duration-200 ${learnWithAi ? "bg-emerald-500" : "bg-muted"}`}>
                <span className={`absolute h-2.5 w-2.5 rounded-full bg-white shadow-sm transition-transform duration-200 ${learnWithAi ? "translate-x-3" : "translate-x-0.5"}`} />
              </span>
              AI Reflection
            </button>
            <button
              onClick={handleLearnAll}
              disabled={learningAll}
              title={learnWithAi ? "Analyze all trades with Qwen3 (slower, richer lessons)" : "Analyze all trades with fast statistical rules"}
              className="flex items-center gap-1.5 px-2 py-1 text-[11px] rounded border border-border text-muted-foreground hover:text-foreground hover:border-foreground/40 transition-colors disabled:opacity-50 disabled:cursor-wait"
            >
              {learningAll
                ? <RefreshCw size={11} className="animate-spin" />
                : <GraduationCap size={11} />}
              {learningAll ? "Learning…" : "Learn Everything"}
            </button>

            <button onClick={fetchAll}
              className="p-1.5 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground">
              <RefreshCw size={13} />
            </button>
          </div>
        </div>

        {/* Batch progress / result panel */}
        {(learningAll || learnResult) && (() => {
          const p = batchProgress;
          const doneSoFar = p ? p.alreadyProcessed + p.processed + p.failed : 0;
          const remaining = p ? Math.max(0, p.total - p.alreadyProcessed - p.processed - p.failed) : 0;
          const pct       = p && p.total > 0 ? Math.round((doneSoFar / p.total) * 100) : 0;
          const elapsedMin = p ? (Date.now() - p.startedAt) / 60000 : 0;
          const rate      = p && elapsedMin > 0 ? p.processed / elapsedMin : 0;
          const etaMin    = rate > 0 && remaining > 0 ? Math.ceil(remaining / rate) : null;

          return (
            <div className="mt-2 rounded border border-border bg-card overflow-hidden text-[11px]">
              {/* Header */}
              <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/20">
                {learningAll
                  ? <RefreshCw size={11} className="animate-spin text-primary flex-shrink-0" />
                  : <GraduationCap size={11} className="text-emerald-400 flex-shrink-0" />}
                <span className="font-medium text-foreground">
                  {learningAll ? "Learning in progress…" : "Batch complete"}
                </span>
                {!learningAll && learnResult && (
                  <button onClick={() => setLearnResult(null)} className="ml-auto text-muted-foreground hover:text-foreground">×</button>
                )}
              </div>

              {/* Live progress (while running) */}
              {learningAll && p && (
                <div className="px-3 py-2.5 space-y-2">
                  {/* Progress bar */}
                  <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary rounded-full transition-all duration-500"
                      style={{ width: `${pct}%` }}
                    />
                  </div>

                  {/* Stats grid */}
                  <div className="grid grid-cols-4 gap-1.5">
                    {[
                      { label: "Processed",  value: `${p.processed}`,           color: "text-emerald-400" },
                      { label: "Skipped",    value: `${p.alreadyProcessed}`,    color: "text-blue-400" },
                      { label: "Remaining",  value: `${remaining}`,             color: "text-amber-400" },
                      { label: "Failed",     value: `${p.failed}`,              color: p.failed > 0 ? "text-red-400" : "text-muted-foreground" },
                    ].map(({ label, value, color }) => (
                      <div key={label} className="bg-background border border-border rounded px-2 py-1.5 text-center">
                        <div className="text-[9px] text-muted-foreground uppercase tracking-wider mb-0.5">{label}</div>
                        <div className={`text-sm font-mono font-bold ${color}`}>{value}</div>
                      </div>
                    ))}
                  </div>

                  {/* Progress line */}
                  <div className="flex items-center justify-between text-muted-foreground">
                    <span>{doneSoFar} / {p.total} trades ({pct}%)</span>
                    {etaMin !== null && (
                      <span className="flex items-center gap-1">
                        <Clock size={9} />
                        ~{etaMin} min remaining
                        {rate > 0 && <span className="text-[10px]">({rate.toFixed(1)}/min)</span>}
                      </span>
                    )}
                  </div>

                  {/* Model info */}
                  <div className="text-muted-foreground">
                    {p.aiUsed ? "🧠 Qwen3 AI reflection" : "⚡ Fast statistical rules"}
                  </div>
                </div>
              )}

              {/* Final result (after completion) */}
              {!learningAll && learnResult && (
                <div className="px-3 py-2.5 space-y-2">
                  <div className="grid grid-cols-4 gap-1.5">
                    {[
                      { label: "New Lessons",    value: learnResult.processed,        color: "text-emerald-400" },
                      { label: "Already Had",    value: learnResult.alreadyProcessed, color: "text-blue-400" },
                      { label: "Total Signals",  value: learnResult.total,            color: "text-foreground" },
                      { label: "Failed",         value: learnResult.failed,           color: learnResult.failed > 0 ? "text-red-400" : "text-muted-foreground" },
                    ].map(({ label, value, color }) => (
                      <div key={label} className="bg-background border border-border rounded px-2 py-1.5 text-center">
                        <div className="text-[9px] text-muted-foreground uppercase tracking-wider mb-0.5">{label}</div>
                        <div className={`text-sm font-mono font-bold ${color}`}>{value}</div>
                      </div>
                    ))}
                  </div>
                  <div className="text-muted-foreground">
                    {learnResult.symbols.length} symbol{learnResult.symbols.length !== 1 ? "s" : ""}
                    {" "}({learnResult.symbols.join(", ")})
                    {" "}· {learnResult.aiUsed ? "AI-reflected" : "fast rules"}
                  </div>
                </div>
              )}
            </div>
          );
        })()}

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

        {/* AI Decision Engine stats */}
        <AiDecisionStatsCard stats={decisionStats} loading={decisionStatsLoading} activeSymbol={activeSymbol} />

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
        {activeTab === "tools"    && <ToolsTab
          ollamaStatus={ollamaStatus}
          activeSymbol={activeSymbol}
          closedSignals={closedSignals}
          reflectId={reflectId}
          setReflectId={setReflectId}
          reflecting={reflecting}
          reflectResult={reflectResult}
          onReflect={handleReflect}
          batchSymbol={batchSymbol}
          setBatchSymbol={setBatchSymbol}
          batching={batching}
          batchResult={batchResult}
          onBatchImport={handleBatchImport}
          replaySymbol={replaySymbol}
          setReplaySymbol={setReplaySymbol}
          replayTf={replayTf}
          setReplayTf={setReplayTf}
          replayLimit={replayLimit}
          setReplayLimit={setReplayLimit}
          replayRunning={replayRunning}
          replayProgress={replayProgress}
          replayTotal={replayTotal}
          replayResult={replayResult}
          replayError={replayError}
          onStartReplay={handleStartReplay}
        />}
      </div>
    </div>
  );
}
