import { useState } from "react";
import { useListBars, getListBarsQueryKey } from "@workspace/api-client-react";
import { WatchlistPanel } from "@/components/WatchlistPanel";
import { TradingChart } from "@/components/TradingChart";
import { SignalPanel } from "@/components/SignalPanel";
import { useMarketSocket } from "@/hooks/useMarketSocket";

const TIMEFRAMES = ["5m", "15m", "30m", "1h", "4h", "1d", "1w", "1M"] as const;
type Timeframe = (typeof TIMEFRAMES)[number];

const TF_SECONDS: Record<Timeframe, number> = {
  "5m":  300,
  "15m": 900,
  "30m": 1800,
  "1h":  3600,
  "4h":  14400,
  "1d":  86400,
  "1w":  604800,
  "1M":  2592000,
};

export default function ChartPage() {
  const [activeSymbol, setActiveSymbol] = useState<string | null>("NVDA");
  const [timeframe, setTimeframe] = useState<Timeframe>("5m");

  const sym = activeSymbol ?? "NVDA";

  const { data: bars = [], isLoading: barsLoading } = useListBars(
    { symbol: sym, timeframe },
    {
      query: {
        enabled: !!activeSymbol,
        queryKey: getListBarsQueryKey({ symbol: sym, timeframe }),
      },
    }
  );

  const { connected, lastBar, newSignals } = useMarketSocket(activeSymbol);

  return (
    <div className="flex h-full" data-testid="chart-page">
      {/* Watchlist — left panel */}
      <div className="w-44 flex-shrink-0">
        <WatchlistPanel
          activeSymbol={activeSymbol}
          onSelectSymbol={(s) => { setActiveSymbol(s); }}
          connected={connected}
        />
      </div>

      {/* Chart — center */}
      <div className="flex-1 flex flex-col min-w-0 bg-[#0b0e14]">
        {/* Timeframe toolbar */}
        <div className="flex items-center gap-0.5 px-3 py-1.5 border-b border-white/5 flex-shrink-0">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              onClick={() => setTimeframe(tf)}
              className={`px-2 py-0.5 rounded text-[11px] font-mono font-medium transition-colors ${
                tf === timeframe
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-white/5"
              }`}
            >
              {tf}
            </button>
          ))}
        </div>

        {barsLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-xs text-muted-foreground font-mono animate-pulse">Loading bars…</div>
          </div>
        ) : activeSymbol ? (
          <TradingChart
            bars={bars}
            activeSignals={newSignals}
            lastBar={lastBar}
            symbol={activeSymbol}
            timeframe={timeframe}
            intervalSec={TF_SECONDS[timeframe]}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm text-muted-foreground">Select a symbol from the watchlist</p>
          </div>
        )}
      </div>

      {/* Signal panel — right */}
      <div className="w-52 flex-shrink-0">
        <SignalPanel symbol={activeSymbol} newSignals={newSignals} />
      </div>
    </div>
  );
}
