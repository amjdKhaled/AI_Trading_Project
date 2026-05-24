import { useState } from "react";
import { useListBars, getListBarsQueryKey } from "@workspace/api-client-react";
import { WatchlistPanel } from "@/components/WatchlistPanel";
import { TradingChart } from "@/components/TradingChart";
import { SignalPanel } from "@/components/SignalPanel";
import { useMarketSocket } from "@/hooks/useMarketSocket";

export default function ChartPage() {
  const [activeSymbol, setActiveSymbol] = useState<string | null>("NVDA");

  const { data: bars = [], isLoading: barsLoading } = useListBars(
    { symbol: activeSymbol ?? "NVDA", timeframe: "5m", limit: 200 },
    { query: { enabled: !!activeSymbol, queryKey: getListBarsQueryKey({ symbol: activeSymbol ?? "NVDA", timeframe: "5m", limit: 200 }) } }
  );

  const { connected, lastBar, newSignals, slUpdates, signalExits } = useMarketSocket(activeSymbol);

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
            <div className="text-xs text-muted-foreground font-mono animate-pulse">Loading bars...</div>
          </div>
        ) : activeSymbol ? (
          <TradingChart
            bars={bars}
            activeSignals={newSignals}
            lastBar={lastBar}
            symbol={activeSymbol}
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
