import { useEffect, useRef, useCallback, useState } from "react";
import {
  createChart, CrosshairMode, CandlestickSeries, HistogramSeries, LineSeries,
  type IChartApi, type ISeriesApi, type CandlestickData,
  type HistogramData, type Time, type LineData,
} from "lightweight-charts";
import type { BarUpdate, SignalNew } from "@/hooks/useMarketSocket";
import type { ActiveTrade, TradeResult } from "@/pages/ChartPage";

interface Bar { time: number; open: number; high: number; low: number; close: number; volume: number; }

interface MarkerPos {
  x: number; y: number; isLong: boolean;
  confidence: number; key: string; isActive: boolean;
}
interface ExitPos { x: number; y: number; isWin: boolean; }

interface Props {
  bars: Bar[];
  signals: SignalNew[];
  activeTrade: ActiveTrade | null;
  tradeResult: TradeResult | null;
  lastBar: BarUpdate | null;
  symbol: string;
  timeframe: string;
  intervalSec: number;
  isMarketOpen: boolean;
}

const PRICE_SCALE_W = 68;
// Fraction of chart height reserved for the volume pane (must match scaleMargins bottom below)
const VOLUME_RATIO  = 0.22;

export function TradingChart({ bars, signals, activeTrade, tradeResult, lastBar, symbol, timeframe, intervalSec, isMarketOpen }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<IChartApi | null>(null);
  const candleRef    = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef    = useRef<ISeriesApi<"Histogram"> | null>(null);
  const slRef        = useRef<ISeriesApi<"Line"> | null>(null);
  const tpRef        = useRef<ISeriesApi<"Line"> | null>(null);
  const tradeIdRef   = useRef<string | null>(null);
  const barsRef      = useRef<Bar[]>([]);

  // stable refs for computeMarkers closure
  const signalsRef     = useRef<SignalNew[]>([]);
  const activeTradeRef = useRef<ActiveTrade | null>(null);
  const tradeResultRef = useRef<TradeResult | null>(null);
  signalsRef.current     = signals;
  activeTradeRef.current = activeTrade;
  tradeResultRef.current = tradeResult;
  barsRef.current        = bars;

  const [barCount, setBarCount]   = useState(0);
  const [dateRange, setDateRange] = useState("");
  const [markers, setMarkers]     = useState<MarkerPos[]>([]);
  const [exitPos, setExitPos]     = useState<ExitPos | null>(null);

  const removeSLTP = useCallback(() => {
    const c = chartRef.current;
    if (!c) return;
    if (slRef.current) { try { c.removeSeries(slRef.current); } catch {} slRef.current = null; }
    if (tpRef.current) { try { c.removeSeries(tpRef.current); } catch {} tpRef.current = null; }
  }, []);

  const computeMarkers = useCallback(() => {
    const chart  = chartRef.current;
    const series = candleRef.current;
    const el     = containerRef.current;
    if (!chart || !series || !el) return;

    const W    = el.offsetWidth;
    const H    = el.offsetHeight;
    const maxX = W - PRICE_SCALE_W;
    const maxY = H * (1 - VOLUME_RATIO);
    const snap = barsRef.current;
    const trade = activeTradeRef.current;
    const tr    = tradeResultRef.current;

    const nearestBar = (targetSec: number) => {
      let best: Bar | undefined;
      let minD = Infinity;
      for (const b of snap) {
        const d = Math.abs(b.time - targetSec);
        if (d < minD) { minD = d; best = b; }
      }
      return best;
    };

    const toCoords = (b: Bar, isLong: boolean) => {
      const x = chart.timeScale().timeToCoordinate(b.time as Time);
      if (x === null || x < 0 || x > maxX) return null;
      const price = isLong ? b.low : b.high;
      const y = series.priceToCoordinate(price);
      if (y === null || y < 0 || y > maxY) return null;
      return { x, y: isLong ? y + 5 : y - 5 };
    };

    // Which signals to show markers for
    const sigList = trade
      ? signalsRef.current.filter((s) => s.signalId === trade.signalId)
      : signalsRef.current.slice(0, 5);

    const positions: MarkerPos[] = [];
    for (const sig of sigList) {
      if (!sig.barTime) continue;
      const b = nearestBar(Math.floor(new Date(sig.barTime).getTime() / 1000));
      if (!b) continue;
      const coords = toCoords(b, sig.side === "long");
      if (!coords) continue;
      positions.push({
        ...coords,
        isLong: sig.side === "long",
        confidence: sig.confidence,
        key: sig.signalId,
        isActive: !!trade && sig.signalId === trade.signalId,
      });
    }
    setMarkers(positions);

    // Exit marker
    if (tr) {
      const b = nearestBar(tr.exitTime);
      if (b) {
        const x = chart.timeScale().timeToCoordinate(b.time as Time);
        const isWin = tr.outcome === "tp_hit";
        const y = series.priceToCoordinate(isWin ? b.high : b.low);
        if (x !== null && y !== null && x >= 0 && x <= maxX && y >= 0 && y <= maxY) {
          setExitPos({ x, y: isWin ? y - 22 : y + 22, isWin });
        } else {
          setExitPos(null);
        }
      }
    } else {
      setExitPos(null);
    }
  }, []);

  // Chart init
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#0b0e14" }, textColor: "#9ca3af", fontFamily: "'JetBrains Mono','Menlo',monospace", fontSize: 11 },
      grid:   { vertLines: { color: "#151b26" }, horzLines: { color: "#151b26" } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: {
        borderColor: "#1f2937",
        textColor:   "#9ca3af",
        autoScale:   true,
        // Prevent bars from collapsing to sub-pixel width when zoomed far out
        minimumWidth: 1,
      },
      timeScale: {
        borderColor:      "#1f2937",
        timeVisible:      true,
        secondsVisible:   false,
        // Prevent candles from being crushed to invisible width on zoom-out
        minBarSpacing:    0.5,
        // Keep the right edge ~5% inset so the last candle isn't flush against the price scale
        rightOffset:      5,
      },
      width:  containerRef.current.offsetWidth,
      height: containerRef.current.offsetHeight || 500,
    });

    const candle = chart.addSeries(CandlestickSeries, {
      upColor: "#26a69a", downColor: "#ef5350",
      borderUpColor: "#26a69a", borderDownColor: "#ef5350",
      wickUpColor: "#26a69a", wickDownColor: "#ef5350",
    });
    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: "volume", priceFormat: { type: "volume" },
      priceLineVisible: false, lastValueVisible: false,
    });
    // Volume pane occupies the bottom 22% (matches VOLUME_RATIO constant).
    // Candle pane: 78% of height with 5% breathing room above the high-of-range.
    // 5% top + 22% bottom = TradingView-like proportions where candles fill 73% of the pane.
    volume.priceScale().applyOptions({ scaleMargins: { top: 1 - VOLUME_RATIO, bottom: 0 } });
    candle.priceScale().applyOptions({ scaleMargins: { top: 0.05, bottom: VOLUME_RATIO } });

    chartRef.current  = chart;
    candleRef.current = candle;
    volumeRef.current = volume;

    chart.timeScale().subscribeVisibleLogicalRangeChange(computeMarkers);
    const ro = new ResizeObserver(() => {
      if (!containerRef.current || !chartRef.current) return;
      chartRef.current.applyOptions({ width: containerRef.current.offsetWidth, height: containerRef.current.offsetHeight || 500 });
      computeMarkers();
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(computeMarkers);
      removeSLTP();
      tradeIdRef.current = null;
      chart.remove();
      chartRef.current = candleRef.current = volumeRef.current = null;
    };
  }, [computeMarkers, removeSLTP]);

  // Load bar data
  useEffect(() => {
    if (!candleRef.current || !chartRef.current || !bars.length) return;

    candleRef.current.setData(bars.map<CandlestickData<Time>>((b) => ({
      time: b.time as Time, open: b.open, high: b.high, low: b.low, close: b.close,
    })));
    volumeRef.current?.setData(bars.map<HistogramData>((b) => ({
      time: b.time as Time, value: b.volume,
      color: b.close >= b.open ? "#26a69a28" : "#ef535028",
    })));

    // Default view: last 78 bars = exactly one NYSE session (9:30–16:00 = 78 × 5m bars).
    // This matches TradingView's default zoom on a 5m chart — one full day is visible,
    // each candle is wide enough to clearly show body + wicks.
    // User can scroll left for full multi-year history or zoom out for a wider view.
    const defaultBars = 78;
    if (bars.length > defaultBars) {
      chartRef.current.timeScale().setVisibleLogicalRange({
        from: bars.length - defaultBars,
        to:   bars.length + 5,  // small right-side padding so last bar isn't cut off
      });
    } else {
      chartRef.current.timeScale().fitContent();
    }

    setBarCount(bars.length);
    setDateRange(
      `${new Date(bars[0].time * 1000).toISOString().slice(0, 10)} – ${new Date(bars[bars.length - 1].time * 1000).toISOString().slice(0, 10)}`
    );

    removeSLTP();
    tradeIdRef.current = null;
    setTimeout(computeMarkers, 80);
  }, [bars, computeMarkers, removeSLTP]);

  // Active trade → SL/TP lines
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !bars.length) return;

    if (!activeTrade) {
      removeSLTP();
      tradeIdRef.current = null;
      setTimeout(computeMarkers, 30);
      return;
    }

    if (activeTrade.signalId === tradeIdRef.current) return;
    tradeIdRef.current = activeTrade.signalId;
    removeSLTP();

    // Line data from entry bar to beyond the last bar (so line reaches live edge)
    const sigSec = Math.floor(new Date(activeTrade.barTime).getTime() / 1000);
    const startIdx = bars.findIndex((b) => b.time >= sigSec - intervalSec);
    const lineSlice = startIdx >= 0 ? bars.slice(startIdx) : bars.slice(-100);
    if (lineSlice.length === 0) return;

    // Extend line 50 bars into the future (fake times for visual continuity)
    const lastT  = lineSlice[lineSlice.length - 1].time;
    const extras: LineData[] = Array.from({ length: 50 }, (_, k) => ({
      time: (lastT + intervalSec * (k + 1)) as Time, value: 0, // placeholder; series handles fill
    }));

    const mkLine = (color: string, value: number): ISeriesApi<"Line"> => {
      const s = chart.addSeries(LineSeries, {
        priceScaleId: "right", color, lineStyle: 2, lineWidth: 1,
        lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
      });
      const historicalPts: LineData[] = lineSlice.map((b) => ({ time: b.time as Time, value }));
      const futurePts: LineData[] = extras.map((e) => ({ ...e, value }));
      s.setData([...historicalPts, ...futurePts]);
      return s;
    };

    slRef.current = mkLine("#ef535088", activeTrade.slPrice);
    tpRef.current = mkLine("#26a69a88", activeTrade.tpPrice);
    setTimeout(computeMarkers, 50);
  }, [activeTrade, bars, intervalSec, computeMarkers, removeSLTP]);

  // Recompute on signal/result changes
  useEffect(() => { setTimeout(computeMarkers, 30); }, [signals, tradeResult, computeMarkers]);

  // Live tick
  useEffect(() => {
    if (!candleRef.current || !lastBar || !bars.length) return;
    try {
      const t = (lastBar.time - (lastBar.time % intervalSec)) as Time;
      candleRef.current.update({ time: t, open: lastBar.open, high: lastBar.high, low: lastBar.low, close: lastBar.close });
    } catch {}
  }, [lastBar, bars.length, intervalSec]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-3 py-1.5 border-b border-white/5 flex-shrink-0">
        <span className="font-mono text-sm font-bold text-foreground">{symbol}</span>
        <span className="text-xs text-muted-foreground/70 font-mono uppercase">{timeframe}</span>
        {barCount > 0 && (
          <span className="text-[10px] text-muted-foreground/50 font-mono hidden md:inline">
            {barCount.toLocaleString()} bars · {dateRange}
          </span>
        )}
        <div className="flex-1" />
        {isMarketOpen ? (
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

      {/* Chart + SVG overlay */}
      <div className="flex-1 min-h-0 relative overflow-hidden">
        <div ref={containerRef} className="absolute inset-0" />

        <svg
          className="absolute inset-0 w-full h-full pointer-events-none"
          style={{ zIndex: 10, overflow: "hidden" }}
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <filter id="gGreen" x="-80%" y="-80%" width="260%" height="260%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="3.5" result="b"/>
              <feColorMatrix in="b" type="matrix" values="0 0 0 0 0.149  0 0 0 0 0.647  0 0 0 0 0.604  0 0 0 0.9 0" result="cb"/>
              <feMerge><feMergeNode in="cb"/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>
            <filter id="gRed" x="-80%" y="-80%" width="260%" height="260%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="3.5" result="b"/>
              <feColorMatrix in="b" type="matrix" values="0 0 0 0 0.937  0 0 0 0 0.325  0 0 0 0 0.314  0 0 0 0.9 0" result="cb"/>
              <feMerge><feMergeNode in="cb"/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>
          </defs>

          {/* Signal entry markers */}
          {markers.map((m) => {
            const col = m.isLong ? "#26a69a" : "#ef5350";
            const flt = m.isLong ? "url(#gGreen)" : "url(#gRed)";
            const mW  = m.isActive ? 11 : 8;
            const mH  = m.isActive ? 16 : 11;
            const pts = m.isLong
              ? `${m.x},${m.y - mH} ${m.x - mW},${m.y + 2} ${m.x + mW},${m.y + 2}`
              : `${m.x},${m.y + mH} ${m.x - mW},${m.y - 2} ${m.x + mW},${m.y - 2}`;
            const labelY = m.isLong ? m.y + 15 : m.y - mH - 4;

            return (
              <g key={m.key}>
                <polygon points={pts} fill={col} opacity={m.isActive ? 1 : 0.72} filter={flt} />
                <text x={m.x} y={labelY} textAnchor="middle" fill={col}
                  fontSize={m.isActive ? 9 : 7.5}
                  fontFamily="'JetBrains Mono',Menlo,monospace"
                  fontWeight="700" opacity={0.9}>
                  {m.confidence}%
                </text>
              </g>
            );
          })}

          {/* Exit marker (shown for 6s after trade closes) */}
          {exitPos && (
            <g>
              <circle cx={exitPos.x} cy={exitPos.y} r={10}
                fill={exitPos.isWin ? "#26a69a18" : "#ef535018"}
                stroke={exitPos.isWin ? "#26a69a" : "#ef5350"}
                strokeWidth={1.5}
                filter={exitPos.isWin ? "url(#gGreen)" : "url(#gRed)"}
              />
              <text x={exitPos.x} y={exitPos.y + 4.5} textAnchor="middle"
                fill={exitPos.isWin ? "#26a69a" : "#ef5350"}
                fontSize={10} fontFamily="'JetBrains Mono',Menlo,monospace" fontWeight="700">
                {exitPos.isWin ? "✓" : "✗"}
              </text>
            </g>
          )}
        </svg>
      </div>
    </div>
  );
}
