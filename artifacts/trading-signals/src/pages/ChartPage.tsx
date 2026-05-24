import { useState } from "react";
import { useListBars, getListBarsQueryKey } from "@workspace/api-client-react";
import { WatchlistPanel } from "@/components/WatchlistPanel";
import { TradingChart } from "@/components/TradingChart";
import { SignalPanel } from "@/components/SignalPanel";
import { useMarketSocket } from "@/hooks/useMarketSocket";
import { Moon } from "lucide-react";

export default function ChartPage() {
  const [activeSymbol, setActiveSymbol] = useState<string | null>("NVDA");

  const { data: bars = [], isLoading: barsLoading, isError } = useListBars(
    { symbol: activeSymbol ?? "NVDA", timeframe: "5m", limit: 200 },
    { query: { enabled: !!activeSymbol, queryKey: getListBarsQueryKey({ symbol: activeSymbol ?? "NVDA", timeframe: "5m", limit: 200 }) } }
  );

  const { connected, lastBar, newSignals } = useMarketSocket(activeSymbol);

  const marketClosed = !barsLoading && !isError && bars.length === 0;

  return (
    <div className="flex h-full" data-testid="chart-page">
      {/* Watchlist — left panel */}
      <div className="w-44 flex-shrink-0">
        <WatchlistPanel
          activeSymbol={activeSymbol}
          onSelectSymbol={setActiveSymbol}
          connected={connected}
        />
      </div>

      {/* Chart — center */}
      <div className="flex-1 flex flex-col min-w-0 bg-[#0b0e14]">
        {barsLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-xs text-muted-foreground font-mono animate-pulse">Fetching live data...</div>
          </div>
        ) : isError ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2">
            <p className="text-xs text-destructive font-mono">Failed to load bars</p>
            <p className="text-[10px] text-muted-foreground">Check API connection</p>
          </div>
        ) : marketClosed ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3">
            <Moon size={28} className="text-muted-foreground/40" />
            <p className="text-sm font-medium text-muted-foreground">{activeSymbol} — Market Closed</p>
            <p className="text-xs text-muted-foreground/60">Live candles will appear when the market opens (9:30 AM ET)</p>
            <p className="text-[10px] text-muted-foreground/40 font-mono">WebSocket active — waiting for trades</p>
          </div>
        ) : activeSymbol ? (
          <TradingChart
            bars={bars}
            activeSignals={newSignals}
            lastBar={lastBar}
            symbol={activeSymbol}
            connected={connected}
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
