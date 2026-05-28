import { useState, useEffect, useCallback } from "react";
import { Brain, CheckCircle, XCircle, AlertTriangle, BookOpen, BarChart2, TrendingUp, TrendingDown, RefreshCw, Zap } from "lucide-react";
import { useActiveSymbol } from "@/lib/ActiveSymbolContext";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface AiStatus {
  available: boolean;
  model: string;
  endpoint: string;
  message: string;
}

interface MemorySummary {
  totalTrades: number;
  regimeStats: Record<string, { wins: number; losses: number; total: number }>;
  strategyStats: Record<string, { wins: number; losses: number; total: number }>;
  symbolStats: Record<string, { wins: number; losses: number; total: number }>;
  recentLessons: string[];
  updatedAt: string;
}

interface ReflectResult {
  ok: boolean;
  signalId: string;
  aiUsed: boolean;
  reflection?: {
    lesson: string;
    weaknesses: string[];
    trapType: string | null;
    continuationProbability: number;
    reasoning: string;
  };
  warning?: string;
  error?: string;
}

function WrBar({ wins, total }: { wins: number; total: number }) {
  const pct = total > 0 ? (wins / total) * 100 : 0;
  const color = pct >= 55 ? "bg-emerald-500" : pct >= 45 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] font-mono text-muted-foreground w-14 text-right">
        {wins}/{total} ({pct.toFixed(0)}%)
      </span>
    </div>
  );
}

