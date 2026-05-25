import { useState } from "react";
import { useListSymbols, useAddSymbol, useRemoveSymbol, getListSymbolsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, X, TrendingUp, TrendingDown, Wifi, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Props {
  activeSymbol: string | null;
  onSelectSymbol: (symbol: string) => void;
  connected: boolean;
}

const POPULAR = [
  { symbol: "NVDA", name: "NVIDIA Corp" },
  { symbol: "AAPL", name: "Apple Inc." },
  { symbol: "AMD", name: "Advanced Micro Devices" },
  { symbol: "MSFT", name: "Microsoft Corp" },
  { symbol: "TSLA", name: "Tesla Inc." },
  { symbol: "QQQ", name: "Invesco QQQ Trust" },
];

export function WatchlistPanel({ activeSymbol, onSelectSymbol, connected }: Props) {
  const queryClient = useQueryClient();
  const { data: symbols = [] } = useListSymbols();
  const addSymbol = useAddSymbol();
  const removeSymbol = useRemoveSymbol();
  const [adding, setAdding] = useState(false);
  const [symInput, setSymInput] = useState("");
  const [nameInput, setNameInput] = useState("");

  const handleAdd = () => {
    if (!symInput.trim()) return;
    const name = nameInput.trim() || symInput.trim().toUpperCase();
    addSymbol.mutate(
      { data: { symbol: symInput.trim().toUpperCase(), name } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListSymbolsQueryKey() });
          setAdding(false);
          setSymInput("");
          setNameInput("");
        },
      }
    );
  };

  const handleRemove = (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    removeSymbol.mutate({ id }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListSymbolsQueryKey() }),
    });
  };

  const handleQuickAdd = (sym: string, name: string) => {
    if (symbols.find((s) => s.symbol === sym)) {
      onSelectSymbol(sym);
      return;
    }
    addSymbol.mutate({ data: { symbol: sym, name } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListSymbolsQueryKey() });
        onSelectSymbol(sym);
      },
    });
  };

  return (
    <div className="flex flex-col h-full bg-sidebar border-r border-sidebar-border">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-sidebar-border">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Watchlist</span>
          {connected ? (
            <Wifi size={10} className="text-green-500" />
          ) : (
            <WifiOff size={10} className="text-muted-foreground" />
          )}
        </div>
        <button
          data-testid="button-add-symbol"
          onClick={() => setAdding((v) => !v)}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <Plus size={14} />
        </button>
      </div>

      {/* Add form */}
      {adding && (
        <div className="px-2 py-2 border-b border-sidebar-border space-y-1">
          <Input
            data-testid="input-symbol"
            placeholder="Ticker (e.g. AAPL)"
            value={symInput}
            onChange={(e) => setSymInput(e.target.value.toUpperCase())}
            className="h-7 text-xs font-mono"
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          />
          <Input
            data-testid="input-name"
            placeholder="Name (optional)"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            className="h-7 text-xs"
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          />
          <div className="flex gap-1">
            <Button
              data-testid="button-confirm-add"
              size="sm"
              className="h-6 text-xs flex-1"
              onClick={handleAdd}
              disabled={addSymbol.isPending}
            >
              Add
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-xs"
              onClick={() => setAdding(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Symbol list */}
      <div className="flex-1 overflow-y-auto">
        {symbols.length === 0 && !adding ? (
          <div className="px-3 py-4">
            <p className="text-xs text-muted-foreground mb-3">Quick add:</p>
            <div className="space-y-0.5">
              {POPULAR.map((p) => (
                <button
                  key={p.symbol}
                  data-testid={`button-quick-add-${p.symbol}`}
                  onClick={() => handleQuickAdd(p.symbol, p.name)}
                  className="w-full flex items-center justify-between px-2 py-1.5 rounded hover:bg-sidebar-accent transition-colors group"
                >
                  <span className="font-mono text-xs text-muted-foreground group-hover:text-foreground">{p.symbol}</span>
                  <Plus size={10} className="text-muted-foreground opacity-0 group-hover:opacity-100" />
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="py-1">
            {symbols.map((s) => (
              <div
                key={s.id}
                data-testid={`button-symbol-${s.id}`}
                onClick={() => onSelectSymbol(s.symbol)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && onSelectSymbol(s.symbol)}
                className={`w-full flex items-center justify-between px-3 py-2 transition-colors group cursor-pointer ${
                  activeSymbol === s.symbol
                    ? "bg-sidebar-accent text-foreground"
                    : "hover:bg-sidebar-accent text-sidebar-foreground hover:text-foreground"
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <div className={`w-1 h-1 rounded-full flex-shrink-0 ${activeSymbol === s.symbol ? "bg-primary" : "bg-transparent"}`} />
                  <span className="font-mono text-xs font-medium truncate">{s.symbol}</span>
                </div>
                <button
                  data-testid={`button-remove-${s.id}`}
                  onClick={(e) => handleRemove(s.id, e)}
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all ml-1"
                >
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
