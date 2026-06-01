import { useState, useEffect } from "react";
import type { SnapshotDecision, SnapshotDecisionRow } from "@workspace/api-client-react";

interface Props {
  symbol:           string;
  timeframe:        string;
  latest:           SnapshotDecision | null;
  latestCandleTime: number | null;
}

export function SnapshotDiagnosticsPanel({ symbol, timeframe, latest, latestCandleTime }: Props) {
  const [tab, setTab]           = useState<"latest" | "history">("latest");
  const [history, setHistory]   = useState<SnapshotDecisionRow[]>([]);
  const [loading, setLoading]   = useState(false);

  const loadHistory = () => {
    const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
    void fetch(
      `${base}/api/signals/snapshot-decisions?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}&limit=20`,
    )
      .then((r) => (r.ok ? (r.json() as Promise<SnapshotDecisionRow[]>) : Promise.resolve([])))
      .then((rows) => { setHistory(rows); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => {
    if (tab !== "history") return;
    setLoading(true);
    loadHistory();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, symbol, timeframe]);

  useEffect(() => {
    if (tab === "history" && latest) loadHistory();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest]);

  const decCol = (d: string) =>
    d === "BUY" ? "#f59e0b" : d === "SELL" ? "#ef5350" : "#6b7280";

  return (
    <div style={{
      position:        "absolute",
      top:             0,
      right:           0,
      bottom:          0,
      width:           300,
      background:      "#0c0f16f6",
      borderLeft:      "1px solid #ffffff12",
      backdropFilter:  "blur(12px)",
      zIndex:          40,
      display:         "flex",
      flexDirection:   "column",
      fontFamily:      "'JetBrains Mono', Menlo, monospace",
      overflowX:       "hidden",
    }}>
      {/* ── Header ── */}
      <div style={{ padding: "10px 12px 0", borderBottom: "1px solid #ffffff0a", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
          <span style={{
            fontSize: 10, fontWeight: 700, color: "#f59e0b",
            textTransform: "uppercase", letterSpacing: "0.1em",
          }}>
            ◈ AI Snapshot
          </span>
          <span style={{ fontSize: 8, color: "#374151", marginLeft: "auto" }}>
            {symbol} · {timeframe}
          </span>
        </div>
        <div style={{ display: "flex" }}>
          {(["latest", "history"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} style={{
              flex:          1,
              padding:       "5px 0",
              fontSize:      9,
              fontWeight:    tab === t ? 700 : 400,
              color:         tab === t ? "#f59e0b" : "#4b5563",
              background:    "none",
              border:        "none",
              borderBottom:  `2px solid ${tab === t ? "#f59e0b" : "transparent"}`,
              cursor:        "pointer",
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              transition:    "color 0.15s",
            }}>
              {t === "latest" ? "Latest" : "History"}
            </button>
          ))}
        </div>
      </div>

      {/* ── Body ── */}
      <div style={{ flex: 1, overflowY: "auto", padding: "10px 12px" }}>
        {tab === "latest" ? (
          latest ? (
            <LatestContent snap={latest} candleTime={latestCandleTime} decCol={decCol} />
          ) : (
            <Empty text="No snapshot yet — waiting for next candle close…" />
          )
        ) : loading ? (
          <Empty text="Loading…" />
        ) : history.length === 0 ? (
          <Empty text="No history for this symbol / timeframe yet." />
        ) : (
          <HistoryContent rows={history} decCol={decCol} />
        )}
      </div>
    </div>
  );
}

// ── Latest tab ─────────────────────────────────────────────────────────────────
function LatestContent({
  snap, candleTime, decCol,
}: {
  snap:       SnapshotDecision;
  candleTime: number | null;
  decCol:     (d: string) => string;
}) {
  const col       = decCol(snap.decision);
  const confColor = snap.confidence >= 80 ? "#00ff88" : snap.confidence >= 65 ? "#f59e0b" : "#6b7280";
  const timeStr   = candleTime
    ? new Date(candleTime * 1000).toLocaleString(undefined, {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
      })
    : "";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Decision badge + timestamp */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{
          fontSize:   12, fontWeight: 900, color: col,
          background: `${col}18`, border: `1px solid ${col}50`,
          borderRadius: 4, padding: "2px 10px",
        }}>
          {snap.decision}
        </span>
        {timeStr && (
          <span style={{ fontSize: 8, color: "#374151", marginLeft: "auto" }}>{timeStr}</span>
        )}
      </div>

      {/* Confidence bar */}
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
          <span style={{ fontSize: 8, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Confidence
          </span>
          <span style={{ fontSize: 9, fontWeight: 700, color: confColor }}>{snap.confidence}%</span>
        </div>
        <div style={{ height: 4, background: "#1f2937", borderRadius: 2, overflow: "hidden" }}>
          <div style={{
            height: "100%", width: `${snap.confidence}%`,
            background: confColor, borderRadius: 2, transition: "width 0.5s",
          }} />
        </div>
      </div>

      {/* Grade */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 8, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Grade
        </span>
        <span style={{
          fontSize: 10, fontWeight: 800, color: "#f59e0b",
          background: "#f59e0b15", border: "1px solid #f59e0b35",
          borderRadius: 3, padding: "1px 7px",
        }}>
          {snap.grade}
        </span>
      </div>

      {/* Entry / SL / TP / R:R grid */}
      {(snap.entry != null || snap.sl != null || snap.tp != null) && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 4 }}>
          {([
            { label: "Entry", val: snap.entry, color: "#9ca3af", fmt: (v: number) => `$${v.toFixed(2)}` },
            { label: "SL",    val: snap.sl,    color: "#ef5350", fmt: (v: number) => `$${v.toFixed(2)}` },
            { label: "TP",    val: snap.tp,    color: "#00ff88", fmt: (v: number) => `$${v.toFixed(2)}` },
            { label: "R:R",   val: snap.rr,    color: "#f59e0b", fmt: (v: number) => `${v.toFixed(2)}x` },
          ] as const).map(({ label, val, color, fmt }) => (
            <div key={label} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: 7, color: "#4b5563", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                {label}
              </span>
              <span style={{ fontSize: 9, fontWeight: 700, color }}>
                {val != null ? fmt(val) : "—"}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* AI Reasoning */}
      <div style={{ borderTop: "1px solid #ffffff08", paddingTop: 8 }}>
        <div style={{
          fontSize: 8, color: "#6b7280", textTransform: "uppercase",
          letterSpacing: "0.06em", marginBottom: 5,
        }}>
          AI Reasoning
        </div>
        <div style={{ fontSize: 9.5, color: "#9ca3af", lineHeight: 1.55 }}>
          {snap.reason || "—"}
        </div>
      </div>

      {/* Strengths */}
      {snap.strengths.length > 0 && (
        <div>
          <div style={{
            fontSize: 8, color: "#6b7280", textTransform: "uppercase",
            letterSpacing: "0.06em", marginBottom: 4,
          }}>
            Strengths
          </div>
          {snap.strengths.map((s, i) => (
            <div key={i} style={{ display: "flex", gap: 6, marginBottom: 4 }}>
              <span style={{ fontSize: 9, color: "#00ff88", flexShrink: 0 }}>✓</span>
              <span style={{ fontSize: 9, color: "#6b7280" }}>{s}</span>
            </div>
          ))}
        </div>
      )}

      {/* Weaknesses */}
      {snap.weaknesses.length > 0 && (
        <div>
          <div style={{
            fontSize: 8, color: "#6b7280", textTransform: "uppercase",
            letterSpacing: "0.06em", marginBottom: 4,
          }}>
            Weaknesses
          </div>
          {snap.weaknesses.map((w, i) => (
            <div key={i} style={{ display: "flex", gap: 6, marginBottom: 4 }}>
              <span style={{ fontSize: 9, color: "#ef5350", flexShrink: 0 }}>✗</span>
              <span style={{ fontSize: 9, color: "#6b7280" }}>{w}</span>
            </div>
          ))}
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
      <div style={{
        display: "grid", gridTemplateColumns: "2.5fr 1.8fr 1.4fr 1.2fr",
        gap: "0 6px", marginBottom: 6,
      }}>
        {["Time", "Decision", "Conf", "R:R"].map((h) => (
          <span key={h} style={{
            fontSize: 7, color: "#374151",
            textTransform: "uppercase", letterSpacing: "0.08em",
          }}>
            {h}
          </span>
        ))}
      </div>

      {rows.map((row) => {
        const col = decCol(row.decision);
        const cc  = row.confidence >= 80 ? "#00ff88" : row.confidence >= 65 ? "#f59e0b" : "#6b7280";
        const ts  = new Date(row.candleTime).toLocaleTimeString(undefined, {
          hour: "2-digit", minute: "2-digit",
        });
        return (
          <div key={row.id} style={{
            display:       "grid",
            gridTemplateColumns: "2.5fr 1.8fr 1.4fr 1.2fr",
            gap:           "0 6px",
            padding:       "4px 0",
            borderBottom:  "1px solid #ffffff06",
            alignItems:    "center",
          }}>
            <span style={{ fontSize: 8.5, color: "#6b7280" }}>{ts}</span>
            <span style={{
              fontSize: 8.5, fontWeight: 700, color: col,
              background: `${col}15`, borderRadius: 2,
              padding: "1px 5px", textAlign: "center",
            }}>
              {row.decision}
            </span>
            <span style={{ fontSize: 8.5, color: cc, textAlign: "right" }}>
              {row.confidence}%
            </span>
            <span style={{ fontSize: 8.5, color: "#6b7280", textAlign: "right" }}>
              {row.rr != null ? `${row.rr.toFixed(1)}x` : "—"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Shared ────────────────────────────────────────────────────────────────────
function Empty({ text }: { text: string }) {
  return (
    <div style={{ fontSize: 9, color: "#374151", textAlign: "center", paddingTop: 24 }}>
      {text}
    </div>
  );
}
