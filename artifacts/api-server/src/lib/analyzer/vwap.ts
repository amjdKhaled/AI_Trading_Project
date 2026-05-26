// ============================================================
// VWAP Engine — Session-Anchored Volume-Weighted Average Price
// ============================================================
// Anchored per RTH session (09:30 ET reset). Returns a per-bar vwap[]
// aligned to the input bar array, plus convenience flags for the most
// recent bar's relationship to VWAP. Each new ET trading day resets the
// running cum(price*vol)/cum(vol) accumulators.
// ============================================================

import type { OhlcvBar } from "./types";

const ET_DATE_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year:     "numeric",
  month:    "2-digit",
  day:      "2-digit",
});

function etDateKey(epochSec: number): string {
  // "MM/DD/YYYY" — unique per ET calendar day, DST-safe via Intl.
  const parts = ET_DATE_FMT.formatToParts(new Date(epochSec * 1000));
  const m = parts.find((p) => p.type === "month")?.value ?? "";
  const d = parts.find((p) => p.type === "day")?.value ?? "";
  const y = parts.find((p) => p.type === "year")?.value ?? "";
  return `${y}-${m}-${d}`;
}

/**
 * Compute per-bar session-anchored VWAP.
 * VWAP for bar i = sum(typicalPrice * volume) / sum(volume) over all bars in
 * the same ET trading day up to and including bar i.
 * Typical price = (H + L + C) / 3 (standard intraday convention).
 */
export function vwapArray(bars: OhlcvBar[]): number[] {
  const out: number[] = new Array(bars.length).fill(0);
  let cumPV   = 0;
  let cumVol  = 0;
  let lastKey = "";

  for (let i = 0; i < bars.length; i++) {
    const b   = bars[i];
    const key = etDateKey(b.time);
    if (key !== lastKey) {
      cumPV   = 0;
      cumVol  = 0;
      lastKey = key;
    }
    const tp = (b.high + b.low + b.close) / 3;
    cumPV  += tp * b.volume;
    cumVol += b.volume;
    out[i]  = cumVol > 0 ? cumPV / cumVol : b.close;
  }
  return out;
}
