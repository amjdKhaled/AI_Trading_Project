import { useState, useEffect, useRef, useCallback } from "react";
import {
  Upload, X, Brain, TrendingUp, TrendingDown, Minus, Eye,
  ChevronDown, ChevronUp, Layers, CheckCircle, AlertTriangle,
  ArrowUpCircle, ArrowDownCircle, MinusCircle, Radio, RefreshCw, Clock,
} from "lucide-react";
import {
  useListChartAnalyses,
  type ChartAnalysis,
  type AiDecision,
  type SimilarityMatch,
  type ChartAnalysisRecord,
} from "@workspace/api-client-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// ── Small helpers ─────────────────────────────────────────────────

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1] ?? "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function dataUrlToBase64(dataUrl: string): string {
  return dataUrl.split(",")[1] ?? dataUrl;
}

async function makeThumbnail(dataUrl: string, tw = 160, th = 100): Promise<string> {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = tw; c.height = th;
      c.getContext("2d")!.drawImage(img, 0, 0, tw, th);
      resolve(c.toDataURL("image/jpeg", 0.7).split(",")[1] ?? "");
    };
    img.onerror = () => resolve("");
    img.src = dataUrl;
  });
}

const TREND_LABEL: Record<string, string> = {
  strong_uptrend: "Strong Uptrend", uptrend: "Uptrend",
  neutral: "Neutral", downtrend: "Downtrend", strong_downtrend: "Strong Downtrend",
};
const TREND_COLOR: Record<string, string> = {
  strong_uptrend: "text-emerald-400", uptrend: "text-emerald-300",
  neutral: "text-amber-400", downtrend: "text-red-300", strong_downtrend: "text-red-400",
};
const STRUCTURE_LABEL: Record<string, string> = {
  higher_highs_lows: "Higher H&L", lower_highs_lows: "Lower H&L",
  range_bound: "Range", breakout: "Breakout", breakdown: "Breakdown", unclear: "Unclear",
};

function TrendIcon({ trend }: { trend: string }) {
  if (trend.includes("uptrend")) return <TrendingUp size={14} className="text-emerald-400" />;
  if (trend.includes("downtrend")) return <TrendingDown size={14} className="text-red-400" />;
  return <Minus size={14} className="text-amber-400" />;
}

function DirectionBadge({ direction }: { direction: string | null | undefined }) {
  if (!direction) return null;
  if (direction === "LONG") return (
    <span className="flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
      <ArrowUpCircle size={12} /> LONG
    </span>
  );
  if (direction === "SHORT") return (
    <span className="flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/30">
      <ArrowDownCircle size={12} /> SHORT
    </span>
  );
  return (
    <span className="flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/30">
      <MinusCircle size={12} /> NO TRADE
    </span>
  );
}

function ConfidenceMeter({ value, label }: { value: number; label?: string }) {
  const color = value >= 70 ? "bg-emerald-500" : value >= 50 ? "bg-amber-500" : "bg-red-500";
  return (
    <div>
      {label && <div className="text-[10px] text-muted-foreground mb-1">{label}</div>}
      <div className="flex items-center gap-2">
        <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
          <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${value}%` }} />
        </div>
        <span className="text-xs font-mono font-bold w-10 text-right">{value}%</span>
      </div>
    </div>
  );
}

function WrBadge({ rate, n }: { rate: number; n: number }) {
  const color = rate >= 60 ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
    : rate >= 45 ? "bg-amber-500/20 text-amber-400 border-amber-500/30"
    : "bg-red-500/20 text-red-400 border-red-500/30";
  return (
    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${color}`}>
      {rate.toFixed(0)}% WR ({n})
    </span>
  );
}

// ── Canvas annotation — S/R lines + Entry/SL/TP ──────────────────

