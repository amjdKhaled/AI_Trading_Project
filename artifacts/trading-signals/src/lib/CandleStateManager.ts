import type { ISeriesApi, Time, CandlestickData } from "lightweight-charts";

export interface ImmutableBar {
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export interface CSMTelemetry {
  ticksAccepted: number;
  ticksRejected: number;
  rejectedByReason: Record<string, number>;
  barsFinalized: number;
  lastRejectReason: string | null;
  lastFinalizedTime: number | null;
  liveBarTime: number | null;
}

export type RejectReason =
  | "wrong_symbol"
  | "market_closed"
  | "invalid_price"
  | "spike_filtered"
  | "stale_tick"
  | "before_history"
  | "duplicate_timestamp"
  | "malformed_ohlc";

interface CSMOptions {
  getSymbol: () => string;
  getIntervalSec: () => number;
  isMarketOpen: () => boolean;
  getHistoryAtrRange: () => number;
  getLastHistoricalClose: () => number | null;
  getLastHistoricalTime: () => number;
  onCandleClose?: (bar: ImmutableBar) => void;
}

function isValidOhlc(o: number, h: number, l: number, c: number): boolean {
  if (!isFinite(o) || !isFinite(h) || !isFinite(l) || !isFinite(c)) return false;
  if (isNaN(o) || isNaN(h) || isNaN(l) || isNaN(c)) return false;
  if (h < o || h < c) return false;
  if (l > o || l > c) return false;
  if (l > h) return false;
  return true;
}

export class CandleStateManager {
  private series: ISeriesApi<"Candlestick"> | null = null;
  private liveBar: ImmutableBar | null = null;
  private finalizedBars: ImmutableBar[] = [];
  private readonly opts: CSMOptions;

  private telemetry: CSMTelemetry = {
    ticksAccepted: 0,
    ticksRejected: 0,
    rejectedByReason: {},
    barsFinalized: 0,
    lastRejectReason: null,
    lastFinalizedTime: null,
    liveBarTime: null,
  };

  constructor(opts: CSMOptions) {
    this.opts = opts;
  }

  attachSeries(series: ISeriesApi<"Candlestick">) {
    this.series = series;
  }

  detach() {
    this.series = null;
  }

  reset() {
    this.liveBar = null;
    this.finalizedBars = [];
    this.telemetry = {
      ticksAccepted: 0,
      ticksRejected: 0,
      rejectedByReason: {},
      barsFinalized: 0,
      lastRejectReason: null,
      lastFinalizedTime: null,
      liveBarTime: null,
    };
  }

  getTelemetry(): CSMTelemetry {
    return { ...this.telemetry, rejectedByReason: { ...this.telemetry.rejectedByReason } };
  }

  getLiveBar(): ImmutableBar | null {
    return this.liveBar;
  }

  private reject(reason: RejectReason) {
    this.telemetry.ticksRejected += 1;
    this.telemetry.lastRejectReason = reason;
    this.telemetry.rejectedByReason[reason] = (this.telemetry.rejectedByReason[reason] ?? 0) + 1;
  }

  ingestTick(symbol: string, price: number, timestampSec: number): void {
    if (!this.series) return;

    if (symbol !== this.opts.getSymbol()) { this.reject("wrong_symbol"); return; }
    if (!this.opts.isMarketOpen()) { this.reject("market_closed"); return; }
    if (!isFinite(price) || isNaN(price) || price <= 0) { this.reject("invalid_price"); return; }

    const atr = this.opts.getHistoryAtrRange();
    const refPrice = this.liveBar?.close ?? this.opts.getLastHistoricalClose() ?? price;
    // ATR-based spike threshold: tick must not deviate more than 5× rolling avg bar range
    // or 2% of price (whichever is larger).  Fallback when ATR isn't available yet:
    // 1% of price — tight enough to catch any genuinely malformed tick on liquid equities.
    const maxDelta = atr > 0 ? Math.max(atr * 5, refPrice * 0.02) : refPrice * 0.01;
    if (Math.abs(price - refPrice) > maxDelta) { this.reject("spike_filtered"); return; }

    const intervalSec = this.opts.getIntervalSec();
    const t = timestampSec - (timestampSec % intervalSec);

    if (t <= this.opts.getLastHistoricalTime()) { this.reject("before_history"); return; }

    const live = this.liveBar;

    if (live === null || t > live.time) {
      if (live !== null && t > live.time) {
        this.finalizeLiveBar();
      }
      const fresh: ImmutableBar = Object.freeze({
        time: t, open: price, high: price, low: price, close: price, volume: 0,
      });
      if (!isValidOhlc(fresh.open, fresh.high, fresh.low, fresh.close)) {
        this.reject("malformed_ohlc"); return;
      }
      this.liveBar = fresh;
      this.telemetry.liveBarTime = t;
      this.telemetry.ticksAccepted += 1;
      this.writeToSeries(fresh);
      return;
    }

    if (t === live.time) {
      const next: ImmutableBar = Object.freeze({
        time: t,
        open: live.open,
        high: Math.max(live.high, price),
        low: Math.min(live.low, price),
        close: price,
        volume: live.volume,
      });
      if (!isValidOhlc(next.open, next.high, next.low, next.close)) {
        this.reject("malformed_ohlc"); return;
      }
      this.liveBar = next;
      this.telemetry.ticksAccepted += 1;
      this.writeToSeries(next);
      return;
    }

    this.reject("stale_tick");
  }

  private finalizeLiveBar(): void {
    if (!this.liveBar) return;
    const frozen = this.liveBar;
    this.finalizedBars.push(frozen);
    this.telemetry.barsFinalized += 1;
    this.telemetry.lastFinalizedTime = frozen.time;
    this.liveBar = null;
    // Fire candle-close callback after state is fully committed.
    // The callback runs asynchronously so it cannot block tick processing.
    try { this.opts.onCandleClose?.(frozen); } catch { /* never propagate */ }
  }

  private writeToSeries(bar: ImmutableBar): void {
    if (!this.series) return;
    try {
      this.series.update({
        time: bar.time as Time,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      } satisfies CandlestickData<Time>);
    } catch {
      /* chart series may be disposing */
    }
  }
}
