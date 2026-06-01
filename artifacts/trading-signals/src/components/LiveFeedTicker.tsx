import { useState, useEffect, useRef } from "react";
import { subscribeWsDebug, getWsDebug } from "@/lib/wsDebugStore";

interface WsStats {
  tMsgReceived: number;
  forwarded:    number;
  lastPrice:    number | null;
  lastSymbol:   string | null;
}

function useWsStats(): WsStats {
  const [stats, setStats] = useState<WsStats>({
    tMsgReceived: 0, forwarded: 0, lastPrice: null, lastSymbol: null,
  });
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const r = await fetch("/api/ws-stats");
        if (!r.ok || cancelled) return;
        const d = await r.json() as Record<string, unknown>;
        setStats({
          tMsgReceived: (d.tMsgReceived as number)       ?? 0,
          forwarded:    (d.forwarded    as number)       ?? 0,
          lastPrice:    (d.lastPrice    as number | null) ?? null,
          lastSymbol:   (d.lastSymbol   as string | null) ?? null,
        });
      } catch { /* ignore */ }
    }
    poll();
    const id = setInterval(poll, 1000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);
  return stats;
}

function useTickAge(): number | null {
  const [age, setAge] = useState<number | null>(null);
  useEffect(() => {
    function compute() {
      const t = getWsDebug().lastMsgTime;
      setAge(t ? (Date.now() - t) / 1000 : null);
    }
    compute();
    const id = setInterval(compute, 200);
    const unsub = subscribeWsDebug(compute);
    return () => { clearInterval(id); unsub(); };
  }, []);
  return age;
}

interface Props {
  price:        number | null;
  isMarketOpen: boolean;
  symbol:       string;
}

export function LiveFeedTicker({ price, isMarketOpen, symbol }: Props) {
  const stats     = useWsStats();
  const tickAge   = useTickAge();
  const prevPrice = useRef<number | null>(null);
  const [dir, setDir] = useState<"up" | "down" | "flat">("flat");

  // Use backend lastPrice as fallback when WS hasn't sent a tick yet this session
  const displayPrice = price ?? stats.lastPrice;

  useEffect(() => {
    if (displayPrice === null) return;
    if (prevPrice.current !== null) {
      if (displayPrice > prevPrice.current)      setDir("up");
      else if (displayPrice < prevPrice.current) setDir("down");
      else                                       setDir("flat");
    }
    prevPrice.current = displayPrice;
  }, [displayPrice]);

  if (!isMarketOpen || displayPrice === null) return null;

  const priceColor =
    dir === "up"   ? "text-emerald-400" :
    dir === "down" ? "text-red-400"     : "text-white/90";

  const tickStr =
    tickAge === null ? "—" :
    tickAge < 1      ? `${(tickAge * 1000).toFixed(0)}ms` :
    tickAge < 60     ? `${tickAge.toFixed(1)}s`           :
                       `${Math.floor(tickAge / 60)}m`;

  const tickColor =
    tickAge === null ? "text-white/30" :
    tickAge < 2      ? "text-emerald-400" :
    tickAge < 5      ? "text-amber-400"   : "text-red-400";

  return (
    <div className="flex items-center gap-0 border border-white/10 rounded overflow-hidden bg-[#111520] shrink-0 select-none">

      {/* Pulse + LIVE label */}
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-r border-white/10">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
        <span className="text-[10px] font-mono text-emerald-400 font-bold tracking-wider">LIVE</span>
      </div>

      {/* Price */}
      <div className="flex flex-col items-center px-3 py-0.5 border-r border-white/10 min-w-[72px]">
        <span className="text-[8px] font-mono text-white/30 uppercase tracking-widest leading-none">Live Price</span>
        <span className={`text-[15px] font-mono font-bold leading-tight tabular-nums ${priceColor}`}>
          ${displayPrice.toFixed(2)}
        </span>
      </div>

      {/* Updates — backend T-received, persists across page reloads */}
      <div className="flex flex-col items-center px-3 py-0.5 border-r border-white/10 min-w-[68px]">
        <span className="text-[8px] font-mono text-white/30 uppercase tracking-widest leading-none">Updates</span>
        <span className="text-[15px] font-mono font-bold text-sky-400 leading-tight tabular-nums">
          {stats.tMsgReceived.toLocaleString()}
        </span>
      </div>

      {/* Last tick age — from frontend WS events */}
      <div className="flex flex-col items-center px-3 py-0.5 border-r border-white/10 min-w-[64px]">
        <span className="text-[8px] font-mono text-white/30 uppercase tracking-widest leading-none">Last Tick</span>
        <span className={`text-[15px] font-mono font-bold leading-tight tabular-nums ${tickColor}`}>
          {tickStr}
        </span>
      </div>

      {/* Chart updates */}
      <div className="flex flex-col items-center px-3 py-0.5 min-w-[56px]">
        <span className="text-[8px] font-mono text-white/30 uppercase tracking-widest leading-none">Chart ↑</span>
        <span className="text-[15px] font-mono font-bold text-violet-400 leading-tight tabular-nums">
          {getWsDebug().chartUpdates}
        </span>
      </div>
    </div>
  );
}