function ChartAnnotation({
  imageDataUrl,
  analysis,
  decision,
}: {
  imageDataUrl: string;
  analysis: ChartAnalysis;
  decision?: AiDecision | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const maxW = 680;
      const scale = img.width > maxW ? maxW / img.width : 1;
      setDims({ w: Math.round(img.width * scale), h: Math.round(img.height * scale) });
    };
    img.src = imageDataUrl;
  }, [imageDataUrl]);

  useEffect(() => {
    if (!dims) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, dims.w, dims.h);
      ctx.drawImage(img, 0, 0, dims.w, dims.h);

      const srLevels = [
        ...analysis.resistanceLevels.map(p => ({ price: p, type: "resistance" as const })),
        ...analysis.supportLevels.map(p => ({ price: p, type: "support" as const })),
      ];

      const tradeLevels: { price: number; type: "entry" | "sl" | "tp" }[] = [];
      if (decision) {
        tradeLevels.push(
          { price: decision.entry,        type: "entry" },
          { price: decision.stopLoss,     type: "sl" },
          { price: decision.takeProfit1,  type: "tp" },
        );
      }

      const allPrices = [
        ...srLevels.map(l => l.price),
        ...tradeLevels.map(l => l.price),
      ].filter(p => p > 0);

      if (allPrices.length < 2) {
        drawTrendBadge(ctx, analysis.trend, dims.w, dims.h);
        return;
      }

      const minP = Math.min(...allPrices);
      const maxP = Math.max(...allPrices);
      const range = maxP - minP || 1;
      const priceToY = (p: number) => dims.h * 0.08 + (1 - (p - minP) / range) * dims.h * 0.84;

      const supplySet = new Set(analysis.supplyZones);
      const demandSet = new Set(analysis.demandZones);

      for (const { price, type } of srLevels) {
        const y = priceToY(price);
        const isZone = supplySet.has(price) || demandSet.has(price);
        if (isZone) {
          ctx.fillStyle = type === "resistance" ? "rgba(239,68,68,0.08)" : "rgba(16,185,129,0.08)";
          ctx.fillRect(0, y - 6, dims.w, 12);
        }
        ctx.beginPath();
        ctx.setLineDash(type === "resistance" ? [8, 4] : [4, 4]);
        ctx.strokeStyle = type === "resistance" ? "rgba(239,68,68,0.65)" : "rgba(16,185,129,0.65)";
        ctx.lineWidth = 1.2;
        ctx.moveTo(0, y); ctx.lineTo(dims.w, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = type === "resistance" ? "rgba(239,68,68,0.85)" : "rgba(16,185,129,0.85)";
        ctx.font = "bold 9px monospace";
        ctx.fillText(price.toFixed(2), 6, y - 3);
      }

      for (const { price, type } of tradeLevels) {
        if (!price || price <= 0) continue;
        const y = priceToY(price);
        const color = type === "entry" ? "rgba(99,102,241,0.9)"
          : type === "sl" ? "rgba(239,68,68,0.9)"
          : "rgba(16,185,129,0.9)";
        const label = type === "entry" ? `ENTRY ${price.toFixed(2)}`
          : type === "sl" ? `SL ${price.toFixed(2)}`
          : `TP ${price.toFixed(2)}`;

        ctx.beginPath();
        ctx.setLineDash([10, 5]);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.moveTo(0, y); ctx.lineTo(dims.w, y);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.font = "bold 10px monospace";
        const tw = ctx.measureText(label).width;
        const px = dims.w - tw - 16;
        ctx.fillStyle = color.replace("0.9", "0.85");
        ctx.beginPath();
        ctx.roundRect(px - 4, y - 14, tw + 10, 16, 3);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.fillText(label, px, y - 3);
      }

      drawTrendBadge(ctx, analysis.trend, dims.w, dims.h);
    };
    img.src = imageDataUrl;
  }, [dims, imageDataUrl, analysis, decision]);

  return dims ? (
    <canvas ref={canvasRef} width={dims.w} height={dims.h} className="rounded border border-border w-full" />
  ) : (
    <div className="flex items-center justify-center h-32 bg-muted rounded animate-pulse">
      <Eye size={16} className="text-muted-foreground" />
    </div>
  );
}

function drawTrendBadge(ctx: CanvasRenderingContext2D, trend: string, w: number, h: number) {
  const isUp = trend.includes("uptrend");
  const isDown = trend.includes("downtrend");
  const label = isUp ? "▲ AI LONG" : isDown ? "▼ AI SHORT" : "— AI NEUTRAL";
  const bg = isUp ? "rgba(16,185,129,0.85)" : isDown ? "rgba(239,68,68,0.85)" : "rgba(245,158,11,0.85)";
  ctx.font = "bold 11px monospace";
  const textW = ctx.measureText(label).width;
  const pad = 8;
  const bx = w - textW - pad * 2 - 10, by = h - 32;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(bx, by, textW + pad * 2, 22, 4);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.fillText(label, bx + pad, by + 15);
}

// ── Decision card ─────────────────────────────────────────────────

