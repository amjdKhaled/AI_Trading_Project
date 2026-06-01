import { useState, useEffect } from "react";
import type { SnapshotDecision, SnapshotDecisionRow } from "@workspace/api-client-react";

// ── Local snapshot JSON shape (matches MarketSnapshot on the server) ──────────
interface SnapIndicators {
  rsi14: number; ema20: number; ema50: number; ema200: number;
  macdLine: number; macdSignal: number; macdHist: number;
  atr14: number; vwap: number; relativeVolume: number;
  bbUpper: number; bbLower: number; bbWidth: number;
}
interface SnapStructure {
  regime: string; bosCount: number; chochCount: number;
  lastBosDir: string | null; lastChochDir: string | null;
  lastSwingHigh: number; lastSwingLow: number;
}
interface SnapSR {
  nearestResistance: number | null; nearestSupport: number | null;
  distToResistancePct: number | null; distToSupportPct: number | null;
  resistanceLevels: number[]; supportLevels: number[];
}
interface SnapPivots { pp: number; r1: number; s1: number; r2: number; s2: number; }
interface SnapHtf { timeframe: string; bias: string; rsi14: number; ema20: number; ema50: number; }
interface SnapJson {
  session?:             string;
  regime?:              string;
  indicators?:          SnapIndicators;
  structure?:           SnapStructure;
  supportResistance?:   SnapSR;
  pivotPoints?:         SnapPivots;
  candlestickPatterns?: string[];
  chartPatterns?:       string[];
  htf?:                 SnapHtf | null;
}

interface Props {
  symbol:           string;
  timeframe:        string;
  latest:           SnapshotDecision | null;
  latestCandleTime: number | null;
}

