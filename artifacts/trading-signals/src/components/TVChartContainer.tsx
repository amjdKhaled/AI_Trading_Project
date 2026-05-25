/**
 * TradingView Charting Library container.
 *
 * Dynamically loads /charting_library/charting_library.standalone.js (the
 * licensed bundle the user must drop into public/charting_library/), then
 * instantiates a widget with our custom UDF + WebSocket datafeed.
 *
 * Preserves the existing signal-overlay system from TradingChart.tsx:
 *   - SL/TP horizontal lines for the active trade
 *   - Entry markers for new/historical signals
 *
 * If the library files aren't present yet, renders an in-place instructions
 * panel instead of breaking the app.
 */

import { useEffect, useRef, useState } from "react";
import type { PriceUpdate, SignalNew } from "@/hooks/useMarketSocket";
import type { TVWidget } from "@/types/tradingview";
import { createTvDatafeed } from "@/lib/tvDatafeed";

// Resolution mapping: our internal interval IDs → TV resolution strings.
const INTERVAL_TO_TV: Record<string, string> = {
  "5m": "5", "15m": "15", "1h": "60", "1d": "D", "1w": "W", "1M": "M",
};

export interface ActiveTrade {
  side:       "long" | "short";
  entryPrice: number;
  slPrice:    number;
  tpPrice:    number;
  entryTime:  number; // unix seconds
  symbol:     string;
}

export interface Props {
  symbol:            string;
  timeframe:         string;
  signals:           SignalNew[];
  activeTrade:       ActiveTrade | null;
  lastPrice:         PriceUpdate | null;
  isMarketOpen:      boolean;
  realtimeAvailable: boolean;
}

// Strip trailing slash for clean URL concatenation in the datafeed.
const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
const LIBRARY_SCRIPT = `${BASE}/charting_library/charting_library.standalone.js`;
const LIBRARY_PATH   = `${BASE}/charting_library/`;

// ── Library loader ───────────────────────────────────────────────────────────
// We load the script tag once and cache the promise so multiple chart mounts
// (or React-strict-mode double-renders) don't fight over the global.