function DecisionCard({ decision, isLive, updatedAt }: { decision: AiDecision; isLive?: boolean; updatedAt?: Date | null }) {
  const isLong    = decision.direction === "LONG";
  const isShort   = decision.direction === "SHORT";
  const isNoTrade = decision.direction === "NO_TRADE";

  const bannerBg   = isLong ? "bg-emerald-500" : isShort ? "bg-red-500" : "bg-amber-500";
  const bannerText = isLong ? "text-emerald-950" : isShort ? "text-red-950" : "text-amber-950";
  const borderCol  = isLong ? "border-emerald-500/30" : isShort ? "border-red-500/30" : "border-amber-500/30";
  const bgTint     = isLong ? "bg-emerald-500/5" : isShort ? "bg-red-500/5" : "bg-amber-500/5";
  const dirIcon    = isLong ? "🟢" : isShort ? "🔴" : "🟡";
  const dirLabel   = isLong ? "LONG" : isShort ? "SHORT" : "NO TRADE";

  return (
    <div className={`border rounded overflow-hidden ${borderCol} ${bgTint}`}>

      {/* ── Prominent direction banner ── */}
      <div className={`${bannerBg} ${bannerText} px-5 py-3 flex items-center justify-between`}>
        <div className="flex items-center gap-3">
          <span className="text-2xl leading-none">{dirIcon}</span>
          <div>
            <div className="text-xl font-black tracking-widest">{dirLabel}</div>
            <div className="text-[11px] font-medium opacity-80">
              Confidence: {decision.confidence}% · Success Probability: {decision.successProbability}%
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isLive && (
            <span className="flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded bg-white/20 animate-pulse">
              <Radio size={8} /> LIVE
            </span>
          )}
          {updatedAt && (
            <span className="text-[10px] opacity-70">
              {updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
          )}
        </div>
      </div>

      <div className="p-4 space-y-4">

        {/* ── LONG / SHORT trade plan ── */}
        {!isNoTrade && decision.entry > 0 && (
          <>
            {/* Entry + SL row */}
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-card border border-indigo-500/20 rounded p-3 text-center">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-indigo-400 mb-1">Entry</div>
                <div className="text-lg font-mono font-bold text-indigo-300">{decision.entry.toFixed(2)}</div>
              </div>
              <div className="bg-card border border-red-500/20 rounded p-3 text-center">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-red-400 mb-1">Stop Loss</div>
                <div className="text-lg font-mono font-bold text-red-300">{decision.stopLoss.toFixed(2)}</div>
              </div>
            </div>

            {/* TP1 / TP2 / TP3 row */}
            <div className="grid grid-cols-3 gap-2">
              {[
                { label: "TP 1", value: decision.takeProfit1, hint: "1st target" },
                { label: "TP 2", value: decision.takeProfit2, hint: "extended" },
                { label: "TP 3", value: decision.takeProfit3, hint: "runner" },
              ].map(({ label, value, hint }) => (
                <div key={label} className="bg-card border border-emerald-500/20 rounded p-3 text-center">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400 mb-0.5">{label}</div>
                  <div className={`text-sm font-mono font-bold ${value > 0 ? "text-emerald-300" : "text-muted-foreground"}`}>
                    {value > 0 ? value.toFixed(2) : "—"}
                  </div>
                  <div className="text-[9px] text-muted-foreground/60 mt-0.5">{hint}</div>
                </div>
              ))}
            </div>

            {/* R:R */}
            <div className="flex items-center justify-center gap-2 py-1">
              <span className="text-xs text-muted-foreground">Risk/Reward:</span>
              <span className={`text-sm font-mono font-bold ${decision.riskReward >= 2 ? "text-emerald-400" : decision.riskReward >= 1.5 ? "text-amber-400" : "text-red-400"}`}>
                1 : {decision.riskReward.toFixed(2)}
              </span>
            </div>

            {/* Confidence meters */}
            <div className="space-y-2">
              <ConfidenceMeter value={decision.confidence} label="Decision Confidence" />
              <ConfidenceMeter value={decision.successProbability} label="Success Probability" />
            </div>
          </>
        )}

        {/* ── NO_TRADE explanation ── */}
        {isNoTrade && (
          <div className="space-y-3">
            {decision.noTradeReason && (
              <div className="bg-amber-500/10 border border-amber-500/20 rounded p-3">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-amber-400 mb-1">Why No Trade</div>
                <p className="text-xs text-foreground leading-relaxed">{decision.noTradeReason}</p>
              </div>
            )}
            {decision.noTradeMissingCondition && (
              <div className="bg-card border border-border rounded p-3">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Missing Condition</div>
                <p className="text-xs text-foreground leading-relaxed">{decision.noTradeMissingCondition}</p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              {decision.noTradeBreakoutLevel != null && decision.noTradeBreakoutLevel > 0 && (
                <div className="bg-emerald-500/10 border border-emerald-500/20 rounded p-3">
                  <div className="text-[10px] text-emerald-400 font-semibold uppercase mb-1">LONG trigger</div>
                  <div className="text-base font-mono font-bold text-emerald-300">
                    {decision.noTradeBreakoutLevel.toFixed(2)}
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">Breakout above</div>
                </div>
              )}
              {decision.noTradeBreakdownLevel != null && decision.noTradeBreakdownLevel > 0 && (
                <div className="bg-red-500/10 border border-red-500/20 rounded p-3">
                  <div className="text-[10px] text-red-400 font-semibold uppercase mb-1">SHORT trigger</div>
                  <div className="text-base font-mono font-bold text-red-300">
                    {decision.noTradeBreakdownLevel.toFixed(2)}
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">Breakdown below</div>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 gap-2">
              {decision.noTradeConfirmationCandle && (
                <div className="bg-card border border-border rounded p-2.5">
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">Confirmation Candle</div>
                  <p className="text-xs text-foreground">{decision.noTradeConfirmationCandle}</p>
                </div>
              )}
              {decision.noTradeVolumeCondition && (
                <div className="bg-card border border-border rounded p-2.5">
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">Volume Condition</div>
                  <p className="text-xs text-foreground">{decision.noTradeVolumeCondition}</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Reasoning (both directions) ── */}
        <div className="space-y-2">
          {[
            { title: "Technical Analysis",   text: decision.technicalReasoning },
            { title: "Market Structure",      text: decision.marketStructureReasoning },
            { title: "Historical Context",    text: decision.historicalReasoning },
          ].map(({ title, text }) =>
            text ? (
              <div key={title} className="bg-card border border-border rounded p-3">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">{title}</div>
                <p className="text-[11px] leading-relaxed text-foreground">{text}</p>
              </div>
            ) : null
          )}
        </div>

      </div>
    </div>
  );
}

// ── Result Card ───────────────────────────────────────────────────

function ResultCard({
  analysis,
  decision,
  matches,
  imageDataUrl,
  isLive,
  liveUpdatedAt,
}: {
  analysis: ChartAnalysis;
  decision?: AiDecision | null;
  matches: SimilarityMatch[];
  imageDataUrl: string;
  isLive?: boolean;
  liveUpdatedAt?: Date | null;
}) {
  const trendColor = TREND_COLOR[analysis.trend] ?? "text-foreground";

  return (
    <div className="space-y-4">
      {decision && <DecisionCard decision={decision} isLive={isLive} updatedAt={liveUpdatedAt} />}

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Annotated Chart</div>
          <ChartAnnotation imageDataUrl={imageDataUrl} analysis={analysis} decision={decision} />
        </div>

        <div className="space-y-3">
          <div className="bg-card border border-border rounded p-3">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Vision Analysis</div>
            <div className="flex items-center gap-2 mb-2">
              <TrendIcon trend={analysis.trend} />
              <span className={`text-sm font-bold ${trendColor}`}>{TREND_LABEL[analysis.trend] ?? analysis.trend}</span>
            </div>
            <ConfidenceMeter value={analysis.confidence} label="Model Confidence" />
            <p className="text-[11px] text-foreground leading-relaxed mt-2">{analysis.summary}</p>
          </div>

          <div className="bg-card border border-border rounded p-3 grid grid-cols-2 gap-3">
            <div>
              <div className="text-[10px] text-muted-foreground mb-1">Market Structure</div>
              <div className="text-xs font-mono">{STRUCTURE_LABEL[analysis.marketStructure] ?? analysis.marketStructure}</div>
            </div>
            <div>
              <div className="text-[10px] text-muted-foreground mb-1">Volume</div>
              <div className="text-xs font-mono capitalize">{analysis.volumeBehavior}</div>
            </div>
          </div>

          {(analysis.resistanceLevels.length > 0 || analysis.supportLevels.length > 0) && (
            <div className="bg-card border border-border rounded p-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Key Levels</div>
              <div className="grid grid-cols-2 gap-2">
                {analysis.resistanceLevels.length > 0 && (
                  <div>
                    <div className="text-[10px] text-red-400 mb-1">Resistance</div>
                    {analysis.resistanceLevels.slice(0, 4).map((lvl, i) => (
                      <div key={i} className="text-xs font-mono">{lvl.toFixed(2)}</div>
                    ))}
                  </div>
                )}
                {analysis.supportLevels.length > 0 && (
                  <div>
                    <div className="text-[10px] text-emerald-400 mb-1">Support</div>
                    {analysis.supportLevels.slice(0, 4).map((lvl, i) => (
                      <div key={i} className="text-xs font-mono">{lvl.toFixed(2)}</div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {analysis.patterns.length > 0 && (
        <div className="bg-card border border-border rounded p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Detected Patterns</div>
          <div className="flex flex-wrap gap-1.5">
            {analysis.patterns.map((p, i) => (
              <span key={i} className="text-xs px-2 py-0.5 rounded bg-primary/10 text-primary border border-primary/20 font-mono">{p}</span>
            ))}
          </div>
        </div>
      )}

      {(analysis.supplyZones.length > 0 || analysis.demandZones.length > 0) && (
        <div className="bg-card border border-border rounded p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Supply / Demand Zones</div>
          <div className="grid grid-cols-2 gap-3">
            {analysis.supplyZones.length > 0 && (
              <div>
                <div className="text-[10px] text-red-400 mb-1">Supply</div>
                {analysis.supplyZones.slice(0, 3).map((z, i) => (
                  <div key={i} className="text-xs font-mono text-red-300">{z.toFixed(2)}</div>
                ))}
              </div>
            )}
            {analysis.demandZones.length > 0 && (
              <div>
                <div className="text-[10px] text-emerald-400 mb-1">Demand</div>
                {analysis.demandZones.slice(0, 3).map((z, i) => (
                  <div key={i} className="text-xs font-mono text-emerald-300">{z.toFixed(2)}</div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {matches.length > 0 && (
        <div className="bg-card border border-border rounded p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Historical Similar Setups</div>
          <div className="space-y-2">
            {matches.slice(0, 5).map((m, i) => (
              <div key={i} className="flex items-start justify-between gap-2 py-1.5 border-b border-border/50 last:border-0">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-xs font-mono font-semibold">{m.symbol}</span>
                    <span className={`text-[10px] font-mono px-1 py-0.5 rounded ${m.side === "long" ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"}`}>
                      {m.side.toUpperCase()}
                    </span>
                    <span className="text-[10px] text-muted-foreground capitalize">{m.regime}</span>
                  </div>
                  <div className="text-[10px] text-muted-foreground truncate">{m.strategy}</div>
                </div>
                <div className="flex flex-col items-end gap-1 flex-shrink-0">
                  <WrBadge rate={m.historicalWinRate * 100} n={m.sampleSize} />
                  <span className="text-[10px] font-mono text-muted-foreground">RR {m.avgRR.toFixed(1)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Recent analyses list ──────────────────────────────────────────

function RecentCard({ item }: { item: ChartAnalysisRecord }) {
  const [expanded, setExpanded] = useState(false);
  const trendColor = TREND_COLOR[item.trend] ?? "text-foreground";
  const date = new Date(item.createdAt).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });

  return (
    <div className="bg-card border border-border rounded overflow-hidden">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/30 transition-colors text-left"
      >
        {item.thumbnailBase64 ? (
          <img
            src={`data:image/jpeg;base64,${item.thumbnailBase64}`}
            alt=""
            className="w-16 h-10 object-cover rounded border border-border flex-shrink-0"
          />
        ) : (
          <div className="w-16 h-10 rounded bg-muted flex items-center justify-center flex-shrink-0">
            <Eye size={12} className="text-muted-foreground" />
          </div>
        )}

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <TrendIcon trend={item.trend} />
            <span className={`text-xs font-mono font-semibold ${trendColor}`}>
              {TREND_LABEL[item.trend] ?? item.trend}
            </span>
            {item.direction && <DirectionBadge direction={item.direction} />}
            {item.symbol && <span className="text-xs font-mono text-muted-foreground">{item.symbol}</span>}
            {item.timeframe && <span className="text-[10px] text-muted-foreground">{item.timeframe}</span>}
          </div>
          <div className="text-[10px] text-muted-foreground mt-0.5">{date}</div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-[10px] font-mono">{item.confidence}%</span>
          {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3 border-t border-border/50 space-y-2">
          <p className="text-[11px] text-muted-foreground pt-2 leading-relaxed">{item.summary}</p>

          {item.entryPrice != null && (
            <div className="grid grid-cols-4 gap-1">
              {[
                { label: "Entry", value: item.entryPrice?.toFixed(2),  color: "text-indigo-400" },
                { label: "SL",    value: item.slPrice?.toFixed(2),      color: "text-red-400" },
                { label: "TP",    value: item.tpPrice?.toFixed(2),      color: "text-emerald-400" },
                { label: "R:R",   value: item.rrRatio != null ? `1:${item.rrRatio.toFixed(1)}` : "—", color: "text-foreground" },
              ].map(({ label, value, color }) => (
                <div key={label} className="bg-muted rounded p-1.5 text-center">
                  <div className="text-[9px] text-muted-foreground">{label}</div>
                  <div className={`text-[11px] font-mono font-bold ${color}`}>{value ?? "—"}</div>
                </div>
              ))}
            </div>
          )}

          {item.patterns.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {item.patterns.map((p, i) => (
                <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20 font-mono">{p}</span>
              ))}
            </div>
          )}
          <div className="grid grid-cols-2 gap-2 text-[10px]">
            <div>
              <span className="text-muted-foreground">Structure: </span>
              <span className="font-mono">{STRUCTURE_LABEL[item.marketStructure] ?? item.marketStructure}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Volume: </span>
              <span className="font-mono capitalize">{item.volumeBehavior}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Upload Zone ───────────────────────────────────────────────────

interface QueuedImage { id: string; file?: File; dataUrl: string; name: string; }

function UploadZone({ onImages }: { onImages: (imgs: QueuedImage[]) => void }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const processFiles = useCallback((files: FileList | File[]) => {
    const arr = Array.from(files).filter(f => /image\/(png|jpe?g|webp)/.test(f.type));
    Promise.all(arr.map(file => new Promise<QueuedImage>(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve({ id: `${Date.now()}-${Math.random()}`, file, dataUrl: reader.result as string, name: file.name });
      reader.readAsDataURL(file);
    }))).then(onImages);
  }, [onImages]);

  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => { e.preventDefault(); setDragging(false); processFiles(e.dataTransfer.files); }}
      onPaste={e => {
        const item = Array.from(e.clipboardData.items).find(it => it.kind === "file" && /image/.test(it.type));
        const f = item?.getAsFile();
        if (f) processFiles([f]);
      }}
      onClick={() => inputRef.current?.click()}
      tabIndex={0}
      className={`flex flex-col items-center justify-center gap-3 p-8 rounded-lg border-2 border-dashed cursor-pointer transition-colors select-none outline-none
        ${dragging ? "border-primary bg-primary/8 text-primary" : "border-border hover:border-primary/50 hover:bg-muted/30 text-muted-foreground"}`}
    >
      <Upload size={28} />
      <div className="text-center">
        <p className="text-sm font-medium">Drop chart screenshots here</p>
        <p className="text-xs mt-1">or click to browse · Ctrl+V to paste · PNG, JPG, WebP · multiple supported</p>
      </div>
      <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" multiple className="hidden"
        onChange={e => { if (e.target.files) processFiles(e.target.files); }} />
    </div>
  );
}

// ── Stage definitions ──────────────────────────────────────────────

type Phase = "idle" | "uploading" | "vision" | "decision" | "done" | "error";

// Each stage advances automatically after `autoAdvanceMs` if the request hasn't
// completed yet. When the response arrives, all remaining stages complete instantly.
const ANALYSIS_STAGES: { label: string; autoAdvanceMs: number }[] = [
  { label: "Loading Vision Model",           autoAdvanceMs: 6_000  },
  { label: "Reading Screenshot",             autoAdvanceMs: 18_000 },
  { label: "Detecting Candlestick Patterns", autoAdvanceMs: 32_000 },
  { label: "Detecting Support & Resistance", autoAdvanceMs: 50_000 },
  { label: "Detecting Trend Structure",      autoAdvanceMs: 72_000 },
  { label: "Comparing Historical Memory",    autoAdvanceMs: 95_000 },
  { label: "Running Decision Engine",        autoAdvanceMs: 130_000 },
  { label: "Generating Trade Plan",          autoAdvanceMs: 999_999 }, // completes only when response arrives
];

// ── Stage tracker component ────────────────────────────────────────

function StageTracker({
  stageIndex,
  done,
  totalElapsedSec,
  queuePos,
  queueLen,
}: {
  stageIndex: number;
  done: boolean;
  totalElapsedSec: number;
  queuePos: number;
  queueLen: number;
}) {
  const fmtTime = (s: number) =>
    s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;

  return (
    <div className="space-y-3">
      {queueLen > 1 && (
        <div className="text-[10px] text-muted-foreground text-center">
          Processing image {queuePos} of {queueLen}
        </div>
      )}

      {/* Stage list */}
      <div className="space-y-1.5">
        {ANALYSIS_STAGES.map((stage, i) => {
          const isComplete = done || i < stageIndex;
          const isActive   = !done && i === stageIndex;
          const isPending  = !done && i > stageIndex;
          return (
            <div key={stage.label} className="flex items-center gap-2.5">
              {/* dot */}
              <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 transition-all ${
                isComplete ? "bg-emerald-500" :
                isActive   ? "bg-primary animate-pulse ring-2 ring-primary/30" :
                "bg-muted"
              }`} />
              {/* label */}
              <span className={`text-xs transition-colors ${
                isComplete ? "text-emerald-400" :
                isActive   ? "text-foreground font-medium" :
                "text-muted-foreground/50"
              }`}>
                {stage.label}
              </span>
              {/* check mark */}
              {isComplete && (
                <CheckCircle size={10} className="text-emerald-500 ml-auto flex-shrink-0" />
              )}
              {isActive && (
                <span className="ml-auto text-[10px] text-primary/70 flex-shrink-0 font-mono animate-pulse">
                  running…
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Total elapsed */}
      <div className="flex items-center gap-2 pt-1 border-t border-border/50">
        <Clock size={10} className="text-muted-foreground" />
        <span className="text-[10px] text-muted-foreground font-mono">
          Elapsed: {fmtTime(totalElapsedSec)}
        </span>
        {totalElapsedSec > 30 && !done && (
          <span className="text-[10px] text-amber-400/70 ml-auto">
            Analysis in progress — please wait
          </span>
        )}
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────

interface AnalysisResult {
  analysis: ChartAnalysis;
  decision: AiDecision | null;
  matches: SimilarityMatch[];
  imageDataUrl: string;
}

export default function AiChartPage() {
  const [queue, setQueue]             = useState<QueuedImage[]>([]);
  const [processing, setProcessing]   = useState(false);
  const [phase, setPhase]             = useState<Phase>("idle");
  const [results, setResults]         = useState<AnalysisResult[]>([]);
  const [currentResult, setCurrentResult] = useState<AnalysisResult | null>(null);
  const [errorMsg, setErrorMsg]       = useState<string | null>(null);
  const [symbol, setSymbol]           = useState("");
  const [timeframe, setTimeframe]     = useState("5m");
  const [visionAvailable, setVisionAvailable] = useState<boolean | null>(null);
  const [visionModel, setVisionModel] = useState("qwen2.5-vl:7b");
  const [queuePos, setQueuePos]       = useState(0);

  // Live analysis state — updated on every 30 s poll after initial analysis
  const [liveDecision, setLiveDecision]   = useState<AiDecision | null>(null);
  const [liveUpdatedAt, setLiveUpdatedAt] = useState<Date | null>(null);
  const [livePolling, setLivePolling]     = useState(false);

  // 8-stage progress tracker
  const [stageIndex, setStageIndex]       = useState(0);
  const [totalElapsedSec, setTotalElapsedSec] = useState(0);

  const abortRef           = useRef<AbortController | null>(null);
  const liveIntervalRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedTimerRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const stageTimersRef     = useRef<ReturnType<typeof setTimeout>[]>([]);
  const visionAnalysisRef  = useRef<ChartAnalysis | null>(null);
  const recentQuery = useListChartAnalyses({ limit: 20 });

  useEffect(() => {
    fetch(`${BASE}/api/ai/status`)
      .then(r => r.ok ? r.json() : null)
      .then((d: { visionAvailable?: boolean; visionModel?: string } | null) => {
        if (d) {
          setVisionAvailable(d.visionAvailable ?? false);
          if (d.visionModel) setVisionModel(d.visionModel);
        }
      })
      .catch(() => setVisionAvailable(false));
  }, []);

  // ── Live polling ───────────────────────────────────────────────

  const stopLivePolling = useCallback(() => {
    if (liveIntervalRef.current) { clearInterval(liveIntervalRef.current); liveIntervalRef.current = null; }
    setLivePolling(false);
  }, []);

  // Cleanup on unmount
  useEffect(() => () => {
    stopLivePolling();
    if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    stageTimersRef.current.forEach(clearTimeout);
    stageTimersRef.current = [];
  }, [stopLivePolling]);

  const startLivePolling = useCallback((sym: string, tf: string, analysis: ChartAnalysis) => {
    stopLivePolling();
    const poll = async () => {
      try {
        const r = await fetch(`${BASE}/api/ai/decision-refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol: sym, timeframe: tf, visionAnalysis: analysis }),
        });
        if (!r.ok) return;
        const d = await r.json() as { ok: boolean; decision: AiDecision; updatedAt: string };
        if (d.ok) {
          setLiveDecision(d.decision);
          setLiveUpdatedAt(new Date(d.updatedAt));
        }
      } catch { /* best-effort */ }
    };
    void poll();
    liveIntervalRef.current = setInterval(() => void poll(), 30_000);
    setLivePolling(true);
  }, [stopLivePolling]);

  // ── Queue handlers ─────────────────────────────────────────────

  const handleImages = useCallback((imgs: QueuedImage[]) => {
    setQueue(prev => [...prev, ...imgs]);
  }, []);

  const removeFromQueue = useCallback((id: string) => {
    setQueue(prev => prev.filter(img => img.id !== id));
  }, []);

  // ── Stage timer helpers ────────────────────────────────────────

  const clearStageTimers = useCallback(() => {
    stageTimersRef.current.forEach(clearTimeout);
    stageTimersRef.current = [];
    if (elapsedTimerRef.current) { clearInterval(elapsedTimerRef.current); elapsedTimerRef.current = null; }
  }, []);

  const startStageTimers = useCallback(() => {
    clearStageTimers();
    setStageIndex(0);
    setTotalElapsedSec(0);

    // Elapsed-second counter
    elapsedTimerRef.current = setInterval(() => setTotalElapsedSec(s => s + 1), 1_000);

    // Schedule each stage auto-advance
    ANALYSIS_STAGES.forEach((stage, i) => {
      if (stage.autoAdvanceMs < 999_000) {
        const t = setTimeout(() => setStageIndex(prev => Math.max(prev, i + 1)), stage.autoAdvanceMs);
        stageTimersRef.current.push(t);
      }
    });
  }, [clearStageTimers]);

  // ── Main analysis pipeline ─────────────────────────────────────

  const handleAnalyze = useCallback(async () => {
    if (queue.length === 0 || processing) return;
    setProcessing(true);
    setResults([]);
    setCurrentResult(null);
    setErrorMsg(null);
    setLiveDecision(null);
    setLiveUpdatedAt(null);
    stopLivePolling();
    visionAnalysisRef.current = null;

    const sym   = symbol.trim().toUpperCase() || undefined;
    const tf    = timeframe || undefined;
    const total = queue.length;

    for (let i = 0; i < total; i++) {
      const img = queue[i];
      setQueuePos(i + 1);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        // Upload: convert image to base64 (fast, local)
        setPhase("uploading");
        const base64      = img.file ? await fileToBase64(img.file) : dataUrlToBase64(img.dataUrl);
        const thumbBase64 = await makeThumbnail(img.dataUrl);

        // Start the 8-stage animated tracker
        setPhase("vision");
        startStageTimers();

        const res = await fetch(`${BASE}/api/ai/analyze-chart`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // No AbortSignal — user explicitly wants no cancellation from timeout
          body: JSON.stringify({ imageBase64: base64, thumbnailBase64: thumbBase64, symbol: sym, timeframe: tf }),
        });

        // Response arrived — stop stage timers, complete all remaining stages
        clearStageTimers();
        setStageIndex(ANALYSIS_STAGES.length); // mark all done

        if (!res.ok) {
          const body = await res.text().catch(() => "");
          let msg = `HTTP ${res.status}`;
          try { msg = (JSON.parse(body) as { error?: string }).error ?? msg; } catch { /* ignore */ }
          throw new Error(msg);
        }

        const response = await res.json() as {
          ok: boolean;
          analysis: ChartAnalysis;
          decision?: AiDecision | null;
          historicalMatches?: SimilarityMatch[];
          error?: string;
        };
        if (!response.ok) throw new Error(response.error ?? "Analysis failed");

        const result: AnalysisResult = {
          analysis:    response.analysis,
          decision:    response.decision ?? null,
          matches:     response.historicalMatches ?? [],
          imageDataUrl: img.dataUrl,
        };

        visionAnalysisRef.current = response.analysis;
        setCurrentResult(result);
        setResults(prev => [...prev, result]);
        setPhase("done");

        if (sym) startLivePolling(sym, tf ?? "5m", response.analysis);
        if (i < total - 1) await new Promise(r => setTimeout(r, 800));
      } catch (err) {
        clearStageTimers();
        if ((err as Error).name === "AbortError") {
          setPhase("idle");
          setProcessing(false);
          setErrorMsg(null);
          return;
        }
        setPhase("error");
        setErrorMsg((err as Error).message ?? "Analysis failed");
        break;
      }
    }

    setProcessing(false);
    void recentQuery.refetch();
  }, [queue, processing, symbol, timeframe, recentQuery, stopLivePolling, startLivePolling, startStageTimers, clearStageTimers]);

  const handleCancel = useCallback(() => {
    // Note: we intentionally do NOT pass signal to the fetch, so abort here only
    // clears the local stage UI state — the server analysis continues running.
    clearStageTimers();
    stopLivePolling();
    setProcessing(false);
    setPhase("idle");
  }, [clearStageTimers, stopLivePolling]);

  const reset = useCallback(() => {
    clearStageTimers();
    stopLivePolling();
    setQueue([]);
    setPhase("idle");
    setResults([]);
    setCurrentResult(null);
    setErrorMsg(null);
    setQueuePos(0);
    setStageIndex(0);
    setTotalElapsedSec(0);
    setLiveDecision(null);
    setLiveUpdatedAt(null);
    visionAnalysisRef.current = null;
  }, [clearStageTimers, stopLivePolling]);

  // ── Render ─────────────────────────────────────────────────────

  const effectiveDecision = liveDecision ?? currentResult?.decision ?? null;

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-4 space-y-6 pb-8">

        {/* Header */}
        <div className="flex items-center gap-3">
          <Layers size={20} className="text-primary" />
          <div>
            <h1 className="text-lg font-bold">AI Chart Analyzer</h1>
            <p className="text-xs text-muted-foreground">
              Vision model reads charts · Decision engine produces trade plans · Live updates every 30 s
            </p>
          </div>
          {visionAvailable === false && (
            <div className="ml-auto flex items-center gap-1.5 text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1">
              <AlertTriangle size={12} />
              <span className="text-xs font-mono">Vision offline — pull {visionModel}</span>
            </div>
          )}
          {visionAvailable === true && (
            <div className="ml-auto flex items-center gap-1.5 text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 rounded px-2 py-1">
              <CheckCircle size={12} />
              <span className="text-xs font-mono">{visionModel}</span>
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="flex gap-3 items-end flex-wrap">
          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider block mb-1">Symbol</label>
            <input
              value={symbol}
              onChange={e => setSymbol(e.target.value)}
              placeholder="TSLA"
              className="bg-card border border-border rounded px-3 py-1.5 text-sm font-mono w-24 uppercase focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider block mb-1">Timeframe</label>
            <select
              value={timeframe}
              onChange={e => setTimeframe(e.target.value)}
              className="bg-card border border-border rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary/50"
            >
              {["1m","2m","5m","15m","30m","1h","2h","4h","1D","1W"].map(t => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Upload + queue */}
        {!processing && phase !== "done" && (
          <div className="space-y-3">
            <UploadZone onImages={handleImages} />

            {queue.length > 0 && (
              <div className="space-y-2">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Queue — {queue.length} image{queue.length > 1 ? "s" : ""}
                </div>
                <div className="flex flex-wrap gap-2">
                  {queue.map(img => (
                    <div key={img.id} className="relative group">
                      <img
                        src={img.dataUrl}
                        alt={img.name}
                        className="w-20 h-14 object-cover rounded border border-border"
                      />
                      <button
                        onClick={() => removeFromQueue(img.id)}
                        className="absolute -top-1.5 -right-1.5 bg-destructive text-white rounded-full w-4 h-4 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <X size={10} />
                      </button>
                      <div className="text-[9px] text-muted-foreground truncate max-w-[80px] text-center">{img.name}</div>
                    </div>
                  ))}
                </div>

                <button
                  onClick={handleAnalyze}
                  disabled={!visionAvailable}
                  className="flex items-center gap-2 bg-primary text-primary-foreground rounded px-4 py-2 text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Brain size={16} />
                  Analyze {queue.length > 1 ? `${queue.length} Charts` : "Chart"}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Progress — shown while analysis is running */}
        {processing && (
          <div className="bg-card border border-border rounded p-5 space-y-4">
            {/* Stage tracker heading */}
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <Brain size={14} className="text-primary animate-pulse" />
                <span className="text-xs font-semibold text-foreground">
                  {phase === "uploading" ? "Preparing image…" : "Analyzing chart — please wait"}
                </span>
              </div>
              {phase !== "uploading" && (
                <span className="text-[10px] text-muted-foreground font-mono">
                  No timeout · retries up to 3×
                </span>
              )}
            </div>

            {phase === "uploading" ? (
              <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                <div className="h-full bg-primary animate-pulse rounded-full w-1/3" />
              </div>
            ) : (
              <StageTracker
                stageIndex={stageIndex}
                done={false}
                totalElapsedSec={totalElapsedSec}
                queuePos={queuePos}
                queueLen={queue.length}
              />
            )}

            {/* Contextual hints based on elapsed time */}
            {totalElapsedSec >= 10 && totalElapsedSec < 60 && (
              <p className="text-[10px] text-muted-foreground/70 italic">
                First run loads {visionModel} into GPU VRAM — this can take 1–5 min. Subsequent runs are faster.
              </p>
            )}
            {totalElapsedSec >= 60 && (
              <p className="text-[10px] text-amber-400/70 italic">
                Large chart or complex scene — the vision model is working. Will retry automatically up to 3× if needed.
              </p>
            )}
          </div>
        )}

        {/* Error */}
        {phase === "error" && errorMsg && (
          <div className="bg-destructive/10 border border-destructive/30 rounded p-4 flex items-center justify-between">
            <span className="text-sm text-destructive">{errorMsg}</span>
            <button onClick={reset} className="text-xs underline text-muted-foreground">Reset</button>
          </div>
        )}

        {/* Result(s) */}
        {currentResult && !processing && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CheckCircle size={14} className="text-emerald-400" />
                <span className="text-sm font-semibold">
                  {results.length > 1 ? `${results.length} analyses complete` : "Analysis complete"}
                </span>
                {livePolling && (
                  <span className="flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 animate-pulse">
                    <Radio size={8} /> LIVE
                  </span>
                )}
                {liveUpdatedAt && (
                  <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                    <RefreshCw size={9} />
                    {liveUpdatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </span>
                )}
              </div>
              <button onClick={reset} className="text-xs text-muted-foreground underline hover:text-foreground">
                Analyze more
              </button>
            </div>

            {results.length > 1 ? (
              <div className="space-y-6">
                {results.map((r, i) => (
                  <div key={i} className="space-y-2">
                    <div className="text-xs font-semibold text-muted-foreground">Image {i + 1}</div>
                    <ResultCard
                      analysis={r.analysis}
                      decision={i === results.length - 1 ? effectiveDecision : r.decision}
                      matches={r.matches}
                      imageDataUrl={r.imageDataUrl}
                      isLive={i === results.length - 1 && livePolling}
                      liveUpdatedAt={i === results.length - 1 ? liveUpdatedAt : null}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <ResultCard
                analysis={currentResult.analysis}
                decision={effectiveDecision}
                matches={currentResult.matches}
                imageDataUrl={currentResult.imageDataUrl}
                isLive={livePolling}
                liveUpdatedAt={liveUpdatedAt}
              />
            )}
          </div>
        )}

        {/* Recent analyses */}
        {(recentQuery.data?.length ?? 0) > 0 && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <Eye size={12} />
              Recent Analyses
            </div>
            <div className="space-y-2">
              {recentQuery.data!.map(item => (
                <RecentCard key={item.id} item={item} />
              ))}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
