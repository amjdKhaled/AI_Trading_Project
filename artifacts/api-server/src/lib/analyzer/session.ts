// ============================================================
// Session Awareness — NYSE intraday session buckets
// ============================================================
// Buckets each bar timestamp into one of four intraday windows so the
// scorer can adjust threshold / weighting per session:
//
//   open       09:30–10:30 ET — high volatility, breakout-favorable
//   regular    10:30–11:30 ET — trend digestion
//   midday     11:30–14:00 ET — lunch chop, suppress signals
//   power-hour 15:00–16:00 ET — late-day continuation / squeeze
//   regular    14:00–15:00 ET — afternoon (default)
// ============================================================

export type Session = "open" | "regular" | "midday" | "power-hour";

const ET_PARTS_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone:  "America/New_York",
  hourCycle: "h23",
  hour:      "2-digit",
  minute:    "2-digit",
});

export function sessionFor(epochSec: number): Session {
  const parts = ET_PARTS_FMT.formatToParts(new Date(epochSec * 1000));
  const hh = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const mm = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const t  = hh * 60 + mm;

  if (t >= 570 && t < 630)  return "open";        // 09:30–10:30
  if (t >= 690 && t < 840)  return "midday";      // 11:30–14:00
  if (t >= 900 && t < 960)  return "power-hour";  // 15:00–16:00
  return "regular";
}