let libraryPromise: Promise<boolean> | null = null;
function loadLibrary(): Promise<boolean> {
  if (window.TradingView?.widget) return Promise.resolve(true);
  if (libraryPromise)             return libraryPromise;

  libraryPromise = new Promise<boolean>((resolve) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[data-tv-charting-library]`,
    );
    if (existing) {
      existing.addEventListener("load",  () => resolve(!!window.TradingView?.widget));
      existing.addEventListener("error", () => resolve(false));
      return;
    }
    const s = document.createElement("script");
    s.src   = LIBRARY_SCRIPT;
    s.async = true;
    s.dataset.tvChartingLibrary = "true";
    s.onload  = () => resolve(!!window.TradingView?.widget);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
  return libraryPromise;
}

export function TVChartContainer({
  symbol, timeframe, signals, activeTrade, lastPrice, isMarketOpen, realtimeAvailable,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetRef    = useRef<TVWidget | null>(null);
  const shapeIdsRef  = useRef<{ signals: Set<string>; sltp: Set<string> }>({
    signals: new Set(), sltp: new Set(),
  });
  const [status, setStatus] = useState<"loading" | "ready" | "missing">("loading");

  // ── Mount / unmount the widget ─────────────────────────────────────────────
  useEffect(() => {
    if (!symbol || !containerRef.current) return;

    let disposed = false;

    loadLibrary().then((ok) => {
      if (disposed) return;
      if (!ok || !window.TradingView?.widget) {
        setStatus("missing");
        return;
      }

      const widget = new window.TradingView.widget({
        container:    containerRef.current!,
        library_path: LIBRARY_PATH,
        symbol,
        interval:     INTERVAL_TO_TV[timeframe] ?? "5",
        datafeed:     createTvDatafeed(BASE),
        locale:       "en",
        timezone:     "America/New_York",
        theme:        "Dark",
        autosize:     true,
        toolbar_bg:   "#0a0a0a",
        loading_screen: { backgroundColor: "#0a0a0a", foregroundColor: "#10b981" },
        // Hide chrome we don't want in an embedded trading-terminal view.
        disabled_features: [
          "use_localstorage_for_settings",
          "header_symbol_search",
          "header_compare",
          "header_saveload",
          "header_screenshot",
          "popup_hints",
          "study_templates",
        ],
        enabled_features: [
          "side_toolbar_in_fullscreen_mode",
          "hide_left_toolbar_by_default",
        ],
        overrides: {
          "paneProperties.background":          "#0a0a0a",
          "paneProperties.backgroundType":      "solid",
          "paneProperties.vertGridProperties.color": "rgba(255,255,255,0.04)",
          "paneProperties.horzGridProperties.color": "rgba(255,255,255,0.04)",
          "scalesProperties.textColor":         "rgba(255,255,255,0.6)",
          "mainSeriesProperties.candleStyle.upColor":           "#10b981",
          "mainSeriesProperties.candleStyle.downColor":         "#ef4444",
          "mainSeriesProperties.candleStyle.borderUpColor":     "#10b981",
          "mainSeriesProperties.candleStyle.borderDownColor":   "#ef4444",
          "mainSeriesProperties.candleStyle.wickUpColor":       "#10b981",
          "mainSeriesProperties.candleStyle.wickDownColor":     "#ef4444",
        },
      });

      widgetRef.current = widget;
      widget.onChartReady(() => {
        if (disposed) return;
        setStatus("ready");
      });
    });

    return () => {
      disposed = true;
      try { widgetRef.current?.remove(); } catch { /* widget already gone */ }
      widgetRef.current = null;
      shapeIdsRef.current = { signals: new Set(), sltp: new Set() };
      setStatus("loading");
    };
  }, [symbol, timeframe]);

  // ── Signal markers ────────────────────────────────────────────────────────
  // Re-draw on every signals change. Cheap because we only ever draw small
  // shapes and clear them on symbol/interval switch (via the mount effect).
  useEffect(() => {
    const widget = widgetRef.current;
    if (status !== "ready" || !widget) return;

    const chart = widget.activeChart();

    // Clear previous signal shapes.
    for (const id of shapeIdsRef.current.signals) {
      try { chart.removeEntity(id); } catch { /* shape already removed */ }
    }
    shapeIdsRef.current.signals = new Set();

    // Draw current signals as arrows at their entry bar.
    for (const sig of signals) {
      if (sig.symbol !== symbol) continue;
      const barTimeMs = new Date(sig.barTime).getTime();
      if (!Number.isFinite(barTimeMs)) continue;

      const id = chart.createShape(
        { time: Math.floor(barTimeMs / 1000), price: sig.entryPrice },
        {
          shape:    sig.side === "long" ? "arrow_up" : "arrow_down",
          text:     `${sig.side.toUpperCase()} ${sig.confidence}%`,
          lock:     true,
          disableSelection: true,
          overrides: {
            color:           sig.side === "long" ? "#10b981" : "#ef4444",
            textcolor:       sig.side === "long" ? "#10b981" : "#ef4444",
            fontsize:        11,
          },
        },
      );
      if (id) shapeIdsRef.current.signals.add(id);
    }
  }, [signals, symbol, status]);

  // ── SL / TP horizontal lines for the active trade ─────────────────────────
  useEffect(() => {
    const widget = widgetRef.current;
    if (status !== "ready" || !widget) return;

    const chart = widget.activeChart();

    for (const id of shapeIdsRef.current.sltp) {
      try { chart.removeEntity(id); } catch { /* shape already removed */ }
    }
    shapeIdsRef.current.sltp = new Set();

    if (!activeTrade || activeTrade.symbol !== symbol) return;

    const drawLine = (price: number, color: string, label: string) => {
      const id = chart.createShape(
        { time: activeTrade.entryTime, price },
        {
          shape: "horizontal_line",
          text:  label,
          lock:  true,
          disableSelection: true,
          overrides: {
            linecolor: color,
            linestyle: 2,         // dashed
            linewidth: 1,
            showLabel: true,
            textcolor: color,
            horzLabelsAlign: "right",
            vertLabelsAlign: "top",
          },
        },
      );
      if (id) shapeIdsRef.current.sltp.add(id);
    };

    drawLine(activeTrade.entryPrice, "#fbbf24", `Entry ${activeTrade.entryPrice}`);
    drawLine(activeTrade.slPrice,    "#ef4444", `SL ${activeTrade.slPrice}`);
    drawLine(activeTrade.tpPrice,    "#10b981", `TP ${activeTrade.tpPrice}`);
  }, [activeTrade, symbol, status]);

  // Suppress unused-var lint for props kept for API parity with the old chart.
  void lastPrice; void isMarketOpen;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">
      {/* Slim header — TV provides its own toolbar so we keep this compact. */}
      <div className="flex items-center gap-3 px-3 py-1.5 border-b border-white/5 flex-shrink-0">
        <span className="font-mono text-sm font-bold text-foreground">{symbol}</span>
        <span className="text-xs text-muted-foreground/70 font-mono uppercase">{timeframe}</span>
        <div className="flex-1" />
        {!realtimeAvailable ? (
          <>
            <span
              className="text-[10px] text-sky-400/80 font-mono tracking-widest"
              title="Real-time streaming is not available on the current data-provider plan. Historical bars are still accurate; live updates are disabled."
            >
              HIST ONLY
            </span>
            <div className="w-1.5 h-1.5 rounded-full bg-sky-500/60" />
          </>
        ) : isMarketOpen ? (
          <>
            <span className="text-[10px] text-emerald-400 font-mono tracking-widest">LIVE</span>
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
          </>
        ) : (
          <>
            <span className="text-[10px] text-amber-500/80 font-mono tracking-widest">CLOSED</span>
            <div className="w-1.5 h-1.5 rounded-full bg-amber-600/60" />
          </>
        )}
      </div>

      {/* TV widget mounts into containerRef. */}
      <div className="flex-1 min-h-0 relative">
        <div ref={containerRef} className="absolute inset-0" />
        {status === "missing" && <LibraryMissingNotice />}
      </div>
    </div>
  );
}

// ── Library-missing notice ───────────────────────────────────────────────────
// Shown when the licensed Charting Library bundle hasn't been dropped into
// public/charting_library/ yet. The library can't be downloaded from npm —
// it must be requested from TradingView directly.

function LibraryMissingNotice() {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-6 bg-background/95 backdrop-blur-sm">
      <div className="max-w-lg space-y-4 text-sm">
        <h3 className="text-base font-semibold text-amber-400">
          TradingView Charting Library not installed
        </h3>
        <p className="text-muted-foreground leading-relaxed">
          The chart is powered by TradingView's official Charting Library, which is licensed
          (free for use, but not redistributable). The library files aren't in this repo —
          you need to request access and add them yourself:
        </p>
        <ol className="list-decimal list-inside space-y-1.5 text-muted-foreground leading-relaxed">
          <li>
            Apply at{" "}
            <a
              href="https://www.tradingview.com/charting-library/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sky-400 underline"
            >
              tradingview.com/charting-library
            </a>{" "}
            (free, takes a day or two to get access).
          </li>
          <li>Clone the private GitHub repo they grant you.</li>
          <li>
            Copy the <code className="text-foreground">charting_library/</code> folder into{" "}
            <code className="text-foreground">artifacts/trading-signals/public/</code>.
          </li>
          <li>Refresh this page — the chart will load automatically.</li>
        </ol>
        <p className="text-xs text-muted-foreground/70 pt-2 border-t border-white/5">
          The UDF backend at <code>/api/udf/*</code> and the live WebSocket are already
          running. The datafeed will connect as soon as the library is present.
        </p>
      </div>
    </div>
  );
}