export default function AiPage() {
  const { activeSymbol } = useActiveSymbol();
  const [status, setStatus]     = useState<AiStatus | null>(null);
  const [memory, setMemory]     = useState<MemorySummary | null>(null);
  const [loading, setLoading]   = useState(true);
  const [reflectId, setReflectId]     = useState("");
  const [reflectResult, setReflectResult] = useState<ReflectResult | null>(null);
  const [reflecting, setReflecting]       = useState(false);
  const [batchSymbol, setBatchSymbol]     = useState(activeSymbol ?? "NVDA");
  const [batching, setBatching]           = useState(false);
  const [batchResult, setBatchResult]     = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"overview" | "regime" | "strategy" | "lessons">("overview");

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [s, m] = await Promise.all([
        fetch(`${BASE}/api/ai/status`).then(r => r.json()),
        fetch(`${BASE}/api/ai/memory`).then(r => r.json()),
      ]);
      setStatus(s as AiStatus);
      setMemory(m as MemorySummary);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Keep batch import symbol in sync with the chart's active symbol
  useEffect(() => {
    if (activeSymbol) setBatchSymbol(activeSymbol);
  }, [activeSymbol]);

  async function handleReflect() {
    if (!reflectId.trim()) return;
    setReflecting(true);
    setReflectResult(null);
    try {
      const r = await fetch(`${BASE}/api/ai/reflect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signalId: reflectId.trim(), useAi: status?.available }),
      });
      const data = await r.json() as ReflectResult;
      setReflectResult(data);
      fetchAll();
    } catch (e) {
      setReflectResult({ ok: false, signalId: reflectId, aiUsed: false, error: String(e) });
    } finally {
      setReflecting(false);
    }
  }

  async function handleBatch() {
    if (!batchSymbol.trim()) return;
    setBatching(true);
    setBatchResult(null);
    try {
      const r = await fetch(`${BASE}/api/ai/reflect/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: batchSymbol.toUpperCase(), useAi: false, limit: 200 }),
      });
      const data = await r.json() as { processed: number; errors: number; total: number };
      setBatchResult(`Stored ${data.processed}/${data.total} trades. Errors: ${data.errors}`);
      fetchAll();
    } catch (e) {
      setBatchResult(`Error: ${String(e)}`);
    } finally {
      setBatching(false);
    }
  }

  const topRegimes    = Object.entries(memory?.regimeStats ?? {}).sort((a, b) => b[1].total - a[1].total).slice(0, 6);
  const topStrategies = Object.entries(memory?.strategyStats ?? {}).sort((a, b) => b[1].total - a[1].total).slice(0, 8);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="space-y-2 w-64">
          {[1,2,3].map(i => <div key={i} className="h-8 bg-muted rounded animate-pulse" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Brain size={16} className="text-primary" />
            <div>
              <h1 className="text-base font-semibold text-foreground">AI Analysis Engine</h1>
              <p className="text-xs text-muted-foreground mt-0.5">Local Ollama · Trade Memory · Signal Reflection</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {status && (
              <div className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded border ${
                status.available
                  ? "border-emerald-500/30 bg-emerald-500/8 text-emerald-400"
                  : "border-red-500/30 bg-red-500/8 text-red-400"
              }`}>
                {status.available
                  ? <CheckCircle size={11} />
                  : <XCircle size={11} />}
                <span className="font-mono text-[11px]">{status.available ? "Ollama online" : "Ollama offline"}</span>
              </div>
            )}
            <button
              onClick={fetchAll}
              className="p-1.5 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
            >
              <RefreshCw size={13} />
            </button>
          </div>
        </div>

        {/* Status detail */}
        {status && !status.available && (
          <div className="mt-3 p-2.5 rounded border border-amber-500/30 bg-amber-500/8 text-xs text-amber-300">
            <AlertTriangle size={11} className="inline mr-1" />
            {status.message}
            <span className="ml-2 font-mono text-amber-400">ollama serve && ollama pull {status.model}</span>
          </div>
        )}
        {status?.available && (
          <div className="mt-2 text-[10px] text-muted-foreground font-mono">
            model: {status.model} · endpoint: {status.endpoint}
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Left: memory stats */}
        <div className="flex-1 overflow-auto p-4 space-y-4">
          {/* KPI row */}
          <div className="grid grid-cols-4 gap-2">
            {[
              { label: "Trades in Memory", value: memory?.totalTrades ?? 0, color: "text-foreground", icon: <BookOpen size={13} className="text-muted-foreground" /> },
              { label: "Regimes Tracked", value: Object.keys(memory?.regimeStats ?? {}).length, color: "text-blue-400", icon: <BarChart2 size={13} className="text-blue-400" /> },
              { label: "Strategies", value: Object.keys(memory?.strategyStats ?? {}).length, color: "text-amber-400", icon: <Zap size={13} className="text-amber-400" /> },
              { label: "Lessons Stored", value: memory?.recentLessons.length ?? 0, color: "text-emerald-400", icon: <Brain size={13} className="text-emerald-400" /> },
            ].map(k => (
              <div key={k.label} className="bg-card border border-border rounded p-3">
                <div className="flex items-center justify-between mb-1">{k.icon}<span className="text-[10px] text-muted-foreground">{k.label}</span></div>
                <div className={`text-2xl font-mono font-bold ${k.color}`}>{k.value}</div>
              </div>
            ))}
          </div>

          {/* Tabs */}
          <div className="flex gap-1 border-b border-border">
            {(["overview","regime","strategy","lessons"] as const).map(t => (
              <button
                key={t}
                onClick={() => setActiveTab(t)}
                className={`px-3 py-1.5 text-xs font-medium capitalize transition-colors border-b-2 -mb-px ${
                  activeTab === t
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          {activeTab === "overview" && (
            <div className="grid grid-cols-2 gap-4">
              {/* Symbol stats */}
              <div className="bg-card border border-border rounded p-3">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">Symbol Performance</div>
                {Object.keys(memory?.symbolStats ?? {}).length === 0 ? (
                  <p className="text-xs text-muted-foreground">No trades in memory yet. Use batch import below.</p>
                ) : (
                  <div className="space-y-2">
                    {Object.entries(memory?.symbolStats ?? {}).map(([sym, s]) => (
                      <div key={sym}>
                        <div className="flex justify-between text-[11px] mb-0.5">
                          <span className="font-mono font-semibold text-foreground">{sym}</span>
                          <span className="text-muted-foreground">{s.total} trades</span>
                        </div>
                        <WrBar wins={s.wins} total={s.total} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {/* Top strategies quick view */}
              <div className="bg-card border border-border rounded p-3">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">Top Strategies</div>
                {topStrategies.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No trades in memory yet.</p>
                ) : (
                  <div className="space-y-2">
                    {topStrategies.slice(0, 5).map(([strat, s]) => (
                      <div key={strat}>
                        <div className="flex justify-between text-[11px] mb-0.5">
                          <span className="text-foreground truncate max-w-[140px]">{strat}</span>
                          <span className="text-muted-foreground">{s.total}</span>
                        </div>
                        <WrBar wins={s.wins} total={s.total} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === "regime" && (
            <div className="bg-card border border-border rounded p-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">Win Rate by Market Regime</div>
              {topRegimes.length === 0 ? (
                <p className="text-xs text-muted-foreground">No data yet.</p>
              ) : (
                <div className="space-y-3">
                  {topRegimes.map(([regime, s]) => (
                    <div key={regime}>
                      <div className="flex justify-between text-[11px] mb-1">
                        <span className="font-mono text-foreground capitalize">{regime}</span>
                        <span className="text-muted-foreground">{s.wins}W / {s.losses}L / {s.total} total</span>
                      </div>
                      <WrBar wins={s.wins} total={s.total} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === "strategy" && (
            <div className="bg-card border border-border rounded p-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">Win Rate by Strategy</div>
              {topStrategies.length === 0 ? (
                <p className="text-xs text-muted-foreground">No data yet.</p>
              ) : (
                <div className="space-y-3">
                  {topStrategies.map(([strat, s]) => (
                    <div key={strat}>
                      <div className="flex justify-between text-[11px] mb-1">
                        <span className="font-mono text-foreground">{strat}</span>
                        <span className="text-muted-foreground">{s.wins}W / {s.losses}L</span>
                      </div>
                      <WrBar wins={s.wins} total={s.total} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === "lessons" && (
            <div className="bg-card border border-border rounded p-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                Recent AI Lessons ({memory?.recentLessons.length ?? 0})
              </div>
              {(memory?.recentLessons ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground">No lessons yet. Reflect on closed trades to generate lessons.</p>
              ) : (
                <div className="space-y-2">
                  {(memory?.recentLessons ?? []).map((l, i) => (
                    <div key={i} className="flex gap-2 text-xs">
                      <span className="text-primary mt-0.5 flex-shrink-0">•</span>
                      <span className="text-foreground">{l}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right: action panel */}
        <div className="w-72 flex-shrink-0 border-l border-border p-4 space-y-4 overflow-auto">
          {/* Batch import */}
          <div className="bg-card border border-border rounded p-3">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2.5 flex items-center gap-1.5">
              <BookOpen size={11} /> Bootstrap Memory
            </div>
            <p className="text-[11px] text-muted-foreground mb-2.5">
              Store all closed trades for a symbol into memory (without AI — fast).
            </p>
            <input
              value={batchSymbol}
              onChange={e => setBatchSymbol(e.target.value.toUpperCase())}
              placeholder="TSLA"
              className="w-full h-7 text-xs bg-background border border-border rounded px-2 mb-2 text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <button
              onClick={handleBatch}
              disabled={batching}
              className="w-full h-7 text-xs rounded bg-primary text-primary-foreground font-medium hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-1.5"
            >
              {batching ? <><RefreshCw size={11} className="animate-spin" /> Importing…</> : "Import Trades"}
            </button>
            {batchResult && (
              <p className="mt-2 text-[11px] text-muted-foreground">{batchResult}</p>
            )}
          </div>

          {/* Single reflect */}
          <div className="bg-card border border-border rounded p-3">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2.5 flex items-center gap-1.5">
              <Brain size={11} /> AI Reflect on Trade
            </div>
            <p className="text-[11px] text-muted-foreground mb-2.5">
              {status?.available
                ? "Enter a signal ID to run AI reflection with Ollama."
                : "Ollama offline — reflection will store trade without lesson."}
            </p>
            <input
              value={reflectId}
              onChange={e => setReflectId(e.target.value)}
              placeholder="Signal ID (e.g. AB3X7YKQ2NMP)"
              className="w-full h-7 text-xs bg-background border border-border rounded px-2 mb-2 text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <button
              onClick={handleReflect}
              disabled={reflecting || !reflectId.trim()}
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
                  {reflectResult.ok ? (reflectResult.aiUsed ? "AI reflection complete" : "Stored (no AI)") : "Failed"}
                </div>
                {reflectResult.reflection && (
                  <>
                    <div className="text-[11px] text-foreground bg-background rounded p-2">
                      <div className="text-[10px] text-muted-foreground mb-1">Lesson</div>
                      {reflectResult.reflection.lesson}
                    </div>
                    {reflectResult.reflection.reasoning && (
                      <div className="text-[11px] text-muted-foreground bg-background rounded p-2">
                        <div className="text-[10px] text-muted-foreground mb-1">Reasoning</div>
                        {reflectResult.reflection.reasoning}
                      </div>
                    )}
                    {reflectResult.reflection.trapType && (
                      <div className="text-[11px] text-amber-400 flex items-center gap-1">
                        <AlertTriangle size={10} /> Trap: {reflectResult.reflection.trapType}
                      </div>
                    )}
                    <div className="text-[11px] text-muted-foreground">
                      Continuation prob: {(reflectResult.reflection.continuationProbability * 100).toFixed(0)}%
                    </div>
                  </>
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

          {/* Memory info */}
          {memory?.updatedAt && (
            <div className="text-[10px] text-muted-foreground">
              Last updated: {new Date(memory.updatedAt).toLocaleString()}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
