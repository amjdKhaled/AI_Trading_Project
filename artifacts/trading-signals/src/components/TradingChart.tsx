import { useEffect, useRef, useCallback, useState } from "react";
import {
  createChart,
  CrosshairMode,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type HistogramData,
  type Time,
  type LineData,
} from "lightweight-charts";
import type { BarUpdate, SignalNew } from "@/hooks/useMarketSocket";

interface MarkerPos {
  x: number;
  y: number;
  isLong: boolean;
  color: string;
  text: string;
  key: string;
}

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
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const slLinesRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const renderedSignalsRef = useRef<Set<string>>(new Set());

  const [barCount, setBarCount] = useState(0);
  const [dateRange, setDateRange] = useState("");
  const [markerPositions, setMarkerPositions] = useState<MarkerPos[]>([]);

  // Recompute pixel positions of signals using chart coordinate transforms
  const computeMarkers = useCallback((signals: SignalNew[]) => {
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    if (!chart || !series) return;

    const positions: MarkerPos[] = [];
    for (const sig of signals) {
      if (!sig.barTime) continue;
      const t = (new Date(sig.barTime).getTime() / 1000) as Time;
      const x = chart.timeScale().timeToCoordinate(t);
      const y = series.priceToCoordinate(sig.entryPrice);
      if (x === null || y === null) continue;

      const isLong = sig.side === "long";
      const color = isLong ? "#22c55e" : "#ef4444";
      positions.push({
        x,
        y: isLong ? y + 22 : y - 22,
        isLong,
        color,
        text: `${sig.confidence}%`,
        key: sig.signalId ?? `${t}`,
      });
    }
    setMarkerPositions(positions);
  }, []);

  const activeSignalsRef = useRef<SignalNew[]>([]);
  activeSignalsRef.current = activeSignals;

  // Create chart + series once on mount
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
      rightPriceScale: { borderColor: "#1f2937", textColor: "#9ca3af" },
      timeScale: { borderColor: "#1f2937", timeVisible: true, secondsVisible: false },
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

    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.74, bottom: 0 } });
    candleSeries.priceScale().applyOptions({ scaleMargins: { top: 0, bottom: 0.28 } });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    // Recompute marker pixel positions on pan/zoom
    const onRangeChange = () => computeMarkers(activeSignalsRef.current);
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange);

    const resizeObs = new ResizeObserver(() => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({
          width: containerRef.current.offsetWidth,
          height: containerRef.current.offsetHeight || 500,
        });
        computeMarkers(activeSignalsRef.current);
      }
    });
    resizeObs.observe(containerRef.current);

    return () => {
      resizeObs.disconnect();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange);
      slLinesRef.current.clear();
      renderedSignalsRef.current.clear();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, [computeMarkers]);

  // Load bars
  useEffect(() => {
    if (!candleSeriesRef.current || !chartRef.current || !bars.length) return;

    const candleData: CandlestickData<Time>[] = bars.map((b) => ({
      time: b.time as Time, open: b.open, high: b.high, low: b.low, close: b.close,
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

    // Zoom to last 200 bars
    const visible = 200;
    if (bars.length > visible) {
      chartRef.current.timeScale().setVisibleLogicalRange({
        from: bars.length - visible,
        to: bars.length + 5,
      });
    } else {
      chartRef.current.timeScale().fitContent();
    }

    setBarCount(bars.length);
    const first = new Date(bars[0].time * 1000).toISOString().slice(0, 10);
    const last = new Date(bars[bars.length - 1].time * 1000).toISOString().slice(0, 10);
    setDateRange(`${first} – ${last}`);

    slLinesRef.current.forEach((s) => { try { chartRef.current?.removeSeries(s); } catch {} });
    slLinesRef.current.clear();
    renderedSignalsRef.current.clear();

    // Recompute after data + range set
    setTimeout(() => computeMarkers(activeSignalsRef.current), 60);
  }, [bars, computeMarkers]);

  // Recompute markers + draw SL lines when signals change
  useEffect(() => {
    computeMarkers(activeSignals);

    for (const sig of activeSignals) {
      if (!sig.signalId || renderedSignalsRef.current.has(sig.signalId)) continue;
      if (!sig.slPrice || !sig.barTime) continue;
      if (!chartRef.current) continue;
      renderedSignalsRef.current.add(sig.signalId);

      const color = sig.side === "long" ? "#ef444460" : "#22c55e60";
      const slSeries = chartRef.current.addSeries(LineSeries, {
        priceScaleId: "right",
        color,
        lineStyle: 2,
        lineWidth: 1,
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
      });

      const sigTime = new Date(sig.barTime).getTime() / 1000;
      const slData: LineData[] = bars
        .filter((b) => b.time >= sigTime)
        .map((b) => ({ time: b.time as Time, value: sig.slPrice }));

      if (slData.length > 0) slSeries.setData(slData);
      slLinesRef.current.set(sig.signalId, slSeries);
    }
  }, [activeSignals, bars, computeMarkers]);

  // Live bar tick
  useEffect(() => {
    if (!candleSeriesRef.current || !lastBar || !bars.length) return;
    try {
      const alignedTime = (lastBar.time - (lastBar.time % intervalSec)) as Time;
      candleSeriesRef.current.update({
        time: alignedTime, open: lastBar.open, high: lastBar.high, low: lastBar.low, close: lastBar.close,
      });
    } catch { /* swallow */ }
  }, [lastBar, bars.length, intervalSec]);

  return (
    <div className="flex flex-col h-full">
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

      {/* Chart canvas + SVG arrow overlay */}
      <div className="flex-1 min-h-0 relative">
        <div ref={containerRef} className="absolute inset-0" />

        {/* SVG overlay rendered by React — sits above the canvas */}
        <svg
          className="absolute inset-0 w-full h-full pointer-events-none overflow-visible"
          style={{ zIndex: 10 }}
          xmlns="http://www.w3.org/2000/svg"
        >
          {markerPositions.map((m) => {
            const S = 9; // arrow size
            const pts = m.isLong
              ? `${m.x},${m.y - S} ${m.x - S * 0.7},${m.y + S * 0.5} ${m.x + S * 0.7},${m.y + S * 0.5}`
              : `${m.x},${m.y + S} ${m.x - S * 0.7},${m.y - S * 0.5} ${m.x + S * 0.7},${m.y - S * 0.5}`;
            return (
              <g key={m.key}>
                <polygon points={pts} fill={m.color} opacity={0.92} />
                <text
                  x={m.x}
                  y={m.isLong ? m.y + S + 12 : m.y - S - 4}
                  textAnchor="middle"
                  fill={m.color}
                  fontSize={9}
                  fontFamily="JetBrains Mono, Menlo, monospace"
                >
                  {m.text}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
