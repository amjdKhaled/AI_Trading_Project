import { useState, useEffect, useCallback } from "react";
import { Newspaper, ExternalLink, RefreshCw } from "lucide-react";

interface NewsItem {
  title:        string;
  publishedUtc: string;
  articleUrl:   string;
  source:       string;
  tickers:      string[];
}

interface Props {
  symbol: string | null;
}

function timeAgo(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1)   return "just now";
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function NewsPanel({ symbol }: Props) {
  const [items,     setItems]     = useState<NewsItem[]>([]);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState<string | null>(null);
  const [refreshAt, setRefreshAt] = useState(0);

  const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

  const load = useCallback(() => {
    if (!symbol) return;
    setLoading(true);
    setError(null);
    void fetch(`${base}/api/news?symbol=${encodeURIComponent(symbol)}&limit=10`)
      .then((r) => r.ok ? (r.json() as Promise<NewsItem[]>) : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((data) => { setItems(data); setLoading(false); })
      .catch((e: Error) => { setError(e.message); setLoading(false); });
  }, [symbol, base]);

  useEffect(() => {
    setItems([]);
    load();
  }, [symbol, load]);

  useEffect(() => {
    if (!symbol) return;
    const id = setInterval(() => {
      setRefreshAt(Date.now());
    }, 3 * 60 * 1_000);
    return () => clearInterval(id);
  }, [symbol]);

  useEffect(() => {
    if (refreshAt > 0) load();
  }, [refreshAt, load]);

  return (
    <div className="flex flex-col h-full bg-card border-l border-border">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-1.5">
          <Newspaper size={11} className="text-muted-foreground" />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {symbol ? `${symbol} News` : "News"}
          </span>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
          title="Refresh"
        >
          <RefreshCw size={10} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {loading && items.length === 0 ? (
          <div className="space-y-2 p-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="rounded p-2 bg-muted animate-pulse">
                <div className="h-3 bg-muted-foreground/20 rounded mb-1.5 w-full" />
                <div className="h-3 bg-muted-foreground/20 rounded mb-1.5 w-4/5" />
                <div className="h-2 bg-muted-foreground/10 rounded w-1/3" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="px-3 py-6 text-center">
            <Newspaper size={18} className="text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-xs text-red-400 mb-1">Failed to load news</p>
            <p className="text-[10px] text-muted-foreground/60">{error}</p>
            <button
              onClick={load}
              className="mt-3 text-[10px] text-blue-400 hover:text-blue-300 underline transition-colors"
            >
              Try again
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="px-3 py-6 text-center">
            <Newspaper size={18} className="text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-xs text-muted-foreground">No recent news for {symbol}</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {items.map((item, i) => (
              <a
                key={i}
                href={item.articleUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="block px-3 py-2.5 hover:bg-muted/30 transition-colors group"
              >
                <p className="text-[11px] text-foreground leading-snug line-clamp-2 mb-1.5 group-hover:text-blue-300 transition-colors">
                  {item.title}
                </p>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-[9px] text-muted-foreground/70 font-medium truncate">
                      {item.source}
                    </span>
                    <span className="text-[9px] text-muted-foreground/40">·</span>
                    <span className="text-[9px] text-muted-foreground/60 flex-shrink-0">
                      {timeAgo(item.publishedUtc)}
                    </span>
                  </div>
                  <ExternalLink size={8} className="text-muted-foreground/30 group-hover:text-blue-400 flex-shrink-0 ml-1 transition-colors" />
                </div>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
