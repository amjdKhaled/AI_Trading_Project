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

interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface MarkerPos {
  x: number;
  y: number;
  isLong: boolean;
  confidence: number;
  key: string;
}

interface Props {
  bars: Bar[];
  activeSignals: SignalNew[];
  lastBar: BarUpdate | null;
  symbol: string;
  timeframe: string;
  intervalSec: number;
}

const PRICE_SCALE_W = 68;
const VOLUME_RATIO  = 0.28;

export function TradingChart({ bars, activeSignals, lastBar, symbol, timeframe, intervalSec }: Props) {
  const containerRef  = useRef<HTMLDivElement>(null);
  const chartRef      = useRef<IChartApi | null>(null);
  const candleRef     = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef     = useRef<ISeriesApi<"Histogram"> | null>(null);
  const activeSLRef   = useRef<ISeriesApi<"Line"> | null>(null);
  const activeTPRef   = useRef<ISeriesApi<"Line"> | null>(null);
  const lastSigIdRef  = useRef<string | null>(null);
  const barsRef       = useRef<Bar[]>([]);

  const [barCount, setBarCount]         = useState(0);
  const [dateRange, setDateRange]       = useState("");
  const [markerPositions, setMarkerPos] = useState<MarkerPos[]>([]);

  const activeSignalsRef = useRef<SignalNew[]>([]);
  activeSignalsRef.current = activeSignals;
  barsRef.current = bars;

  const computeMarkers = useCallback((signals: SignalNew[]) => {
    const chart  = chartRef.current;
    const series = candleRef.current;
    const container = containerRef.current;
    if (!chart || !series || !container) return;

    const W    = container.offsetWidth;
    const H    = container.offsetHeight;
    const maxX = W - PRICE_SCALE_W;
    const maxY = H * (1 - VOLUME_RATIO);
    const snap = barsRef.current;

    const positions: MarkerPos[] = [];

    // Only show the single latest signal marker on the chart
    // All other signals appear in the side panel — the chart stays clean
    const latestOnly = signals.slice(0, 1);

    for (const sig of latestOnly) {
      if (!sig.barTime) continue;
      const sigSec = Math.floor(new Date(sig.barTime).getTime() / 1000);

      // Find nearest bar in current chart data (handles cross-timeframe barTimes)
      let nearest: Bar | undefined;
      let minDiff = Infinity;
      for (const b of snap) {
        const d = Math.abs(b.time - sigSec);
        if (d < minDiff) { minDiff = d; nearest = b; }
      }
      if (!nearest) continue;

      const x = chart.timeScale().timeToCoordinate(nearest.time as Time);
      if (x === null || x < 0 || x > maxX) continue;

      const isLong      = sig.side === "long";
      const anchorPrice = isLong ? nearest.low : nearest.high;
      const y           = series.priceToCoordinate(anchorPrice);
      if (y === null || y < 0 || y > maxY) continue;

      positions.push({
        x,
        y: isLong ? y + 5 : y - 5,
        isLong,
        confidence: sig.confidence,
        key: sig.signalId ?? `${nearest.time}-${sig.side}`,
      });
    }

    setMarkerPos(positions);
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background:  { color: "#0b0e14" },
        textColor:   "#9ca3af",
        fontFamily:  "'JetBrains Mono', 'Menlo', monospace",
        fontSize:    11,
      },
      grid: {
        vertLines: { color: "#151b26" },
        horzLines: { color: "#151b26" },
      },
      crosshair:       { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#1f2937", textColor: "#9ca3af" },
      timeScale:       { borderColor: "#1f2937", timeVisible: true, secondsVisible: false },
      width:  containerRef.current.offsetWidth,
      height: containerRef.current.offsetHeight || 500,
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor:        "#26a69a",
      downColor:      "#ef5350",
      borderUpColor:  "#26a69a",
      borderDownColor:"#ef5350",
      wickUpColor:    "#26a69a",
      wickDownColor:  "#ef5350",
    });

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceScaleId:     "volume",
      priceFormat:      { type: "volume" },
      priceLineVisible: false,
      lastValueVisible: false,
    });

    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.74, bottom: 0 } });
    candleSeries.priceScale().applyOptions({ scaleMargins: { top: 0.02, bottom: 0.28 } });

    chartRef.current  = chart;
    candleRef.current = candleSeries;
    volumeRef.current = volumeSeries;

    const onRange = () => computeMarkers(activeSignalsRef.current);
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);

    const ro = new ResizeObserver(() => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({
          width:  containerRef.current.offsetWidth,
          height: containerRef.current.offsetHeight || 500,
        });
        computeMarkers(activeSignalsRef.current);
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
      activeSLRef.current = null;
      activeTPRef.current = null;
      lastSigIdRef.current = null;
      chart.remove();
      chartRef.current  = null;
      candleRef.current = null;
      volumeRef.current = null;
    };
  }, [computeMarkers]);

  useEffect(() => {
    if (!candleRef.current || !chartRef.current || !bars.length) return;

    const candleData: CandlestickData<Time>[] = bars.map((b) => ({
      time: b.time as Time, open: b.open, high: b.high, low: b.low, close: b.close,
    }));
    candleRef.current.setData(candleData);

    if (volumeRef.current) {
      const volumeData: HistogramData[] = bars.map((b) => ({
        time: b.time as Time,
        value: b.volume,
        color: b.close >= b.open ? "#26a69a28" : "#ef535028",
      }));
      volumeRef.current.setData(volumeData);
    }

    const visible = 150;
    if (bars.length > visible) {
      chartRef.current.timeScale().setVisibleLogicalRange({ from: bars.length - visible, to: bars.length + 5 });
    } else {
      chartRef.current.timeScale().fitContent();
    }

    setBarCount(bars.length);
    const first = new Date(bars[0].time * 1000).toISOString().slice(0, 10);
    const last  = new Date(bars[bars.length - 1].time * 1000).toISOString().slice(0, 10);
    setDateRange(`${first} – ${last}`);

    // Clear SL/TP lines when chart data reloads
    if (activeSLRef.current) { try { chartRef.current?.removeSeries(activeSLRef.current); } catch {} activeSLRef.current = null; }
    if (activeTPRef.current) { try { chartRef.current?.removeSeries(activeTPRef.current); } catch {} activeTPRef.current = null; }
    lastSigIdRef.current = null;

    setTimeout(() => computeMarkers(activeSignalsRef.current), 80);
  }, [bars, computeMarkers]);

  useEffect(() => {
    computeMarkers(activeSignals);

    if (!chartRef.current || !bars.length || !activeSignals.length) return;

    const chart = chartRef.current;
    const sig   = activeSignals[0];
    if (!sig || sig.signalId === lastSigIdRef.current) return;
    lastSigIdRef.current = sig.signalId;

    // Remove old SL/TP lines
    if (activeSLRef.current) { try { chart.removeSeries(activeSLRef.current); } catch {} activeSLRef.current = null; }
    if (activeTPRef.current) { try { chart.removeSeries(activeTPRef.current); } catch {} activeTPRef.current = null; }

    if (!sig.slPrice || !sig.tpPrice || !sig.barTime) return;

    const sigSec = Math.floor(new Date(sig.barTime).getTime() / 1000);
    const startIdx = bars.findIndex((b) => b.time >= sigSec - 60);
    const lineSlice = startIdx >= 0 ? bars.slice(startIdx) : bars.slice(-60);
    if (lineSlice.length === 0) return;

    const mkLine = (color: string, value: number): ISeriesApi<"Line"> => {
      const s = chart.addSeries(LineSeries, {
        priceScaleId:          "right",
        color,
        lineStyle:             2,
        lineWidth:             1,
        lastValueVisible:      false,
        priceLineVisible:      false,
        crosshairMarkerVisible:false,
      });
      const data: LineData[] = lineSlice.map((b) => ({ time: b.time as Time, value }));
      s.setData(data);
      return s;
    };

    activeSLRef.current = mkLine("#ef535088", sig.slPrice);
    activeTPRef.current = mkLine("#26a69a88", sig.tpPrice);
  }, [activeSignals, bars, computeMarkers]);

  useEffect(() => {
    if (!candleRef.current || !lastBar || !bars.length) return;
    try {
      const t = (lastBar.time - (lastBar.time % intervalSec)) as Time;
      candleRef.current.update({ time: t, open: lastBar.open, high: lastBar.high, low: lastBar.low, close: lastBar.close });
    } catch { /* swallow stale updates */ }
  }, [lastBar, bars.length, intervalSec]);

  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div className="flex items-center gap-3 px-3 py-1.5 border-b border-white/5 flex-shrink-0">
        <span className="font-mono text-sm font-bold text-foreground">{symbol}</span>
        <span className="text-xs text-muted-foreground/70 font-mono uppercase">{timeframe}</span>
        {barCount > 0 && (
          <span className="text-[10px] text-muted-foreground/50 font-mono hidden md:inline">
            {barCount.toLocaleString()} bars · {dateRange}
          </span>
        )}
        <div className="flex-1" />
        <span className="text-[10px] text-emerald-400 font-mono tracking-widest">LIVE</span>
        <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
      </div>

      {/* Chart + SVG overlay */}
      <div className="flex-1 min-h-0 relative overflow-hidden">
        <div ref={containerRef} className="absolute inset-0" />

        <svg
          className="absolute inset-0 w-full h-full pointer-events-none"
          style={{ zIndex: 10, overflow: "hidden" }}
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <filter id="luxGreen" x="-80%" y="-80%" width="260%" height="260%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="3.5" result="blur"/>
              <feColorMatrix in="blur" type="matrix"
                values="0 0 0 0 0.149  0 0 0 0 0.647  0 0 0 0 0.604  0 0 0 0.9 0"
                result="coloredBlur"/>
              <feMerge>
                <feMergeNode in="coloredBlur"/>
                <feMergeNode in="SourceGraphic"/>
              </feMerge>
            </filter>
            <filter id="luxRed" x="-80%" y="-80%" width="260%" height="260%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="3.5" result="blur"/>
              <feColorMatrix in="blur" type="matrix"
                values="0 0 0 0 0.937  0 0 0 0 0.325  0 0 0 0 0.314  0 0 0 0.9 0"
                result="coloredBlur"/>
              <feMerge>
                <feMergeNode in="coloredBlur"/>
                <feMergeNode in="SourceGraphic"/>
              </feMerge>
            </filter>
          </defs>

          {markerPositions.map((m) => {
            const color  = m.isLong ? "#26a69a" : "#ef5350";
            const filter = m.isLong ? "url(#luxGreen)" : "url(#luxRed)";
            const W = 9;
            const H = 13;

            const pts = m.isLong
              // LONG: tip up (toward candle), base below
              ? `${m.x},${m.y - H} ${m.x - W},${m.y + 2} ${m.x + W},${m.y + 2}`
              // SHORT: tip down (toward candle), base above
              : `${m.x},${m.y + H} ${m.x - W},${m.y - 2} ${m.x + W},${m.y - 2}`;

            const labelY = m.isLong ? m.y + 14 : m.y - H - 4;

            return (
              <g key={m.key}>
                <polygon
                  points={pts}
                  fill={color}
                  opacity={0.92}
                  filter={filter}
                />
                <text
                  x={m.x}
                  y={labelY}
                  textAnchor="middle"
                  fill={color}
                  fontSize={8}
                  fontFamily="'JetBrains Mono', Menlo, monospace"
                  fontWeight="700"
                  opacity={0.85}
                >
                  {m.confidence}%
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
