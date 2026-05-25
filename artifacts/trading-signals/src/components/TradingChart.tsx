import { useEffect, useRef, useCallback } from "react";
import {
  createChart,
  CrosshairMode,
  CandlestickSeries,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type CandlestickData,
  type Time,
  type SeriesMarker,
} from "lightweight-charts";
import type { BarUpdate, SignalNew } from "@/hooks/useMarketSocket";

interface Props {
  bars: { time: number; open: number; high: number; low: number; close: number; volume: number }[];
  activeSignals: SignalNew[];
  lastBar: BarUpdate | null;
  symbol: string;
  timeframe: string;
  intervalSec: number;
}

export function TradingChart({ bars, activeSignals, lastBar, symbol, timeframe, intervalSec }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const markersPluginRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  const buildMarkers = useCallback((signals: SignalNew[]): SeriesMarker<Time>[] => {
    return signals
      .filter((s) => s.barTime)
      .map((s) => ({
        time: (new Date(s.barTime).getTime() / 1000) as Time,
        position: s.side === "long" ? ("belowBar" as const) : ("aboveBar" as const),
        color: s.side === "long" ? "#22c55e" : "#ef4444",
        shape: s.side === "long" ? ("arrowUp" as const) : ("arrowDown" as const),
        text: `${s.confidence}%`,
      }));
  }, []);

  // Create chart once
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: "#0b0e14" },
        textColor: "#9ca3af",
        fontFamily: "'JetBrains Mono', 'Menlo', monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "#151b26" },
        horzLines: { color: "#151b26" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: {
        borderColor: "#1f2937",
        textColor: "#9ca3af",
      },
      timeScale: {
        borderColor: "#1f2937",
        timeVisible: true,
        secondsVisible: false,
      },
      width: containerRef.current.offsetWidth,
      height: containerRef.current.offsetHeight || 500,
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderUpColor: "#22c55e",
      borderDownColor: "#ef4444",
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
    });

    const markersPlugin = createSeriesMarkers(candleSeries, []);

    chartRef.current = chart;
    seriesRef.current = candleSeries;
    markersPluginRef.current = markersPlugin;

    const resizeObs = new ResizeObserver(() => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({
          width: containerRef.current.offsetWidth,
          height: containerRef.current.offsetHeight || 500,
        });
      }
    });
    resizeObs.observe(containerRef.current);

    return () => {
      resizeObs.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      markersPluginRef.current = null;
    };
  }, []);

  // Load bars whenever symbol or timeframe changes
  useEffect(() => {
    if (!seriesRef.current || !bars.length) return;
    const data: CandlestickData<Time>[] = bars.map((b) => ({
      time: b.time as Time,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
    }));
    seriesRef.current.setData(data);
    chartRef.current?.timeScale().fitContent();
  }, [bars]);

  // Update signal markers
  useEffect(() => {
    if (!markersPluginRef.current) return;
    markersPluginRef.current.setMarkers(buildMarkers(activeSignals));
  }, [activeSignals, buildMarkers]);

  // Live bar tick from WebSocket — only meaningful on 5m, but align to any interval
  useEffect(() => {
    if (!seriesRef.current || !lastBar || !bars.length) return;
    try {
      const alignedTime = (lastBar.time - (lastBar.time % intervalSec)) as Time;
      seriesRef.current.update({
        time: alignedTime,
        open: lastBar.open,
        high: lastBar.high,
        low: lastBar.low,
        close: lastBar.close,
      });
    } catch {
      // swallow time-ordering errors from stale updates
    }
  }, [lastBar, bars.length, intervalSec]);

  return (
    <div className="flex flex-col h-full">
      {/* Symbol / timeframe header row */}
      <div className="flex items-center gap-3 px-3 py-2 border-b border-white/5 flex-shrink-0">
        <span className="font-mono text-sm font-semibold text-foreground">{symbol}</span>
        <span className="text-xs text-muted-foreground font-mono">{timeframe.toUpperCase()}</span>
        <span className="text-xs text-muted-foreground">NASDAQ</span>
        <div className="flex-1" />
        <span className="text-[10px] text-green-400 font-mono tracking-wider">LIVE</span>
        <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
      </div>
      <div ref={containerRef} className="flex-1 min-h-0" />
    </div>
  );
}