export function SnapshotDiagnosticsPanel({ symbol, timeframe, latest, latestCandleTime }: Props) {
  const [tab, setTab]             = useState<"latest" | "history">("latest");
  const [latestRow, setLatestRow] = useState<SnapshotDecisionRow | null>(null);
  const [history, setHistory]     = useState<SnapshotDecisionRow[]>([]);
  const [loading, setLoading]     = useState(false);

  const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
  const histUrl = `${base}/api/signals/snapshot-decisions?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}&limit=20`;

  // Fetch single latest row (with snapshotJson) whenever a new decision arrives
  useEffect(() => {
    if (!latest) return;
    void fetch(`${base}/api/signals/snapshot-decisions?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}&limit=1`)
      .then((r) => (r.ok ? (r.json() as Promise<SnapshotDecisionRow[]>) : Promise.resolve([])))
      .then(([row]) => { if (row) setLatestRow(row); })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest, symbol, timeframe]);

  // Fetch history when tab switches or new decision arrives while on history tab
  useEffect(() => {
    if (tab !== "history") return;
    setLoading(true);
    void fetch(histUrl)
      .then((r) => (r.ok ? (r.json() as Promise<SnapshotDecisionRow[]>) : Promise.resolve([])))
      .then((rows) => { setHistory(rows); setLoading(false); })
      .catch(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, symbol, timeframe]);

  useEffect(() => {
    if (tab === "history" && latest) {
      void fetch(histUrl)
        .then((r) => (r.ok ? (r.json() as Promise<SnapshotDecisionRow[]>) : Promise.resolve([])))
        .then((rows) => setHistory(rows))
        .catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest]);

  const decCol = (d: string) =>
    d === "BUY" ? "#f59e0b" : d === "SELL" ? "#ef5350" : "#6b7280";

  return (
    <div style={{
      position:       "absolute",
      top:            0, right: 0, bottom: 0,
      width:          316,
      background:     "#0c0f16f8",
      borderLeft:     "1px solid #ffffff12",
      backdropFilter: "blur(12px)",
      zIndex:         40,
      display:        "flex",
      flexDirection:  "column",
      fontFamily:     "'JetBrains Mono', Menlo, monospace",
      overflowX:      "hidden",
    }}>
      {/* ── Header ── */}
      <div style={{ padding: "10px 12px 0", borderBottom: "1px solid #ffffff0a", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: "#f59e0b", textTransform: "uppercase", letterSpacing: "0.1em" }}>
            ◈ AI Snapshot
          </span>
          <span style={{ fontSize: 8, color: "#374151", marginLeft: "auto" }}>
            {symbol} · {timeframe}
          </span>
        </div>
        <div style={{ display: "flex" }}>
          {(["latest", "history"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} style={{
              flex: 1, padding: "5px 0",
              fontSize: 9, fontWeight: tab === t ? 700 : 400,
              color: tab === t ? "#f59e0b" : "#4b5563",
              background: "none", border: "none",
              borderBottom: `2px solid ${tab === t ? "#f59e0b" : "transparent"}`,
              cursor: "pointer", textTransform: "uppercase", letterSpacing: "0.1em",
            }}>
              {t === "latest" ? "Latest" : "History"}
            </button>
          ))}
        </div>
      </div>

      {/* ── Body ── */}
      <div style={{ flex: 1, overflowY: "auto", padding: "10px 12px" }}>
        {tab === "latest" ? (
          latest
            ? <LatestContent
                decision={latest}
                row={latestRow}
                candleTime={latestCandleTime}
                decCol={decCol}
              />
            : <Empty text="No snapshot yet — waiting for next candle close…" />
        ) : loading
          ? <Empty text="Loading…" />
          : history.length === 0
            ? <Empty text="No history for this symbol / timeframe yet." />
            : <HistoryContent rows={history} decCol={decCol} />
        }
      </div>
    </div>
  );
}

// ── Latest tab ─────────────────────────────────────────────────────────────────
function LatestContent({
  decision, row, candleTime, decCol,
}: {
  decision:   SnapshotDecision;
  row:        SnapshotDecisionRow | null;
  candleTime: number | null;
  decCol:     (d: string) => string;
}) {
  const col       = decCol(decision.decision);
  const confColor = decision.confidence >= 80 ? "#00ff88" : decision.confidence >= 65 ? "#f59e0b" : "#6b7280";
  const timeStr   = candleTime
    ? new Date(candleTime * 1000).toLocaleString(undefined, {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
      })
    : "";

  const snap = row?.snapshotJson as SnapJson | null | undefined;
  const ind  = snap?.indicators;
  const str  = snap?.structure;
  const sr   = snap?.supportResistance;
  const piv  = snap?.pivotPoints;
  const htf  = snap?.htf;
  const csPat = snap?.candlestickPatterns ?? [];
  const chPat = snap?.chartPatterns ?? [];
  const allPat = [...csPat, ...chPat].filter(Boolean);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>

      {/* ── AI Decision ── */}
      <Section label="AI Decision">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <span style={{
            fontSize: 12, fontWeight: 900, color: col,
            background: `${col}18`, border: `1px solid ${col}50`,
            borderRadius: 4, padding: "2px 10px",
          }}>{decision.decision}</span>
          {timeStr && <span style={{ fontSize: 8, color: "#374151", marginLeft: "auto" }}>{timeStr}</span>}
        </div>

        {/* Confidence */}
        <div style={{ marginBottom: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
            <span style={{ fontSize: 8, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em" }}>Confidence</span>
            <span style={{ fontSize: 9, fontWeight: 700, color: confColor }}>{decision.confidence}%</span>
          </div>
          <div style={{ height: 4, background: "#1f2937", borderRadius: 2, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${decision.confidence}%`, background: confColor, borderRadius: 2 }} />
          </div>
        </div>

        {/* Grade + RR */}
        <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
          <KV label="Grade" value={decision.grade} color="#f59e0b" badge />
          {decision.rr != null && <KV label="R:R" value={`${decision.rr.toFixed(2)}x`} color="#f59e0b" />}
          {snap?.session && <KV label="Session" value={snap.session} color="#6b7280" />}
        </div>

        {/* Entry / SL / TP */}
        {(decision.entry != null || decision.sl != null || decision.tp != null) && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4, marginBottom: 6 }}>
            {[
              { label: "Entry", val: decision.entry, color: "#9ca3af" },
              { label: "SL",    val: decision.sl,    color: "#ef5350" },
              { label: "TP",    val: decision.tp,    color: "#00ff88" },
            ].map(({ label, val, color }) => (
              <div key={label} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ fontSize: 7, color: "#4b5563", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
                <span style={{ fontSize: 9, fontWeight: 700, color }}>{val != null ? `$${val.toFixed(2)}` : "—"}</span>
              </div>
            ))}
          </div>
        )}

        {/* Reason */}
        <div style={{ fontSize: 9, color: "#6b7280", lineHeight: 1.55, borderTop: "1px solid #ffffff08", paddingTop: 6, marginTop: 2 }}>
          {decision.reason || "—"}
        </div>

        {/* Strengths + Weaknesses */}
        {(decision.strengths.length > 0 || decision.weaknesses.length > 0) && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 6 }}>
            <div>
              {decision.strengths.slice(0, 3).map((s, i) => (
                <div key={i} style={{ display: "flex", gap: 4, marginBottom: 3 }}>
                  <span style={{ fontSize: 8, color: "#00ff88", flexShrink: 0 }}>✓</span>
                  <span style={{ fontSize: 8, color: "#6b7280", lineHeight: 1.4 }}>{s}</span>
                </div>
              ))}
            </div>
            <div>
              {decision.weaknesses.slice(0, 3).map((w, i) => (
                <div key={i} style={{ display: "flex", gap: 4, marginBottom: 3 }}>
                  <span style={{ fontSize: 8, color: "#ef5350", flexShrink: 0 }}>✗</span>
                  <span style={{ fontSize: 8, color: "#6b7280", lineHeight: 1.4 }}>{w}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Section>

      {/* ── Indicators ── */}
      {ind && (
        <Section label="Indicators">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "3px 8px" }}>
            <KVRow label="RSI 14"   value={ind.rsi14.toFixed(1)}  color={ind.rsi14 > 70 ? "#ef5350" : ind.rsi14 < 30 ? "#00ff88" : "#9ca3af"} />
            <KVRow label="Rel Vol"  value={`${ind.relativeVolume.toFixed(2)}×`}  color={ind.relativeVolume > 1.5 ? "#f59e0b" : "#9ca3af"} />
            <KVRow label="EMA 20"   value={`$${ind.ema20.toFixed(2)}`}  color="#9ca3af" />
            <KVRow label="ATR 14"   value={ind.atr14.toFixed(2)}  color="#9ca3af" />
            <KVRow label="EMA 50"   value={`$${ind.ema50.toFixed(2)}`}  color="#9ca3af" />
            <KVRow label="VWAP"     value={`$${ind.vwap.toFixed(2)}`}   color="#9ca3af" />
            <KVRow label="EMA 200"  value={`$${ind.ema200.toFixed(2)}`} color="#9ca3af" />
            <KVRow label="BB Width" value={`${ind.bbWidth.toFixed(3)}`} color="#9ca3af" />
            <KVRow label="MACD"     value={ind.macdLine.toFixed(3)}      color={ind.macdLine >= 0 ? "#00ff88" : "#ef5350"} />
            <KVRow label="Signal"   value={ind.macdSignal.toFixed(3)}   color="#9ca3af" />
          </div>
        </Section>
      )}

      {/* ── Market Structure ── */}
      {str && (
        <Section label="Market Structure">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "3px 8px" }}>
            <KVRow label="Regime"  value={str.regime}   color={str.regime === "uptrend" ? "#00ff88" : str.regime === "downtrend" ? "#ef5350" : "#f59e0b"} />
            <KVRow label="BOS"     value={`${str.bosCount}${str.lastBosDir ? " " + (str.lastBosDir === "bullish" ? "↑" : "↓") : ""}`}  color="#9ca3af" />
            <KVRow label="Swing H" value={`$${str.lastSwingHigh.toFixed(2)}`} color="#ef5350" />
            <KVRow label="CHoCH"   value={`${str.chochCount}${str.lastChochDir ? " " + (str.lastChochDir === "bullish" ? "↑" : "↓") : ""}`} color="#9ca3af" />
            <KVRow label="Swing L" value={`$${str.lastSwingLow.toFixed(2)}`}  color="#00ff88" />
          </div>
        </Section>
      )}

      {/* ── Support / Resistance ── */}
      {sr && (
        <Section label="Support / Resistance">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "3px 8px" }}>
            <KVRow label="Resistance"
              value={sr.nearestResistance != null ? `$${sr.nearestResistance.toFixed(2)}` : "—"}
              sub={sr.distToResistancePct != null ? `+${sr.distToResistancePct.toFixed(2)}%` : undefined}
              color="#ef5350" />
            <KVRow label="Support"
              value={sr.nearestSupport != null ? `$${sr.nearestSupport.toFixed(2)}` : "—"}
              sub={sr.distToSupportPct != null ? `−${Math.abs(sr.distToSupportPct).toFixed(2)}%` : undefined}
              color="#00ff88" />
          </div>
          {(sr.resistanceLevels.length > 0 || sr.supportLevels.length > 0) && (
            <div style={{ marginTop: 4 }}>
              {sr.resistanceLevels.slice(0, 3).map((l, i) => (
                <span key={`r-${i}`} style={{
                  display: "inline-block", fontSize: 7.5, color: "#ef5350",
                  background: "#ef535015", borderRadius: 2, padding: "1px 5px", marginRight: 3, marginBottom: 2,
                }}>R {l.toFixed(2)}</span>
              ))}
              {sr.supportLevels.slice(0, 3).map((l, i) => (
                <span key={`s-${i}`} style={{
                  display: "inline-block", fontSize: 7.5, color: "#00ff88",
                  background: "#00ff8815", borderRadius: 2, padding: "1px 5px", marginRight: 3, marginBottom: 2,
                }}>S {l.toFixed(2)}</span>
              ))}
            </div>
          )}
        </Section>
      )}

      {/* ── Pivot Points ── */}
      {piv && (
        <Section label="Pivot Points">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "3px 6px" }}>
            <KVRow label="R2" value={piv.r2.toFixed(2)} color="#ef5350" />
            <KVRow label="PP" value={piv.pp.toFixed(2)} color="#f59e0b" />
            <KVRow label="S2" value={piv.s2.toFixed(2)} color="#00ff88" />
            <KVRow label="R1" value={piv.r1.toFixed(2)} color="#ef5350" />
            <KVRow label=""   value=""                   color="#4b5563" />
            <KVRow label="S1" value={piv.s1.toFixed(2)} color="#00ff88" />
          </div>
        </Section>
      )}

      {/* ── Patterns ── */}
      {allPat.length > 0 && (
        <Section label="Patterns">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
            {allPat.map((p, i) => (
              <span key={i} style={{
                fontSize: 8, color: "#f59e0b",
                background: "#f59e0b12", border: "1px solid #f59e0b30",
                borderRadius: 3, padding: "1px 6px",
              }}>{p}</span>
            ))}
          </div>
        </Section>
      )}

      {/* ── HTF Context ── */}
      {htf && (
        <Section label={`HTF Context (${htf.timeframe})`}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "3px 8px" }}>
            <KVRow label="Bias"   value={htf.bias}            color={htf.bias === "bullish" ? "#00ff88" : htf.bias === "bearish" ? "#ef5350" : "#f59e0b"} />
            <KVRow label="RSI 14" value={htf.rsi14.toFixed(1)} color="#9ca3af" />
            <KVRow label="EMA 20" value={`$${htf.ema20.toFixed(2)}`} color="#9ca3af" />
            <KVRow label="EMA 50" value={`$${htf.ema50.toFixed(2)}`} color="#9ca3af" />
          </div>
        </Section>
      )}

      {!ind && !str && !sr && (
        <div style={{ fontSize: 8.5, color: "#374151", textAlign: "center", paddingTop: 8 }}>
          Snapshot fields loading…
        </div>
      )}
    </div>
  );
}

// ── History tab ────────────────────────────────────────────────────────────────
function HistoryContent({
  rows, decCol,
}: { rows: SnapshotDecisionRow[]; decCol: (d: string) => string }) {
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "2.5fr 1.8fr 1.4fr 1.2fr", gap: "0 6px", marginBottom: 6 }}>
        {["Time", "Decision", "Conf", "R:R"].map((h) => (
          <span key={h} style={{ fontSize: 7, color: "#374151", textTransform: "uppercase", letterSpacing: "0.08em" }}>{h}</span>
        ))}
      </div>
      {rows.map((row) => {
        const col = decCol(row.decision);
        const cc  = row.confidence >= 80 ? "#00ff88" : row.confidence >= 65 ? "#f59e0b" : "#6b7280";
        const ts  = new Date(row.candleTime).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
        return (
          <div key={row.id} style={{
            display: "grid", gridTemplateColumns: "2.5fr 1.8fr 1.4fr 1.2fr",
            gap: "0 6px", padding: "4px 0", borderBottom: "1px solid #ffffff06", alignItems: "center",
          }}>
            <span style={{ fontSize: 8.5, color: "#6b7280" }}>{ts}</span>
            <span style={{
              fontSize: 8.5, fontWeight: 700, color: col,
              background: `${col}15`, borderRadius: 2, padding: "1px 5px", textAlign: "center",
            }}>{row.decision}</span>
            <span style={{ fontSize: 8.5, color: cc, textAlign: "right" }}>{row.confidence}%</span>
            <span style={{ fontSize: 8.5, color: "#6b7280", textAlign: "right" }}>
              {row.rr != null ? `${row.rr.toFixed(1)}x` : "—"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Shared helpers ─────────────────────────────────────────────────────────────
function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ borderTop: "1px solid #ffffff08", paddingTop: 8 }}>
      <div style={{
        fontSize: 7.5, color: "#4b5563", textTransform: "uppercase",
        letterSpacing: "0.1em", marginBottom: 5, fontWeight: 700,
      }}>
        {label}
      </div>
      {children}
    </div>
  );
}

function KV({ label, value, color, badge }: { label: string; value: string; color: string; badge?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <span style={{ fontSize: 7, color: "#4b5563", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
      {badge ? (
        <span style={{
          fontSize: 9, fontWeight: 800, color,
          background: `${color}15`, border: `1px solid ${color}35`,
          borderRadius: 3, padding: "0 5px", display: "inline-block",
        }}>{value}</span>
      ) : (
        <span style={{ fontSize: 9, fontWeight: 700, color }}>{value}</span>
      )}
    </div>
  );
}

function KVRow({ label, value, color, sub }: { label: string; value: string; color: string; sub?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 4 }}>
      <span style={{ fontSize: 8, color: "#4b5563", textTransform: "uppercase", letterSpacing: "0.05em", flexShrink: 0 }}>
        {label}
      </span>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
        <span style={{ fontSize: 8.5, fontWeight: 700, color, fontVariantNumeric: "tabular-nums" }}>{value}</span>
        {sub && <span style={{ fontSize: 7, color: "#4b5563" }}>{sub}</span>}
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{ fontSize: 9, color: "#374151", textAlign: "center", paddingTop: 24 }}>{text}</div>
  );
}
