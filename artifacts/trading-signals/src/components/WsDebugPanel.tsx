import { useState, useEffect, useRef } from "react";
import { subscribeWsDebug, getWsDebug, type WsDebugFrontend } from "@/lib/wsDebugStore";

interface BackendStats {
  connected:         boolean;
  authenticated:     boolean;
  url:               string | null;
  subscribedSymbols: string[];
  tMsgReceived:      number;
  amMsgReceived:     number;
  aMsgReceived:      number;
  statusMsgReceived: number;
  forwarded:         number;
  clientCount:       number;
  lastSymbol:        string | null;
  lastPrice:         number | null;
  lastMsgTime:       number | null;
  recentMsgs:        Array<{ ev: string; sym?: string; p?: number; ts: number }>;
}

interface Props {
  isMarketOpen:      boolean;
  realtimeAvailable: boolean;
  msgCount:          number;
}

function fmtAgo(ms: number | null): string {
  if (ms === null) return "—";
  const diff = Math.round((Date.now() - ms) / 1000);
  if (diff < 0) return "—";
  if (diff < 60) return `${diff}s ago`;
  return `${Math.round(diff / 60)}m ago`;
}

function Dot({ ok }: { ok: boolean }) {
  return (
    <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 ${ok ? "bg-emerald-400" : "bg-red-400"}`} />
  );
}

function Row({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="flex justify-between gap-3 leading-4">
      <span className="text-white/40 shrink-0">{label}</span>
      <span className={`font-mono text-right ${ok === true ? "text-emerald-400" : ok === false ? "text-red-400" : "text-white/80"}`}>
        {value}
      </span>
    </div>
  );
}

export function WsDebugPanel({ isMarketOpen, realtimeAvailable, msgCount }: Props) {
  const [visible,  setVisible]  = useState(true);
  const [backend,  setBackend]  = useState<BackendStats | null>(null);
  const [frontend, setFrontend] = useState<WsDebugFrontend>(getWsDebug());
  const [now,      setNow]      = useState(Date.now());
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Toggle with D key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "d" && !e.metaKey && !e.ctrlKey && !e.altKey &&
          !(document.activeElement instanceof HTMLInputElement) &&
          !(document.activeElement instanceof HTMLTextAreaElement)) {
        setVisible((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Poll /api/ws-stats every 2 s
  useEffect(() => {
    const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

    async function poll() {
      try {
        const res = await fetch(`${base}/api/ws-stats`, { cache: "no-store" });
        if (res.ok) setBackend(await res.json());
      } catch { /* offline */ }
      setNow(Date.now());
    }

    poll();
    pollTimer.current = setInterval(poll, 2000);
    return () => { if (pollTimer.current) clearInterval(pollTimer.current); };
  }, []);

  // Subscribe to frontend debug store
  useEffect(() => {
    setFrontend(getWsDebug());
    const unsub = subscribeWsDebug(() => setFrontend(getWsDebug()));
    return unsub;
  }, []);

  // Refresh "N s ago" every second
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [now]);

  if (!visible) {
    return (
      <button
        onClick={() => setVisible(true)}
        className="absolute bottom-2 right-2 z-50 text-[9px] font-mono text-white/20 hover:text-white/50 px-1.5 py-0.5 rounded border border-white/10 hover:border-white/20 bg-[#0b0e14]/80"
      >
        WS DEBUG [D]
      </button>
    );
  }

  // Derive badge state (matches TradingChart badge logic exactly)
  const badge = !realtimeAvailable ? "HIST ONLY" : isMarketOpen ? "LIVE" : "CLOSED";
  const badgeOk = badge === "LIVE";
  const badgeWarn = badge === "HIST ONLY";

  // Chart reject breakdown (sorted by count descending)
  const rejectEntries = Object.entries(frontend.chartRejects).sort((a, b) => b[1] - a[1]);

  return (
    <div className="absolute bottom-2 right-2 z-50 w-64 rounded border border-white/10 bg-[#0b0e14]/95 text-[10px] font-mono text-white/70 shadow-xl">

      {/* Header */}
      <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-white/10">
        <span className="text-white/50 font-semibold tracking-wider uppercase text-[9px]">WS Pipeline Debug</span>
        <button onClick={() => setVisible(false)} className="text-white/30 hover:text-white/70 text-[11px] leading-none">×</button>
      </div>

      <div className="px-2.5 py-2 space-y-0.5">

        {/* ── BADGE ── */}
        <div className="flex justify-between leading-4 mb-1">
          <span className="text-white/40">Badge</span>
          <span className={`font-mono font-bold ${badgeOk ? "text-emerald-400" : badgeWarn ? "text-amber-400" : "text-sky-400"}`}>
            {badge}
          </span>
        </div>
        <div className="flex justify-between leading-4">
          <span className="text-white/30 text-[9px]">realtimeAvailable</span>
          <span className={`font-mono ${realtimeAvailable ? "text-emerald-400" : "text-red-400"}`}>{String(realtimeAvailable)}</span>
        </div>
        <div className="flex justify-between leading-4 mb-1.5">
          <span className="text-white/30 text-[9px]">isMarketOpen</span>
          <span className={`font-mono ${isMarketOpen ? "text-emerald-400" : "text-yellow-500"}`}>{String(isMarketOpen)}</span>
        </div>

        <div className="border-t border-white/5 my-1" />

        {/* ── POLYGON (backend) ── */}
        <div className="text-[9px] text-white/30 uppercase tracking-wider mb-0.5">① Polygon</div>
        <div className="flex justify-between leading-4">
          <span className="text-white/40">Connected</span>
          <span className="flex items-center">
            <Dot ok={backend?.connected ?? false} />
            <span className={backend?.connected ? "text-emerald-400" : "text-red-400"}>
              {backend?.connected ? "YES" : "NO"}
            </span>
          </span>
        </div>
        <Row label="Auth" value={backend?.authenticated ? "YES" : "NO"} ok={backend?.authenticated} />
        <Row label="Feed" value={backend?.url?.replace("wss://", "").replace("/stocks", "") ?? "—"} />
        <Row label="Subscribed" value={backend?.subscribedSymbols.join(", ") || "none"} />

        <div className="border-t border-white/5 my-1" />

        {/* ── BACKEND relay ── */}
        <div className="text-[9px] text-white/30 uppercase tracking-wider mb-0.5">② Backend relay</div>
        <div className="flex justify-between leading-4">
          <span className="text-white/40">T received</span>
          <span className={`font-mono ${(backend?.tMsgReceived ?? 0) > 0 ? "text-emerald-400" : "text-red-400"}`}>
            {backend?.tMsgReceived ?? "—"}
          </span>
        </div>
        <Row label="AM received"  value={String(backend?.amMsgReceived ?? "—")} />
        <Row label="A received"   value={String(backend?.aMsgReceived  ?? "—")} />
        <Row label="Forwarded"    value={String(backend?.forwarded    ?? "—")} />
        <Row label="Clients"      value={String(backend?.clientCount  ?? "—")} />
        <Row label="Last sym"     value={backend?.lastSymbol ?? "—"} />
        <Row label="Last price"   value={backend?.lastPrice != null ? `$${backend.lastPrice.toFixed(2)}` : "—"} />
        <Row label="Last msg"     value={fmtAgo(backend?.lastMsgTime ?? null)} />

        <div className="border-t border-white/5 my-1" />

        {/* ── FRONTEND ── */}
        <div className="text-[9px] text-white/30 uppercase tracking-wider mb-0.5">③ Frontend WS</div>
        <div className="flex justify-between leading-4">
          <span className="text-white/40">Msgs received</span>
          <span className={`font-mono ${msgCount > 0 ? "text-emerald-400" : "text-red-400"}`}>
            {msgCount}
          </span>
        </div>
        <Row label="Last sym"   value={frontend.lastSymbol  ?? "—"} />
        <Row label="Last price" value={frontend.lastPrice != null ? `$${frontend.lastPrice.toFixed(2)}` : "—"} />
        <Row label="Last msg"   value={fmtAgo(frontend.lastMsgTime)} />

        <div className="border-t border-white/5 my-1" />

        {/* ── CHART ── */}
        <div className="text-[9px] text-white/30 uppercase tracking-wider mb-0.5">④ Chart updates</div>
        <div className="flex justify-between leading-4">
          <span className="text-white/40">Updates</span>
          <span className={`font-mono ${frontend.chartUpdates > 0 ? "text-emerald-400" : "text-red-400"}`}>
            {frontend.chartUpdates}
          </span>
        </div>

        {rejectEntries.length > 0 && (
          <div className="mt-0.5 space-y-0.5">
            <div className="text-[9px] text-red-400/60">Rejects:</div>
            {rejectEntries.map(([reason, count]) => (
              <div key={reason} className="flex justify-between leading-4 pl-1">
                <span className="text-red-400/70">{reason}</span>
                <span className="text-red-400 font-mono">{count}</span>
              </div>
            ))}
          </div>
        )}

        {/* Recent messages from Polygon */}
        {backend?.recentMsgs && backend.recentMsgs.length > 0 && (
          <>
            <div className="border-t border-white/5 my-1" />
            <div className="text-[9px] text-white/30 uppercase tracking-wider mb-0.5">Recent Polygon msgs</div>
            <div className="max-h-24 overflow-y-auto space-y-0.5">
              {[...backend.recentMsgs].reverse().slice(0, 8).map((m, i) => (
                <div key={i} className="flex gap-1.5 leading-3.5 text-[9px]">
                  <span className={`shrink-0 ${m.ev === "T" ? "text-emerald-400" : m.ev === "AM" ? "text-sky-400" : "text-white/30"}`}>
                    {m.ev}
                  </span>
                  {m.sym && <span className="text-white/50">{m.sym}</span>}
                  {m.p != null && <span className="text-white/50">${m.p.toFixed(2)}</span>}
                  <span className="text-white/20 ml-auto">{fmtAgo(m.ts)}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="px-2.5 pb-1.5 text-[8px] text-white/20 text-right">press D to toggle</div>
    </div>
  );
}
