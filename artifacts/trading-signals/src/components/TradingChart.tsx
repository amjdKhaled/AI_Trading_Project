import { useEffect, useRef, useCallback, useState } from "react";
import {
  createChart,
  CrosshairMode,
  CandlestickSeries,
  HistogramSeries,
  createSeriesMarkers,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type CandlestickData,
  type HistogramData,
  type Time,
  type SeriesMarker,
  type LineData,
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
  // VERSION: 2026-05-25-REV2 — force vite recompile
  console.log("[TradingChart] RENDER v2", { symbol, sigCount: activeSignals.length });
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const markersPluginRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  // SL lines: signalId -> series ref
  const slLinesRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  // Track which signals we've rendered to avoid duplicates
  const renderedSignalsRef = useRef<Set<string>>(new Set());

  const [barCount, setBarCount] = useState(0);
  const [dateRange, setDateRange] = useState("");

  // Build markers — entries only
  const buildMarkers = useCallback((signals: SignalNew[]): SeriesMarker<Time>[] => {
    return signals
      .filter((s) => s.barTime && (s.grade == null || s.grade === "A+" || s.grade === "A"))
      .map((s) => ({
        time: (new Date(s.barTime).getTime() / 1000) as Time,
        position: s.side === "long" ? ("belowBar" as const) : ("aboveBar" as const),
        color: s.side === "long" ? "#22c55e" : "#ef4444",
        shape: s.side === "long" ? ("arrowUp" as const) : ("arrowDown" as const),
        text: `${s.confidence}%`,
        size: 3,
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

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: "volume",
      color: "#22c55e",
      priceFormat: { type: "volume" },
      priceLineVisible: false,
      lastValueVisible: false,
    });

    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.74, bottom: 0 },
    });
    candleSeries.priceScale().applyOptions({
      scaleMargins: { top: 0, bottom: 0.28 },
    });

    const markersPlugin = createSeriesMarkers(candleSeries, [
      {
        time: (Date.now() / 1000 - 86400 * 30) as Time,
        position: "belowBar",
        color: "#ffff00",
        shape: "circle",
        text: "TEST",
        size: 6,
      },
    ]);
    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
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
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      markersPluginRef.current = null;
      slLinesRef.current.forEach((s) => { try { chartRef.current?.removeSeries(s); } catch {} });
      slLinesRef.current.clear();
      renderedSignalsRef.current.clear();
    };
  }, []);

  // Load bars whenever symbol/timeframe changes
  useEffect(() => {
    if (!candleSeriesRef.current || !bars.length) return;

    const candleData: CandlestickData<Time>[] = bars.map((b) => ({
      time: b.time as Time,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
    }));
    candleSeriesRef.current.setData(candleData);

    if (volumeSeriesRef.current) {
      const volumeData: HistogramData[] = bars.map((b) => ({
        time: b.time as Time,
        value: b.volume,
        color: b.close >= b.open ? "#22c55e40" : "#ef444440",
      }));
      volumeSeriesRef.current.setData(volumeData);
    }

    chartRef.current?.timeScale().fitContent();
    setBarCount(bars.length);
    const first = new Date(bars[0].time * 1000).toISOString().slice(0, 10);
    const last = new Date(bars[bars.length - 1].time * 1000).toISOString().slice(0, 10);
    setDateRange(`${first} – ${last}`);

    // Clear old SL lines on bar reload
    slLinesRef.current.forEach((s) => { try { chartRef.current?.removeSeries(s); } catch {} });
    slLinesRef.current.clear();
    renderedSignalsRef.current.clear();
  }, [bars]);

  // Render entry markers and SL lines for new signals
  useEffect(() => {
    console.log("[TradingChart] SIGNAL EFFECT", { hasPlugin: !!markersPluginRef.current, hasChart: !!chartRef.current, sigCount: activeSignals.length });
    if (!markersPluginRef.current || !chartRef.current) return;

    const markers = buildMarkers(activeSignals).sort((a, b) => (a.time as number) - (b.time as number));
    try {
      markersPluginRef.current.setMarkers(markers);
    } catch (e) {
      console.error("[TradingChart] setMarkers error", e);
    }

    // Add SL lines for new signals only
    for (const sig of activeSignals) {
      if (!sig.signalId || renderedSignalsRef.current.has(sig.signalId)) continue;
      if (!sig.slPrice || !sig.barTime) continue;
      renderedSignalsRef.current.add(sig.signalId);

      const color = sig.side === "long" ? "#ef444480" : "#22c55e80";
      const slSeries = chartRef.current.addSeries(LineSeries, {
        priceScaleId: candleSeriesRef.current?.options().priceScaleId,
        color,
        lineStyle: 2, // dashed
        lineWidth: 1,
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
      });

      const slData: LineData[] = bars
        .filter((b) => b.time >= new Date(sig.barTime).getTime() / 1000)
        .map((b) => ({ time: b.time as Time, value: sig.slPrice }));

      if (slData.length > 0) slSeries.setData(slData);
      slLinesRef.current.set(sig.signalId, slSeries);
    }
  }, [activeSignals, buildMarkers, bars]);

  // Live bar tick from WebSocket (only on intraday timeframes)
  useEffect(() => {
    if (!candleSeriesRef.current || !lastBar || !bars.length) return;
    try {
      const alignedTime = (lastBar.time - (lastBar.time % intervalSec)) as Time;
      candleSeriesRef.current.update({
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
      {/* Header */}
      <div className="flex items-center gap-3 px-3 py-2 border-b border-white/5 flex-shrink-0">
        <span className="font-mono text-sm font-semibold text-foreground">{symbol}</span>
        <span className="text-xs text-muted-foreground font-mono">{timeframe.toUpperCase()}</span>
        <span className="text-xs text-muted-foreground">NASDAQ</span>
        <div className="flex-1" />
        {barCount > 0 && (
          <span className="text-[10px] text-muted-foreground font-mono hidden sm:inline">
            {barCount.toLocaleString()} bars | {dateRange}
          </span>
        )}
        <span className="text-[10px] text-green-400 font-mono tracking-wider">LIVE</span>
        <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
      </div>
      <div ref={containerRef} className="flex-1 min-h-0" />
    </div>
  );
}
