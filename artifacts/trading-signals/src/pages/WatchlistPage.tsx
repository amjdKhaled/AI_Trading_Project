import { useState } from "react";
import { useListSymbols, useAddSymbol, useRemoveSymbol, useGetSignalStats, getListSymbolsQueryKey, getGetSignalStatsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, BarChart2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";

function SymbolStats({ symbol }: { symbol: string }) {
  const { data: stats } = useGetSignalStats(
    { symbol },
    { query: { queryKey: getGetSignalStatsQueryKey({ symbol }) } }
  );
  if (!stats) return <span className="text-muted-foreground font-mono text-xs">—</span>;
  return (
    <div className="flex gap-3 font-mono text-xs">
      <span className="text-muted-foreground">{stats.total} signals</span>
      {stats.total > 0 && (
        <>
          <span className="text-green-400">{(stats.winRate * 100).toFixed(0)}% WR</span>
          <span className="text-blue-400">{stats.active} active</span>
        </>
      )}
    </div>
  );
}

export default function WatchlistPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: symbols = [], isLoading } = useListSymbols();
  const addSymbol = useAddSymbol();
  const removeSymbol = useRemoveSymbol();
  const [sym, setSym] = useState("");
  const [name, setName] = useState("");

  const handleAdd = () => {
    if (!sym.trim()) return;
    addSymbol.mutate(
      { data: { symbol: sym.trim().toUpperCase(), name: name.trim() || sym.trim().toUpperCase() } },
      {
        onSuccess: (s) => {
          queryClient.invalidateQueries({ queryKey: getListSymbolsQueryKey() });
          setSym("");
          setName("");
          toast({ title: `${s.symbol} added to watchlist` });
        },
        onError: () => {
          toast({ title: "Failed to add symbol", variant: "destructive" });
        },
      }
    );
  };

  const handleRemove = (id: number, symbol: string) => {
    removeSymbol.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListSymbolsQueryKey() });
        toast({ title: `${symbol} removed` });
      },
    });
  };

  return (
    <div className="h-full overflow-auto" data-testid="watchlist-page">
      <div className="max-w-2xl mx-auto px-6 py-6">
        <div className="mb-6">
          <h1 className="text-base font-semibold text-foreground">Watchlist</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Manage symbols for signal generation and live charts</p>
        </div>

        {/* Add form */}
        <div className="bg-card border border-card-border rounded-lg p-4 mb-6">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Add Symbol</h2>
          <div className="flex gap-2">
            <Input
              data-testid="input-symbol"
              placeholder="Ticker (e.g. AAPL)"
              value={sym}
              onChange={(e) => setSym(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
              className="font-mono text-sm"
            />
            <Input
              data-testid="input-name"
              placeholder="Company name (optional)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
              className="text-sm"
            />
            <Button
              data-testid="button-add-symbol"
              onClick={handleAdd}
              disabled={addSymbol.isPending || !sym.trim()}
              className="flex-shrink-0"
            >
              <Plus size={14} className="mr-1" />
              Add
            </Button>
          </div>
        </div>

        {/* Symbol list */}
        <div className="bg-card border border-card-border rounded-lg overflow-hidden">
          <div className="px-4 py-2.5 border-b border-border">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {symbols.length} {symbols.length === 1 ? "symbol" : "symbols"}
            </span>
          </div>
          {isLoading ? (
            <div className="p-4 space-y-2">
              {[1, 2, 3].map((i) => <div key={i} className="h-12 bg-muted rounded animate-pulse" />)}
            </div>
          ) : symbols.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10">
              <BarChart2 size={28} className="text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground">No symbols yet</p>
              <p className="text-xs text-muted-foreground mt-1">Add NVDA, AAPL, QQQ to get started</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {symbols.map((s) => (
                <div
                  key={s.id}
                  data-testid={`symbol-row-${s.id}`}
                  className="flex items-center justify-between px-4 py-3 hover:bg-muted/20 transition-colors"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-semibold text-sm text-foreground">{s.symbol}</span>
                      <span className="text-xs text-muted-foreground">{s.name}</span>
                    </div>
                    <div className="mt-0.5">
                      <SymbolStats symbol={s.symbol} />
                    </div>
                  </div>
                  <Button
                    data-testid={`button-remove-${s.id}`}
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => handleRemove(s.id, s.symbol)}
                  >
                    <Trash2 size={13} />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
