import { useEffect, useRef, useCallback, useState } from "react";
import {
  createChart, CrosshairMode, CandlestickSeries, HistogramSeries,
  type IChartApi, type ISeriesApi, type CandlestickData,
  type HistogramData, type Time, type AutoscaleInfo, type IPriceLine,
} from "lightweight-charts";
import type { PriceUpdate, SignalNew } from "@/hooks/useMarketSocket";
import type { ActiveTrade, TradeResult, AiCandleDecision, ResolvedAiDecision } from "@/pages/ChartPage";
import { CandleStateManager, type CSMTelemetry } from "@/lib/CandleStateManager";

interface Bar { time: number; open: number; high: number; low: number; close: number; volume: number; }

interface MarkerPos {
  x: number; y: number; isLong: boolean;
  confidence: number; key: string; isActive: boolean;
  grade?: "A+" | "A" | "B" | "Weak";
  // Historical exit info — present when the signal has resolved via backtest.
  // When set, the chart draws an exit marker at (exitX, exitY) and a thin
  // connecting line from the entry marker to the exit marker.
  exitX?: number;
  exitY?: number;
  outcome?: "tp_hit" | "sl_hit" | "expired";
  // Price at the exit bar — used for the trade outcome label.
  exitPrice?: number;
  entryPrice?: number;
}
interface ExitPos { x: number; y: number; isWin: boolean; }

interface AiMarkerPos {
  key: string;
  x: number;
  y: number;
  entryY: number;
  slY: number;
  tpY: number;
  rightX: number;
  isLong: boolean;
  confidence: number;
  reasoning?: string;
  marketBias?: string;
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  isActive: boolean;
}

export interface CryptoLiveBar {
  time: number; open: number; high: number; low: number; close: number;
}

interface DecisionMarkerPos {
  key:        string;
  x:          number;
  y:          number;
  isLong:     boolean;
  isShort:    boolean;
  verdict:    "APPROVE" | "REJECT" | "WAIT";
  confidence: number;
  decision:   AiCandleDecision;
}

interface ResolvedDecisionPos {
  key:      string;
  x:        number;
  y:        number;
  isLong:   boolean;
  outcome:  "tp_hit" | "sl_hit" | "expired";
}

interface Props {
  bars: Bar[];
  signals: SignalNew[];
  aiSignals: SignalNew[];
  activeTrade: ActiveTrade | null;
  tradeResult: TradeResult | null;
  lastPrice: PriceUpdate | null;
  symbol: string;
  timeframe: string;
  intervalSec: number;
  isMarketOpen: boolean;
  realtimeAvailable: boolean;
  /** When set, directly updates the chart with full OHLCV — used for Binance crypto live klines */
  cryptoLiveBar?: CryptoLiveBar | null;
  /** AI candle-close decisions to render as chart markers (APPROVE/REJECT/WAIT) */
  aiDecisions?: AiCandleDecision[];
  /** Called by the CSM after every live candle closes — triggers the AI pipeline */
  onCandleClose?: (barTime: number) => void;
  /** Show "AI analyzing…" spinner in the chart header */
  aiAnalyzing?: boolean;
  /** Newest APPROVED AI candle-close decision from DB — shown with full R/R box + entry/SL/TP lines */
  activeApprovedDecision?: AiCandleDecision | null;
  /** Resolved (outcome != null) APPROVED AI decisions — rendered as compact outcome markers */
  resolvedAiDecisions?: ResolvedAiDecision[];
}

const PRICE_SCALE_W = 68;
// Fraction of chart height reserved for the volume pane (must match scaleMargins bottom below)
const VOLUME_RATIO  = 0.22;

// ── OHLC validation ───────────────────────────────────────────────────────────
// Returns true only if all four values are finite, non-NaN, and internally
// consistent (high >= open/close, low <= open/close, low <= high).
function isValidOhlc(o: number, h: number, l: number, c: number): boolean {
  if (!isFinite(o) || !isFinite(h) || !isFinite(l) || !isFinite(c)) return false;
  if (isNaN(o)     || isNaN(h)     || isNaN(l)     || isNaN(c))     return false;
  if (h < o || h < c) return false;
  if (l > o || l > c) return false;
  if (l > h)          return false;
  return true;
}

// Rolling average bar range over the last N bars (used for ATR-based spike rejection).
function avgBarRange(bars: Bar[], n = 50): number {
  const slice = bars.slice(-n);
  if (slice.length < 5) return 0;
  return slice.reduce((sum, b) => sum + (b.high - b.low), 0) / slice.length;
}

