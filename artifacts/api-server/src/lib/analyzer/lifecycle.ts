// ============================================================
// Trade Lifecycle Simulator
// ============================================================
// Walks forward from a signal's entry bar and determines whether the
// trade hit TP, hit SL, or expired without resolution.
//
// Conventions:
//  • Entry bar is the bar AT which the signal fires; the simulator starts
//    on the NEXT bar (no same-bar fills).
//  • If a single bar's H/L touches both SL and TP, we conservatively
//    record SL hit (worst-case for the trader; matches institutional
//    backtest convention when intra-bar ordering is unknown).
//  • Expiry cap: 50 bars after entry. On 5m bars that's ~4 hours; on
//    15m that's ~12 hours — long enough for any quality intraday setup
//    to resolve.
// ============================================================

import type { OhlcvBar, Side } from "./types";

export type LifecycleOutcome = "tp_hit" | "sl_hit" | "expired" | "active";

export interface LifecycleResult {
  state:        LifecycleOutcome;
  exitPrice:    number | null;
  exitBarTime:  number | null;   // unix seconds
  exitReason:   string | null;
  barsHeld:     number;
}

const MAX_HOLD_BARS = 50;

export function simulateLifecycle(
  bars: OhlcvBar[],
  entryBarIndex: number,
  side: Side,
  entryPrice: number,
  slPrice: number,
  tpPrice: number,
): LifecycleResult {
  const start = entryBarIndex + 1;
  const end   = Math.min(bars.length, start + MAX_HOLD_BARS);

  for (let i = start; i < end; i++) {
    const b = bars[i];
    if (side === "long") {
      const slHit = b.low  <= slPrice;
      const tpHit = b.high >= tpPrice;
      if (slHit && tpHit) {
        return {
          state: "sl_hit", exitPrice: slPrice, exitBarTime: b.time,
          exitReason: "SL hit (ambiguous bar)", barsHeld: i - entryBarIndex,
        };
      }
      if (slHit) return { state: "sl_hit", exitPrice: slPrice, exitBarTime: b.time, exitReason: "SL triggered", barsHeld: i - entryBarIndex };
      if (tpHit) return { state: "tp_hit", exitPrice: tpPrice, exitBarTime: b.time, exitReason: "TP reached",   barsHeld: i - entryBarIndex };
    } else {
      const slHit = b.high >= slPrice;
      const tpHit = b.low  <= tpPrice;
      if (slHit && tpHit) {
        return {
          state: "sl_hit", exitPrice: slPrice, exitBarTime: b.time,
          exitReason: "SL hit (ambiguous bar)", barsHeld: i - entryBarIndex,
        };
      }
      if (slHit) return { state: "sl_hit", exitPrice: slPrice, exitBarTime: b.time, exitReason: "SL triggered", barsHeld: i - entryBarIndex };
      if (tpHit) return { state: "tp_hit", exitPrice: tpPrice, exitBarTime: b.time, exitReason: "TP reached",   barsHeld: i - entryBarIndex };
    }
  }

  // No resolution within MAX_HOLD_BARS — mark as expired at last evaluated bar
  const lastIdx = Math.min(end - 1, bars.length - 1);
  if (lastIdx <= entryBarIndex) {
    // Edge case: signal was on the final bar — keep it active for live tracking
    return { state: "active", exitPrice: null, exitBarTime: null, exitReason: null, barsHeld: 0 };
  }
  const lastBar = bars[lastIdx];
  // Mark unresolved historical trades as expired with last-known close as exit price.
  // Only the most-recent ~MAX_HOLD_BARS of the chart remain "active" so live
  // tracking can take over for ongoing setups.
  const isRecent = bars.length - 1 - entryBarIndex <= MAX_HOLD_BARS;
  if (isRecent) {
    return { state: "active", exitPrice: null, exitBarTime: null, exitReason: null, barsHeld: lastIdx - entryBarIndex };
  }
  return {
    state: "expired",
    exitPrice: lastBar.close,
    exitBarTime: lastBar.time,
    exitReason: `Expired after ${MAX_HOLD_BARS} bars`,
    barsHeld: lastIdx - entryBarIndex,
  };
}