export function TradingChart({ bars, signals, aiSignals, activeTrade, tradeResult, lastPrice, symbol, timeframe, intervalSec, isMarketOpen, realtimeAvailable, cryptoLiveBar, aiDecisions = [], onCandleClose, aiAnalyzing = false, activeApprovedDecision = null, resolvedAiDecisions = [] }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<IChartApi | null>(null);
  const candleRef    = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef    = useRef<ISeriesApi<"Histogram"> | null>(null);
  const slRef        = useRef<IPriceLine | null>(null);
  const tpRef        = useRef<IPriceLine | null>(null);
  const entryLineRef = useRef<IPriceLine | null>(null);
  const tradeIdRef       = useRef<string | null>(null);
  const barsRef          = useRef<Bar[]>([]);
  // Timestamp of the last bar in the most-recently loaded historical dataset.
  // Live ticks are only allowed for timestamps STRICTLY AFTER this value.
  const lastHistTimeRef  = useRef<number>(0);
  // CandleStateManager: SOLE writer to the candle series.  Nothing else in the
  // codebase may call candleSeries.update().  It owns OHLC construction, validation,
  // interval state machine, finalization, and telemetry.
  const csmRef = useRef<CandleStateManager | null>(null);
  const [telemetry, setTelemetry] = useState<CSMTelemetry | null>(null);
  // Telemetry display is throttled — re-rendering the full chart on every tick
  // would defeat the purpose of the chart engine's incremental update path.
  const telemetryLastPushMs   = useRef<number>(0);
  const telemetryLastRejected = useRef<number>(0);
  const telemetryLastFinal    = useRef<number>(0);
  const TELEMETRY_THROTTLE_MS = 2_000;

  // Stable refs that CandleStateManager closures read from
  const symbolRef       = useRef(symbol);
  const intervalSecRef  = useRef(intervalSec);
  const isMarketOpenRef = useRef(isMarketOpen);
  symbolRef.current       = symbol;
  intervalSecRef.current  = intervalSec;
  isMarketOpenRef.current = isMarketOpen;

  // stable refs for computeMarkers closure
  const signalsRef     = useRef<SignalNew[]>([]);
  const aiSignalsRef   = useRef<SignalNew[]>([]);
  const activeTradeRef = useRef<ActiveTrade | null>(null);
  const tradeResultRef = useRef<TradeResult | null>(null);
  signalsRef.current     = signals;
  aiSignalsRef.current   = aiSignals;
  activeTradeRef.current = activeTrade;
  tradeResultRef.current = tradeResult;
  barsRef.current        = bars;

  // Stable refs for candle-close AI decision pipeline
  const onCandleCloseRef         = useRef(onCandleClose);
  const aiDecisionsRef           = useRef<AiCandleDecision[]>([]);
  const activeApprovedRef        = useRef<AiCandleDecision | null>(null);
  const resolvedAiDecisionsRef   = useRef<ResolvedAiDecision[]>([]);
  onCandleCloseRef.current        = onCandleClose;
  aiDecisionsRef.current          = aiDecisions;
  activeApprovedRef.current       = activeApprovedDecision;
  resolvedAiDecisionsRef.current  = resolvedAiDecisions;

  const [barCount, setBarCount]   = useState(0);
  const [dateRange, setDateRange] = useState("");
  const [markers, setMarkers]     = useState<MarkerPos[]>([]);
  const [exitPos, setExitPos]     = useState<ExitPos | null>(null);
  const [activeZone, setActiveZone] = useState<{
    x: number; rightX: number; tpY: number; slY: number; isLong: boolean;
  } | null>(null);
  const [aiMarkers, setAiMarkers]     = useState<AiMarkerPos[]>([]);
  const [hoveredAiKey, setHoveredAiKey] = useState<string | null>(null);
  const [decisionMarkers, setDecisionMarkers] = useState<DecisionMarkerPos[]>([]);
  const [selectedDecision, setSelectedDecision] = useState<AiCandleDecision | null>(null);
  const [resolvedDecisionMarkers, setResolvedDecisionMarkers] = useState<ResolvedDecisionPos[]>([]);

  const removeSLTP = useCallback(() => {
    const cs = candleRef.current;
    if (!cs) return;
    if (slRef.current)        { try { cs.removePriceLine(slRef.current); }        catch {} slRef.current = null; }
    if (tpRef.current)        { try { cs.removePriceLine(tpRef.current); }        catch {} tpRef.current = null; }
    if (entryLineRef.current) { try { cs.removePriceLine(entryLineRef.current); } catch {} entryLineRef.current = null; }
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

    // Bars are time-sorted on the same interval grid as signal barTimes,
    // so an O(1) Map lookup keyed on the bucket start works for almost every
    // signal. Falls back to binary search for any signal whose timestamp
    // happens to land between buckets (legacy data, DST seam, etc.).
    const byTime = new Map<number, Bar>();
    for (const b of snap) byTime.set(b.time, b);
    const nearestBar = (targetSec: number): Bar | undefined => {
      const hit = byTime.get(targetSec);
      if (hit) return hit;
      // binary search for nearest
      let lo = 0, hi = snap.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (snap[mid].time < targetSec) lo = mid + 1; else hi = mid;
      }
      const cand = snap[lo];
      if (!cand) return undefined;
      const prev = snap[lo - 1];
      if (prev && Math.abs(prev.time - targetSec) < Math.abs(cand.time - targetSec)) return prev;
      return cand;
    };

    const toCoords = (b: Bar, isLong: boolean) => {
      const x = chart.timeScale().timeToCoordinate(b.time as Time);
      if (x === null || x < 0 || x > maxX) return null;
      const price = isLong ? b.low : b.high;
      const y = series.priceToCoordinate(price);
      if (y === null || y < 0 || y > maxY) return null;
      return { x, y: isLong ? y + 5 : y - 5 };
    };

    // Render markers for ALL historical signals across the full chart.
    // toCoords returns null for off-viewport signals, so they're skipped
    // automatically; the SVG only paints what's currently visible.
    const sigList = signalsRef.current;

    const positions: MarkerPos[] = [];
    for (const sig of sigList) {
      if (!sig.barTime) continue;
      const b = nearestBar(Math.floor(new Date(sig.barTime).getTime() / 1000));
      if (!b) continue;
      const coords = toCoords(b, sig.side === "long");
      if (!coords) continue;

      // Compute exit coords if this signal has resolved historically.
      // Exit marker is drawn at the actual exit price (TP/SL level for hits,
      // bar close for expired) on the exit bar.
      let exitX: number | undefined;
      let exitY: number | undefined;
      let exitPriceNum: number | undefined;
      const outcome = sig.state && sig.state !== "active" ? sig.state : undefined;
      if (outcome && sig.exitBarTime && sig.exitPrice != null) {
        const exitSec = Math.floor(new Date(sig.exitBarTime).getTime() / 1000);
        const xb = nearestBar(exitSec);
        if (xb) {
          const xCoord = chart.timeScale().timeToCoordinate(xb.time as Time);
          const yCoord = series.priceToCoordinate(sig.exitPrice);
          if (xCoord !== null && yCoord !== null && xCoord >= 0 && xCoord <= maxX && yCoord >= 0 && yCoord <= maxY) {
            exitX        = xCoord;
            exitY        = yCoord;
            exitPriceNum = sig.exitPrice;
          }
        }
      }

      positions.push({
        ...coords,
        isLong: sig.side === "long",
        confidence: sig.confidence,
        grade: sig.grade,
        key: sig.signalId,
        isActive: !!trade && sig.signalId === trade.signalId,
        exitX, exitY, outcome,
        exitPrice:  exitPriceNum,
        entryPrice: sig.entryPrice,
      });
    }
    setMarkers(positions);

    // Active trade lifecycle zone: translucent band from entry bar to chart right edge
    const activeM = positions.find(p => p.isActive);
    if (activeM && trade) {
      const tpY = series.priceToCoordinate(trade.tpPrice);
      const slY = series.priceToCoordinate(trade.slPrice);
      if (tpY !== null && slY !== null) {
        setActiveZone({ x: activeM.x, rightX: maxX, tpY: Math.max(0, tpY), slY: Math.min(maxY, slY), isLong: activeM.isLong });
      } else { setActiveZone(null); }
    } else { setActiveZone(null); }

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

  const computeAiMarkers = useCallback(() => {
    const chart  = chartRef.current;
    const series = candleRef.current;
    const el     = containerRef.current;
    if (!chart || !series || !el) return;

    const W    = el.offsetWidth;
    const H    = el.offsetHeight;
    const maxX = W - PRICE_SCALE_W;
    const maxY = H * (1 - VOLUME_RATIO);
    const snap = barsRef.current;

    const byTime = new Map<number, Bar>();
    for (const b of snap) byTime.set(b.time, b);
    const nearestBar = (targetSec: number): Bar | undefined => {
      const hit = byTime.get(targetSec);
      if (hit) return hit;
      let lo = 0, hi = snap.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (snap[mid].time < targetSec) lo = mid + 1; else hi = mid;
      }
      const cand = snap[lo];
      if (!cand) return undefined;
      const prev = snap[lo - 1];
      if (prev && Math.abs(prev.time - targetSec) < Math.abs(cand.time - targetSec)) return prev;
      return cand;
    };

    const clampY = (y: number) => Math.max(0, Math.min(maxY, y));
    const positions: AiMarkerPos[] = [];

    for (const sig of aiSignalsRef.current) {
      if (!sig.barTime) continue;
      const b = nearestBar(Math.floor(new Date(sig.barTime).getTime() / 1000));
      if (!b) continue;

      const x = chart.timeScale().timeToCoordinate(b.time as Time);
      if (x === null || x < 0 || x > maxX) continue;

      const entryY = series.priceToCoordinate(sig.entryPrice);
      const slY    = series.priceToCoordinate(sig.slPrice);
      const tpY    = series.priceToCoordinate(sig.tpPrice);
      if (entryY === null || slY === null || tpY === null) continue;

      const barPriceY = sig.side === "long"
        ? series.priceToCoordinate(b.low)
        : series.priceToCoordinate(b.high);
      const labelY = barPriceY === null
        ? (sig.side === "long" ? entryY + 30 : entryY - 30)
        : (sig.side === "long" ? barPriceY + 16 : barPriceY - 16);

      positions.push({
        key:        sig.signalId,
        x,
        y:          clampY(labelY),
        entryY:     clampY(entryY),
        slY:        clampY(slY),
        tpY:        clampY(tpY),
        rightX:     maxX,
        isLong:     sig.side === "long",
        confidence: sig.confidence,
        reasoning:  sig.aiReasoning,
        marketBias: sig.aiMarketBias,
        entryPrice: sig.entryPrice,
        slPrice:    sig.slPrice,
        tpPrice:    sig.tpPrice,
        isActive:   !!activeTradeRef.current && sig.signalId === activeTradeRef.current.signalId,
      });
    }
    // Also render the latest APPROVED candle-close decision fetched from DB
    const approved = activeApprovedRef.current;
    if (approved && approved.verdict === "APPROVE" &&
        approved.entryPrice != null && approved.slPrice != null && approved.tpPrice != null) {
      const b = nearestBar(approved.candleTime);
      if (b) {
        const x = chart.timeScale().timeToCoordinate(b.time as Time);
        if (x !== null && x >= 0 && x <= maxX) {
          const entryY = series.priceToCoordinate(approved.entryPrice);
          const slY    = series.priceToCoordinate(approved.slPrice);
          const tpY    = series.priceToCoordinate(approved.tpPrice);
          if (entryY !== null && slY !== null && tpY !== null) {
            const isLong = approved.candidateSide === "long";
            const barPriceY = isLong
              ? series.priceToCoordinate(b.low)
              : series.priceToCoordinate(b.high);
            const labelY = barPriceY === null
              ? (isLong ? entryY + 30 : entryY - 30)
              : (isLong ? barPriceY + 16 : barPriceY - 16);
            const key = `approved-${approved.candleTime}`;
            if (!positions.find(p => p.key === key)) {
              positions.push({
                key,
                x,
                y:          clampY(labelY),
                entryY:     clampY(entryY),
                slY:        clampY(slY),
                tpY:        clampY(tpY),
                rightX:     maxX,
                isLong,
                confidence: approved.confidence,
                reasoning:  approved.aiReasoning,
                marketBias: typeof approved.marketBias === "string" ? approved.marketBias : undefined,
                entryPrice: approved.entryPrice,
                slPrice:    approved.slPrice,
                tpPrice:    approved.tpPrice,
                isActive:   false,
              });
            }
          }
        }
      }
    }

    setAiMarkers(positions);
  }, []);

  const computeDecisionMarkers = useCallback(() => {
    const chart  = chartRef.current;
    const series = candleRef.current;
    const el     = containerRef.current;
    if (!chart || !series || !el) return;

    const W    = el.offsetWidth;
    const H    = el.offsetHeight;
    const maxX = W - PRICE_SCALE_W;
    const maxY = H * (1 - VOLUME_RATIO);
    const snap = barsRef.current;

    const byTime = new Map<number, Bar>();
    for (const b of snap) byTime.set(b.time, b);
    const nearestBar = (targetSec: number): Bar | undefined => {
      const hit = byTime.get(targetSec);
      if (hit) return hit;
      let lo = 0, hi = snap.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (snap[mid].time < targetSec) lo = mid + 1; else hi = mid;
      }
      const cand = snap[lo];
      if (!cand) return undefined;
      const prev = snap[lo - 1];
      if (prev && Math.abs(prev.time - targetSec) < Math.abs(cand.time - targetSec)) return prev;
      return cand;
    };

    const positions: DecisionMarkerPos[] = [];
    for (const dec of aiDecisionsRef.current) {
      if (dec.verdict === "WAIT") continue;
      const b = nearestBar(dec.candleTime);
      if (!b) continue;
      const x = chart.timeScale().timeToCoordinate(b.time as Time);
      if (x === null || x < 0 || x > maxX) continue;

      const isLong  = dec.candidateSide === "long";
      const isShort = dec.candidateSide === "short";
      const priceRef = isLong ? b.low : isShort ? b.high : (b.high + b.low) / 2;
      const y = series.priceToCoordinate(priceRef);
      if (y === null || y < 0 || y > maxY) continue;

      positions.push({
        key:        `dec-${dec.candleTime}`,
        x,
        y:          isLong ? y + 12 : isShort ? y - 12 : y,
        isLong, isShort,
        verdict:    dec.verdict,
        confidence: dec.confidence,
        decision:   dec,
      });
    }
    setDecisionMarkers(positions);
  }, []);

  const computeResolvedDecisionMarkers = useCallback(() => {
    const chart  = chartRef.current;
    const series = candleRef.current;
    const el     = containerRef.current;
    if (!chart || !series || !el) return;

    const W    = el.offsetWidth;
    const H    = el.offsetHeight;
    const maxX = W - PRICE_SCALE_W;
    const maxY = H * (1 - VOLUME_RATIO);
    const snap = barsRef.current;

    const byTime = new Map<number, Bar>();
    for (const b of snap) byTime.set(b.time, b);
    const nearestBar = (targetSec: number): Bar | undefined => {
      const hit = byTime.get(targetSec);
      if (hit) return hit;
      let lo = 0, hi = snap.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (snap[mid].time < targetSec) lo = mid + 1; else hi = mid;
      }
      const cand = snap[lo];
      if (!cand) return undefined;
      const prev = snap[lo - 1];
      if (prev && Math.abs(prev.time - targetSec) < Math.abs(cand.time - targetSec)) return prev;
      return cand;
    };

    const positions: ResolvedDecisionPos[] = [];
    for (const dec of resolvedAiDecisionsRef.current) {
      const b = nearestBar(dec.candleTime);
      if (!b) continue;
      const x = chart.timeScale().timeToCoordinate(b.time as Time);
      if (x === null || x < 0 || x > maxX) continue;

      const isLong = dec.candidateSide === "long";
      const priceRef = isLong ? b.low : b.high;
      const y = series.priceToCoordinate(priceRef);
      if (y === null || y < 0 || y > maxY) continue;

      positions.push({
        key:     `rdec-${dec.candleTime}`,
        x,
        y:       isLong ? y + 5 : y - 5,
        isLong,
        outcome: dec.outcome,
      });
    }
    setResolvedDecisionMarkers(positions);
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
      // Explicit price precision — 2 decimals with 1-cent minimum movement.
      // Without this, lightweight-charts auto-detects precision and can quantize
      // tiny consolidation bars (open≈close within a few cents) into dash-like
      // artifacts.  Forcing minMove=0.01 guarantees every cent is rendered as a
      // distinct vertical step.
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
      // Ensures tiny doji-like bodies still render as a visible body rather than
      // collapsing to the wick line.  Without this lightweight-charts can draw
      // very small bodies as a single-pixel-tall rect that looks like a dash.
      borderVisible:  true,
      // Wicks always drawn even when body is tiny — prevents "horizontal stick"
      // appearance during low-volatility periods.
      wickVisible:    true,
      // Adds rendering padding around the data range so tight consolidation
      // periods get more vertical pixels instead of being compressed into a flat
      // band when zoomed out alongside wider-range bars.
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
        const res = original();
        if (!res || !res.priceRange) return res;
        const { minValue, maxValue } = res.priceRange;
        const range = maxValue - minValue;
        // Ensure a minimum visible price range so a 50-bar consolidation that
        // moves only $0.20 doesn't get rendered in 3 vertical pixels next to
        // wider bars.  Floor at 0.25% of price, or the natural range — whichever
        // is larger.
        const mid     = (minValue + maxValue) / 2;
        const minSpan = Math.max(mid * 0.0025, 0.1);
        if (range >= minSpan) return res;
        const pad = (minSpan - range) / 2;
        return {
          ...res,
          priceRange: { minValue: minValue - pad, maxValue: maxValue + pad },
        };
      },
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

    // Build the CandleStateManager and attach it to the candle series.
    // From this point on it is the SOLE writer to candle.update().
    const csm = new CandleStateManager({
      getSymbol:              () => symbolRef.current,
      getIntervalSec:         () => intervalSecRef.current,
      isMarketOpen:           () => isMarketOpenRef.current,
      getHistoryAtrRange:     () => avgBarRange(barsRef.current, 50),
      getLastHistoricalClose: () => barsRef.current[barsRef.current.length - 1]?.close ?? null,
      getLastHistoricalTime:  () => lastHistTimeRef.current,
      onCandleClose: (bar) => { try { onCandleCloseRef.current?.(bar.time); } catch {} },
    });
    csm.attachSeries(candle);
    csmRef.current = csm;

    chart.timeScale().subscribeVisibleLogicalRangeChange(computeMarkers);
    chart.timeScale().subscribeVisibleLogicalRangeChange(computeAiMarkers);
    chart.timeScale().subscribeVisibleLogicalRangeChange(computeDecisionMarkers);
    chart.timeScale().subscribeVisibleLogicalRangeChange(computeResolvedDecisionMarkers);
    const ro = new ResizeObserver(() => {
      if (!containerRef.current || !chartRef.current) return;
      chartRef.current.applyOptions({ width: containerRef.current.offsetWidth, height: containerRef.current.offsetHeight || 500 });
      computeMarkers();
      computeAiMarkers();
      computeDecisionMarkers();
      computeResolvedDecisionMarkers();
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(computeMarkers);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(computeAiMarkers);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(computeDecisionMarkers);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(computeResolvedDecisionMarkers);
      removeSLTP();
      tradeIdRef.current = null;
      csmRef.current?.detach();
      csmRef.current = null;
      chart.remove();
      chartRef.current = candleRef.current = volumeRef.current = null;
    };
  }, [computeMarkers, removeSLTP, computeDecisionMarkers, computeResolvedDecisionMarkers]);

  // Load bar data — validates every bar before rendering to prevent corrupted OHLC
  // from reaching the chart engine.  Also resets live-bar tracking so stale WebSocket
  // updates from a previous symbol/timeframe can never overwrite the new dataset.
  useEffect(() => {
    if (!candleRef.current || !chartRef.current || !bars.length) return;

    // Validate every bar before it reaches setData.  Any bar that fails OHLC integrity
    // is silently dropped — better to have a gap than a malformed spike.
    const validBars = bars.filter((b) =>
      isValidOhlc(b.open, b.high, b.low, b.close) &&
      b.time > 0 &&
      isFinite(b.volume) && b.volume >= 0
    );
    if (validBars.length === 0) return;

    // Record the last historical timestamp.  The live-tick handler uses this to
    // ensure it only updates bars that come AFTER the historical dataset ends.
    const lastHistTime = validBars[validBars.length - 1].time;
    lastHistTimeRef.current = lastHistTime;
    // Reset the CandleStateManager — new dataset, no live bar yet, telemetry cleared.
    csmRef.current?.reset();
    setTelemetry(csmRef.current?.getTelemetry() ?? null);

    candleRef.current.setData(validBars.map<CandlestickData<Time>>((b) => ({
      time: b.time as Time, open: b.open, high: b.high, low: b.low, close: b.close,
    })));
    volumeRef.current?.setData(validBars.map<HistogramData>((b) => ({
      time: b.time as Time, value: b.volume,
      color: b.close >= b.open ? "#26a69a28" : "#ef535028",
    })));
    // Default view: last 78 bars = exactly one NYSE session (9:30–16:00 = 78 × 5m bars).
    const defaultBars = 78;
    if (validBars.length > defaultBars) {
      chartRef.current.timeScale().setVisibleLogicalRange({
        from: validBars.length - defaultBars,
        to:   validBars.length + 5,
      });
    } else {
      chartRef.current.timeScale().fitContent();
    }

    setBarCount(validBars.length);
    setDateRange(
      `${new Date(validBars[0].time * 1000).toISOString().slice(0, 10)} – ${new Date(lastHistTime * 1000).toISOString().slice(0, 10)}`
    );

    removeSLTP();
    tradeIdRef.current = null;
    setTimeout(computeMarkers, 80);
    setTimeout(computeAiMarkers, 80);
    setTimeout(computeDecisionMarkers, 80);
    setTimeout(computeResolvedDecisionMarkers, 80);
  }, [bars, computeMarkers, computeAiMarkers, computeDecisionMarkers, computeResolvedDecisionMarkers, removeSLTP]);

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

    // createPriceLine gives clean labeled SL / TP / Entry levels on the price axis —
    // the professional way to display active trade levels. Axis labels show "SL", "TP",
    // and "ENTRY" with color-coded dashed horizontal lines. No fake future data needed.
    const cs = candleRef.current;
    if (!cs) return;

    slRef.current = cs.createPriceLine({
      price: activeTrade.slPrice, color: "#ef5350dd",
      lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: "⊗ SL",
    });
    tpRef.current = cs.createPriceLine({
      price: activeTrade.tpPrice, color: "#00ff88dd",
      lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: "⊕ TP",
    });
    entryLineRef.current = cs.createPriceLine({
      price: activeTrade.entryPrice,
      color: activeTrade.side === "long" ? "#22d3eedd" : "#ef5350dd",
      lineWidth: 1, lineStyle: 0, axisLabelVisible: true,
      title: activeTrade.side === "long" ? "▲ ENTRY" : "▼ ENTRY",
    });
    setTimeout(computeMarkers, 50);
  }, [activeTrade, bars, intervalSec, computeMarkers, removeSLTP]);

  // Recompute on signal/result changes
  useEffect(() => { setTimeout(computeMarkers, 30); }, [signals, tradeResult, computeMarkers]);
  useEffect(() => { setTimeout(computeAiMarkers, 30); }, [aiSignals, activeApprovedDecision, computeAiMarkers]);
  useEffect(() => { setTimeout(computeDecisionMarkers, 30); }, [aiDecisions, computeDecisionMarkers]);
  useEffect(() => { setTimeout(computeResolvedDecisionMarkers, 30); }, [resolvedAiDecisions, computeResolvedDecisionMarkers]);

  // ── Live tick ingestion ────────────────────────────────────────────────────
  //
  // The CandleStateManager owns OHLC construction, validation, the interval state
  // machine, finalization, and telemetry.  This effect's only job is to forward
  // each incoming price.update message to the manager.  Nothing else in this
  // file calls candleSeries.update() — CSM is the SOLE writer.
  useEffect(() => {
    const csm = csmRef.current;
    if (!csm || !lastPrice || !bars.length) return;
    csm.ingestTick(lastPrice.symbol, lastPrice.price, lastPrice.timestamp);

    // Throttle the telemetry React state update.  Push immediately when something
    // notable happens (a bar finalized, a new rejection), otherwise at most once
    // every TELEMETRY_THROTTLE_MS.  This keeps the chart's incremental-update path
    // hot and avoids re-rendering the SVG overlay on every accepted tick.
    const t      = csm.getTelemetry();
    const now    = performance.now();
    const notable =
      t.barsFinalized   !== telemetryLastFinal.current ||
      t.ticksRejected   !== telemetryLastRejected.current;
    if (notable || now - telemetryLastPushMs.current >= TELEMETRY_THROTTLE_MS) {
      telemetryLastPushMs.current   = now;
      telemetryLastFinal.current    = t.barsFinalized;
      telemetryLastRejected.current = t.ticksRejected;
      setTelemetry(t);
    }
  }, [lastPrice, bars.length]);

  // ── Crypto live kline (direct candleSeries.update — bypasses CandleStateManager) ──
  //
  // Binance streams full OHLCV klines rather than raw ticks, so we bypass the
  // CandleStateManager (which requires raw price ticks and filters by market hours).
  // This effect is the ONLY caller of candleSeries.update() for crypto mode.
  // It fires on every kline message (every 1-2 seconds during active trading).
  useEffect(() => {
    const cs = candleRef.current;
    if (!cs || !cryptoLiveBar || !bars.length) return;
    try {
      cs.update({
        time:  cryptoLiveBar.time as import("lightweight-charts").Time,
        open:  cryptoLiveBar.open,
        high:  cryptoLiveBar.high,
        low:   cryptoLiveBar.low,
        close: cryptoLiveBar.close,
      });
    } catch { /* chart series may be disposing */ }
  }, [cryptoLiveBar, bars.length]);

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
        {telemetry && telemetry.ticksAccepted + telemetry.ticksRejected > 0 && (
          <span
            className="text-[10px] text-muted-foreground/60 font-mono hidden lg:inline"
            title={
              `Accepted: ${telemetry.ticksAccepted}\n` +
              `Rejected: ${telemetry.ticksRejected}\n` +
              `Finalized bars: ${telemetry.barsFinalized}\n` +
              Object.entries(telemetry.rejectedByReason)
                .map(([k, v]) => `  ${k}: ${v}`).join("\n")
            }
          >
            <span className="text-emerald-500/70">✓{telemetry.ticksAccepted}</span>
            {telemetry.ticksRejected > 0 && (
              <span className="text-amber-500/70 ml-2">⚠{telemetry.ticksRejected}</span>
            )}
            <span className="text-muted-foreground/40 ml-2">·{telemetry.barsFinalized}f</span>
          </span>
        )}
        {aiAnalyzing && (
          <span className="text-[10px] text-violet-400/80 font-mono tracking-widest animate-pulse">
            AI…
          </span>
        )}
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

      {/* Chart + SVG overlay */}
      <div className="flex-1 min-h-0 relative overflow-hidden">
        <div ref={containerRef} className="absolute inset-0" />

        <svg
          className="absolute inset-0 w-full h-full pointer-events-none"
          style={{ zIndex: 10, overflow: "hidden" }}
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <style>{`@keyframes tradeRingPulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 0.05; } }`}</style>
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
            {/* AI Decision Engine — stronger glow filters */}
            <filter id="aiGlowLong" x="-120%" y="-120%" width="340%" height="340%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="5" result="b"/>
              <feColorMatrix in="b" type="matrix" values="0 0 0 0 0  0 0 0 0 1  0 0 0 0 0.53  0 0 0 1 0" result="cb"/>
              <feMerge><feMergeNode in="cb"/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>
            <filter id="aiGlowShort" x="-120%" y="-120%" width="340%" height="340%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="5" result="b"/>
              <feColorMatrix in="b" type="matrix" values="0 0 0 0 1  0 0 0 0 0.2  0 0 0 0 0.27  0 0 0 1 0" result="cb"/>
              <feMerge><feMergeNode in="cb"/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>
          </defs>

          {/* ── AI Decision Engine layer ──────────────────────────────────────
               R/R boxes, Entry/SL/TP price levels, and diamond markers.
               Rendered BEFORE rule-based markers so diamonds sit on top. */}
          {aiMarkers.map((m) => {
            const G = "#00ff88";
            const R = "#ff3346";
            const col = m.isLong ? G : R;

            const profitTop    = Math.min(m.entryY, m.tpY);
            const profitHeight = Math.max(1, Math.abs(m.tpY - m.entryY));
            const lossTop      = Math.min(m.slY, m.entryY);
            const lossHeight   = Math.max(1, Math.abs(m.entryY - m.slY));
            const boxX = Math.max(0, m.x - 3);
            const boxW = Math.max(0, m.rightX - boxX);

            const dHW = 9; const dHH = 13;
            const diamondPts = [
              `${m.x},${m.y - dHH}`,
              `${m.x + dHW},${m.y}`,
              `${m.x},${m.y + dHH}`,
              `${m.x - dHW},${m.y}`,
            ].join(" ");

            return (
              <g key={`ai-svg-${m.key}`}>
                {/* Profit zone fill — always green (price moves toward TP, above for SHORT below for LONG) */}
                <rect x={boxX} y={profitTop} width={boxW} height={profitHeight}
                  fill="#00ff8808" />
                <rect x={boxX} y={profitTop} width={boxW} height={profitHeight}
                  fill="none" stroke="#00ff8820" strokeWidth={0.8} />
                {/* Loss zone fill — always red (price moves toward SL, below for SHORT above for LONG) */}
                <rect x={boxX} y={lossTop} width={boxW} height={lossHeight}
                  fill="#ff334608" />
                <rect x={boxX} y={lossTop} width={boxW} height={lossHeight}
                  fill="none" stroke="#ff334620" strokeWidth={0.8} />
                {/* TP line */}
                <line x1={boxX} y1={m.tpY} x2={m.rightX} y2={m.tpY}
                  stroke={G} strokeWidth={1} strokeDasharray="6 4" opacity={0.65} />
                <text x={m.rightX - 4} y={m.tpY - 3} textAnchor="end"
                  fill={G} fontSize={8} fontFamily="'JetBrains Mono',Menlo,monospace" opacity={0.8}>
                  TP {m.tpPrice.toFixed(2)}
                </text>
                {/* Entry line */}
                <line x1={boxX} y1={m.entryY} x2={m.rightX} y2={m.entryY}
                  stroke={col} strokeWidth={1} strokeDasharray="3 3" opacity={0.7} />
                <text x={m.rightX - 4} y={m.entryY - 3} textAnchor="end"
                  fill={col} fontSize={8} fontFamily="'JetBrains Mono',Menlo,monospace" opacity={0.7}>
                  E {m.entryPrice.toFixed(2)}
                </text>
                {/* SL line */}
                <line x1={boxX} y1={m.slY} x2={m.rightX} y2={m.slY}
                  stroke={R} strokeWidth={1} strokeDasharray="6 4" opacity={0.65} />
                <text x={m.rightX - 4} y={m.slY + 10} textAnchor="end"
                  fill={R} fontSize={8} fontFamily="'JetBrains Mono',Menlo,monospace" opacity={0.8}>
                  SL {m.slPrice.toFixed(2)}
                </text>
                {/* Diamond marker */}
                <polygon points={diamondPts}
                  fill={col} opacity={0.92}
                  stroke={col} strokeWidth={0.8}
                  filter={m.isLong ? "url(#aiGlowLong)" : "url(#aiGlowShort)"} />
                {/* "AI" badge in diamond */}
                <text x={m.x} y={m.y + 1} textAnchor="middle" dominantBaseline="middle"
                  fill="#000" fontSize={6.5} fontWeight="900"
                  fontFamily="'JetBrains Mono',Menlo,monospace">
                  AI
                </text>
              </g>
            );
          })}

          {/* Active trade lifecycle zone: translucent band between TP and SL from entry → now */}
          {activeZone && (
            <rect
              x={activeZone.x - 4}
              y={activeZone.tpY}
              width={Math.max(0, activeZone.rightX - activeZone.x + 4)}
              height={Math.max(0, activeZone.slY - activeZone.tpY)}
              fill={activeZone.isLong ? "#22d3ee0b" : "#ef53500b"}
              stroke={activeZone.isLong ? "#22d3ee22" : "#ef535022"}
              strokeWidth={1} strokeDasharray="6 3" rx={3}
            />
          )}
          {/* Signal entry markers.
               Active trade: glowing ring + large arrow + side label.
               Historical: small outcome-colored triangle (TP=green, SL/Expired=red). */}
          {markers.map((m) => {
            if (m.isActive) {
              // ── Active trade: full glowing style ─────────────────────────
              const col  = m.isLong ? "#22d3ee" : "#ef5350";
              const flt  = m.isLong ? "url(#gGreen)" : "url(#gRed)";
              const mW   = 16;
              const mH   = 26;
              const pts  = m.isLong
                ? `${m.x},${m.y - mH} ${m.x - mW},${m.y + 2} ${m.x + mW},${m.y + 2}`
                : `${m.x},${m.y + mH} ${m.x - mW},${m.y - 2} ${m.x + mW},${m.y - 2}`;
              const y0   = m.isLong ? m.y + mH + 11        : m.y - mH - 5;
              const y1   = m.isLong ? m.y + mH + 11 + 10   : m.y - mH - 5 - 10;
              return (
                <g key={m.key}>
                  <circle cx={m.x} cy={m.y} r={22} fill="none" stroke={col} strokeWidth={1.5}
                    style={{ animation: "tradeRingPulse 2s ease-in-out infinite" }} />
                  <circle cx={m.x} cy={m.y} r={30} fill="none" stroke={col} strokeWidth={0.8}
                    style={{ animation: "tradeRingPulse 2s ease-in-out infinite 0.7s" }} />
                  <polygon points={pts} fill={col} opacity={1} stroke={col} strokeWidth={1.2} filter={flt} />
                  <text x={m.x} y={y0} textAnchor="middle" fill={col}
                    fontSize={10} fontFamily="'JetBrains Mono',Menlo,monospace" fontWeight="800" opacity={0.95}>
                    {m.isLong ? "BUY" : "SELL"}
                  </text>
                  <text x={m.x} y={y1} textAnchor="middle" fill={col}
                    fontSize={9} fontFamily="'JetBrains Mono',Menlo,monospace" fontWeight="600" opacity={0.85}>
                    {m.confidence}%
                  </text>
                </g>
              );
            }

            // ── Historical signal: compact outcome-colored triangle ────────
            const outcomeCol =
              m.outcome === "tp_hit"                    ? "#22c55e" :
              m.outcome === "sl_hit" || m.outcome === "expired" ? "#ef5350" :
              "#6b7280"; // pending / unknown
            const mW = 5;
            const mH = 8;
            const pts = m.isLong
              ? `${m.x},${m.y - mH} ${m.x - mW},${m.y + 2} ${m.x + mW},${m.y + 2}`
              : `${m.x},${m.y + mH} ${m.x - mW},${m.y - 2} ${m.x + mW},${m.y - 2}`;
            return (
              <g key={m.key}>
                <polygon points={pts} fill={outcomeCol} opacity={0.75}
                  stroke={outcomeCol} strokeWidth={0.5} />
              </g>
            );
          })}

          {/* ── Resolved AI decision outcome markers ──────────────────────
               Compact triangles at each resolved APPROVED AI decision bar.
               Green = tp_hit, Red = sl_hit, Gray = expired.
               Uses the same compact style as historical signal markers but
               with a small "●" dot inside to distinguish them from signals. */}
          {resolvedDecisionMarkers.map((m) => {
            const col =
              m.outcome === "tp_hit"  ? "#22c55e" :
              m.outcome === "sl_hit"  ? "#ef5350" :
              "#6b7280";
            const mW = 5;
            const mH = 8;
            const pts = m.isLong
              ? `${m.x},${m.y - mH} ${m.x - mW},${m.y + 2} ${m.x + mW},${m.y + 2}`
              : `${m.x},${m.y + mH} ${m.x - mW},${m.y - 2} ${m.x + mW},${m.y - 2}`;
            return (
              <g key={m.key}>
                <polygon points={pts} fill={col} opacity={0.85}
                  stroke={col} strokeWidth={0.8} />
                <circle cx={m.x} cy={m.isLong ? m.y - 3 : m.y + 3}
                  r={1.5} fill="#000" opacity={0.6} />
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

        {/* ── AI signal interactive labels ──────────────────────────────────
             Separate div layer (pointer-events-auto) on top of SVG so hover
             works. Each label is absolutely positioned from the same (x,y)
             computed by computeAiMarkers. */}
        {aiMarkers.map((m) => {
          const col = m.isLong ? "#00ff88" : "#ff3346";
          const isHov = hoveredAiKey === m.key;
          const labelTopPx = m.isLong ? m.y + 14 : m.y - 50;
          const rightSide  = m.x > 500;

          return (
            <div
              key={`ai-lbl-${m.key}`}
              style={{
                position: "absolute",
                left:         m.x - 39,
                top:          labelTopPx,
                zIndex:       20,
                pointerEvents:"auto",
                cursor:       "default",
                userSelect:   "none",
              }}
              onMouseEnter={() => setHoveredAiKey(m.key)}
              onMouseLeave={() => setHoveredAiKey(null)}
            >
              {/* Label pill */}
              <div style={{
                background:     `linear-gradient(135deg, ${col}1a, ${col}08)`,
                border:         `1px solid ${col}55`,
                borderRadius:   4,
                padding:        "2px 7px",
                minWidth:       78,
                textAlign:      "center",
                backdropFilter: "blur(4px)",
                boxShadow:      `0 0 14px ${col}28`,
              }}>
                <div style={{
                  fontFamily:  "'JetBrains Mono', Menlo, monospace",
                  fontSize:    10,
                  fontWeight:  800,
                  color:       col,
                  letterSpacing:"0.06em",
                  lineHeight:  1.3,
                  textShadow:  `0 0 9px ${col}80`,
                }}>
                  {m.isLong ? "AI LONG" : "AI SHORT"}
                </div>
                <div style={{
                  fontFamily: "'JetBrains Mono', Menlo, monospace",
                  fontSize:   9,
                  fontWeight: 700,
                  color: m.confidence >= 80
                    ? "#00ff88"
                    : m.confidence >= 70
                    ? "#f59e0b"
                    : "#ff3346",
                  lineHeight: 1.2,
                }}>
                  {m.confidence}%
                </div>
              </div>

              {/* Hover tooltip */}
              {isHov && (
                <div style={{
                  position:      "absolute",
                  [rightSide ? "right" : "left"]: 0,
                  top:           m.isLong ? "100%" : "auto",
                  bottom:        m.isLong ? "auto" : "100%",
                  marginTop:     m.isLong ? 5 : 0,
                  marginBottom:  m.isLong ? 0 : 5,
                  zIndex:        30,
                  background:    "#0c0f16f4",
                  border:        `1px solid ${col}35`,
                  borderRadius:  7,
                  padding:       "9px 11px",
                  width:         230,
                  boxShadow:     `0 6px 28px #00000090, 0 0 18px ${col}18`,
                  backdropFilter:"blur(10px)",
                  fontFamily:    "'JetBrains Mono', Menlo, monospace",
                }}>
                  {/* Header */}
                  <div style={{ display:"flex", justifyContent:"space-between", marginBottom:7, alignItems:"center" }}>
                    <span style={{ fontSize:10, fontWeight:800, color:col, textShadow:`0 0 8px ${col}60` }}>
                      {m.isLong ? "▲ AI LONG" : "▼ AI SHORT"}
                    </span>
                    <span style={{ fontSize:9, color:"#6b7280" }}>{m.confidence}% conf</span>
                  </div>
                  {/* Market bias */}
                  {m.marketBias && (
                    <div style={{ fontSize:9, color:"#9ca3af", marginBottom:5 }}>
                      Bias: <span style={{ color:"#d1d5db", fontWeight:600 }}>{m.marketBias}</span>
                    </div>
                  )}
                  {/* Trade levels grid */}
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:4, marginBottom:7 }}>
                    {([ ["Entry", m.entryPrice.toFixed(2), "#e5e7eb"],
                        ["SL",    m.slPrice.toFixed(2),    "#ff3346"],
                        ["TP",    m.tpPrice.toFixed(2),    "#00ff88"] ] as const
                    ).map(([lbl, val, clr]) => (
                      <div key={lbl} style={{
                        textAlign:"center",
                        background:"#ffffff08",
                        borderRadius:3,
                        padding:"2px 0",
                      }}>
                        <div style={{ fontSize:7, color:"#6b7280", textTransform:"uppercase", letterSpacing:"0.05em" }}>{lbl}</div>
                        <div style={{ fontSize:9, fontWeight:700, color:clr }}>{val}</div>
                      </div>
                    ))}
                  </div>
                  {/* Reasoning */}
                  {m.reasoning && (
                    <div style={{
                      fontSize:    9,
                      color:       "#9ca3af",
                      lineHeight:  1.55,
                      borderTop:   "1px solid #ffffff10",
                      paddingTop:  7,
                    }}>
                      {m.reasoning.length > 180
                        ? m.reasoning.slice(0, 180) + "…"
                        : m.reasoning}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* ── AI candle-close decision marker badges ──────────────────────
             Small pill labels (APPROVE ▲/▼, WAIT –, REJECT ×) rendered as
             absolutely-positioned divs on top of the SVG so they get
             pointer-events and can open the detail popup on click. */}
        {decisionMarkers.map((m) => {
          const G = "#00ff88"; const R = "#ff3346"; const W = "#6b7280";
          const isApprove = m.verdict === "APPROVE";
          const col = !isApprove ? W : m.isLong ? G : R;
          const glyph = m.verdict === "APPROVE"
            ? (m.isLong ? "▲" : "▼")
            : m.verdict === "WAIT" ? "–" : "×";
          // Small pill offset slightly outside the bar
          const topPx = m.isLong ? m.y + 2 : m.y - 20;

          return (
            <div
              key={`cdec-${m.key}`}
              onClick={() => setSelectedDecision(prev => prev?.candleTime === m.decision.candleTime ? null : m.decision)}
              style={{
                position:      "absolute",
                left:          m.x - 13,
                top:           topPx,
                zIndex:        22,
                pointerEvents: "auto",
                cursor:        "pointer",
                userSelect:    "none",
                display:       "flex",
                alignItems:    "center",
                gap:           3,
                background:    `${col}18`,
                border:        `1px solid ${col}50`,
                borderRadius:  3,
                padding:       "1px 4px",
                backdropFilter:"blur(4px)",
              }}
            >
              <span style={{
                fontFamily:  "'JetBrains Mono', Menlo, monospace",
                fontSize:    9,
                fontWeight:  900,
                color:       col,
                lineHeight:  1,
              }}>{glyph}</span>
              <span style={{
                fontFamily:  "'JetBrains Mono', Menlo, monospace",
                fontSize:    8,
                fontWeight:  700,
                color:       col,
                opacity:     0.85,
                lineHeight:  1,
              }}>AI</span>
            </div>
          );
        })}

        {/* ── AI candle-close decision detail popup ───────────────────────
             Shown when a decision badge is clicked. Dismissed by clicking
             the badge again or the × button. */}
        {selectedDecision && (() => {
          const dec = selectedDecision;
          const isApprove = dec.verdict === "APPROVE";
          const isLong    = dec.candidateSide === "long";
          const G = "#00ff88"; const R = "#ff3346"; const A = "#f59e0b"; const GR = "#6b7280";
          const vCol  = isApprove ? (isLong ? G : R) : dec.verdict === "WAIT" ? A : GR;
          const vIcon = isApprove ? (isLong ? "▲" : "▼") : dec.verdict === "WAIT" ? "⏳" : "✗";
          const sentCol = dec.newsSentiment === "bullish" ? G : dec.newsSentiment === "bearish" ? R : A;

          return (
            <div
              style={{
                position:      "absolute",
                top:           "50%",
                left:          "50%",
                transform:     "translate(-50%, -50%)",
                zIndex:        50,
                background:    "#0b0e14f8",
                border:        `1px solid ${vCol}35`,
                borderRadius:  10,
                padding:       "14px 16px",
                width:         310,
                maxHeight:     "82%",
                overflowY:     "auto",
                boxShadow:     `0 16px 56px #00000095, 0 0 24px ${vCol}18`,
                backdropFilter:"blur(14px)",
                fontFamily:    "'JetBrains Mono', Menlo, monospace",
              }}
            >
              {/* Header */}
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
                <div style={{ display:"flex", alignItems:"center", gap:7 }}>
                  <span style={{
                    fontSize:9, fontWeight:900, color:vCol,
                    background:`${vCol}18`, border:`1px solid ${vCol}50`,
                    borderRadius:4, padding:"2px 7px",
                  }}>
                    {vIcon} {dec.verdict}
                  </span>
                  {isApprove && (
                    <span style={{ fontSize:9, fontWeight:700, color:vCol }}>
                      {isLong ? "LONG" : "SHORT"}
                    </span>
                  )}
                  <span style={{ fontSize:8, color:"#4b5563" }}>
                    {new Date(dec.candleTime * 1000).toLocaleTimeString()}
                  </span>
                </div>
                <button
                  onClick={() => setSelectedDecision(null)}
                  style={{ background:"none", border:"none", cursor:"pointer", color:"#6b7280", fontSize:13, lineHeight:1, padding:2 }}
                >×</button>
              </div>

              {/* Confidence bar */}
              <div style={{ marginBottom:10 }}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:3 }}>
                  <span style={{ fontSize:8, color:"#6b7280", textTransform:"uppercase", letterSpacing:"0.05em" }}>Confidence</span>
                  <span style={{ fontSize:9, fontWeight:700, color: dec.confidence >= 80 ? G : dec.confidence >= 65 ? A : GR }}>
                    {dec.confidence}%
                  </span>
                </div>
                <div style={{ height:3, background:"#1f2937", borderRadius:2 }}>
                  <div style={{ height:3, borderRadius:2, width:`${dec.confidence}%`, background: dec.confidence >= 80 ? G : dec.confidence >= 65 ? A : GR, transition:"width 0.3s" }} />
                </div>
              </div>

              {/* Levels grid */}
              {isApprove && (dec.entryPrice !== null || dec.slPrice !== null || dec.tpPrice !== null) && (
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:4, marginBottom:10 }}>
                  {([
                    ["Entry", dec.entryPrice?.toFixed(2) ?? "—", "#e5e7eb"],
                    ["SL",    dec.slPrice?.toFixed(2)    ?? "—", R],
                    ["TP",    dec.tpPrice?.toFixed(2)    ?? "—", G],
                    ["R:R",   dec.rrRatio?.toFixed(2)    ?? "—", "#60a5fa"],
                  ] as const).map(([lbl, val, clr]) => (
                    <div key={lbl} style={{ textAlign:"center", background:"#ffffff08", borderRadius:4, padding:"4px 0" }}>
                      <div style={{ fontSize:7, color:"#6b7280", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:2 }}>{lbl}</div>
                      <div style={{ fontSize:9, fontWeight:700, color:clr }}>{val}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Context row */}
              <div style={{ display:"flex", gap:6, marginBottom:9, flexWrap:"wrap" }}>
                {[
                  dec.regime   && { label:"Regime",  val: dec.regime },
                  dec.htfBias  && { label:"HTF",     val: dec.htfBias },
                  dec.session  && { label:"Session",  val: dec.session },
                ].filter(Boolean).map((item) => item && (
                  <span key={item.label} style={{ fontSize:8, color:"#9ca3af", background:"#ffffff08", borderRadius:3, padding:"2px 6px" }}>
                    <span style={{ color:"#4b5563" }}>{item.label}: </span>{item.val}
                  </span>
                ))}
              </div>

              {/* Market Bias */}
              {dec.marketBias && (
                <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:8 }}>
                  <span style={{ fontSize:8, color:"#6b7280", textTransform:"uppercase", letterSpacing:"0.05em" }}>Market Bias:</span>
                  <span style={{
                    fontSize:9, fontWeight:700,
                    color: dec.marketBias === "bullish" ? G : dec.marketBias === "bearish" ? R : A,
                  }}>{dec.marketBias.toUpperCase()}</span>
                </div>
              )}

              {/* Strengths */}
              {(dec.strengths?.length ?? 0) > 0 && (
                <div style={{ marginBottom:7, background:"#00ff8806", borderRadius:4, padding:"6px 8px", border:"1px solid #00ff8818" }}>
                  <div style={{ fontSize:7, color:"#00ff88", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:4 }}>Strengths</div>
                  {dec.strengths.map((s, i) => (
                    <div key={i} style={{ fontSize:8, color:"#9ca3af", lineHeight:1.5 }}>+ {s}</div>
                  ))}
                </div>
              )}

              {/* Weaknesses */}
              {(dec.weaknesses?.length ?? 0) > 0 && (
                <div style={{ marginBottom:7, background:"#ff333608", borderRadius:4, padding:"6px 8px", border:"1px solid #ff333620" }}>
                  <div style={{ fontSize:7, color:"#ff3346", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:4 }}>Weaknesses</div>
                  {dec.weaknesses.map((w, i) => (
                    <div key={i} style={{ fontSize:8, color:"#9ca3af", lineHeight:1.5 }}>− {w}</div>
                  ))}
                </div>
              )}

              {/* Patterns */}
              {dec.patterns?.length > 0 && (
                <div style={{ display:"flex", gap:4, flexWrap:"wrap", marginBottom:9 }}>
                  {dec.patterns.map((p) => (
                    <span key={p} style={{ fontSize:8, color:"#60a5fa", background:"#60a5fa18", border:"1px solid #60a5fa30", borderRadius:3, padding:"1px 5px" }}>{p}</span>
                  ))}
                </div>
              )}

              {/* News */}
              {dec.newsSummary && (
                <div style={{ marginBottom:9, background:"#ffffff05", borderRadius:5, padding:"7px 9px" }}>
                  <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                    <span style={{ fontSize:8, color:"#6b7280", textTransform:"uppercase", letterSpacing:"0.05em" }}>News</span>
                    <span style={{ fontSize:8, fontWeight:700, color:sentCol }}>{dec.newsSentiment}</span>
                  </div>
                  <div style={{ fontSize:8, color:"#9ca3af", lineHeight:1.5 }}>
                    {dec.newsSummary.length > 160 ? dec.newsSummary.slice(0, 160) + "…" : dec.newsSummary}
                  </div>
                </div>
              )}

              {/* AI Reasoning */}
              <div style={{ borderTop:"1px solid #1f2937", paddingTop:9 }}>
                <div style={{ fontSize:8, color:"#6b7280", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:5 }}>AI Reasoning</div>
                <div style={{ fontSize:8.5, color:"#d1d5db", lineHeight:1.6 }}>
                  {dec.aiReasoning || dec.rejectionReason || "—"}
                </div>
              </div>
            </div>
          );
        })()}

        {/* Legend overlay — top-left of chart canvas */}
        <div
          style={{
            position:      "absolute",
            top:           8,
            left:          8,
            zIndex:        15,
            background:    "#0b0e14cc",
            border:        "1px solid #ffffff0e",
            borderRadius:  5,
            padding:       "4px 9px",
            backdropFilter:"blur(6px)",
            pointerEvents: "none",
          }}
        >
          <div style={{
            fontFamily:"'JetBrains Mono', Menlo, monospace",
            fontSize:   9,
            lineHeight: 1.8,
          }}>
            <div style={{ color:"#60a5fa" }}>▲ Signal History</div>
            <div style={{ color:"#a78bfa" }}>🧠 AI Decisions</div>
          </div>
        </div>
      </div>
    </div>
  );
}
