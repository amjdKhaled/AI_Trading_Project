export interface TradeMemoryEntry {
  id: string;
  timestamp: string;
  symbol: string;
  timeframe: string;
  side: "long" | "short";
  strategy: string;
  regime: string;
  session: string;
  htfBias: string;
  confluenceCount: number;
  confidence: number;
  grade: string;
  riskLevel: string;
  rrRatio: number;
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  exitPrice: number | null;
  outcome: "tp_hit" | "sl_hit" | "expired";
  volumeState: string;
  structureState: string;
  patterns: string[];
  atrPct?: number;
  efRatio?: number;
  lesson?: string;
  weaknesses?: string[];
  trapType?: string | null;
  continuationProbability?: number;
  failureCategory?: FailureCategory;
  reasoning?: string;
}

export interface AiSignalVerdict {
  approved: boolean;
  confidence: number;
  continuationProbability: number;
  trapProbability: number;
  setupQuality: "excellent" | "good" | "marginal" | "poor";
  reasoning: string;
  warnings: string[];
  lessons: string[];
}

export type FailureCategory =
  | "news_issue"
  | "bad_entry"
  | "poor_risk"
  | "pattern_failure"
  | "false_breakout"
  | "weak_volume"
  | "trend_reversal"
  | "regime_mismatch"
  | "incorrect_confidence"
  | "entry_timing"
  | "stop_placement"
  | "takeprofit_placement"
  | "support_resistance_failure"
  | "trend_structure_break"
  | "unknown";

export interface AiReflection {
  outcome: "tp_hit" | "sl_hit" | "expired";
  lesson: string;
  weaknesses: string[];
  trapType: string | null;
  continuationProbability: number;
  reasoning: string;
  failureCategory?: FailureCategory;
}

export interface AiDecision {
  decision: "BUY" | "SELL" | "NO_TRADE";
  confidence: number;        // 0–100
  entry: number;
  stopLoss: number;
  takeProfit: number;
  riskReward: number;
  reasoning: string;
  marketBias: "BULLISH" | "BEARISH" | "NEUTRAL";
}

// ── Candle-close AI decision (APPROVE / REJECT / WAIT) ───────────────────────
// Produced by filterCandleWithAi() after every candle close.
// Stored in ai_decisions table and broadcast to the frontend for chart display.
export type CandleVerdict = "APPROVE" | "REJECT" | "WAIT";

export interface AiCandleDecision {
  symbol:           string;
  timeframe:        string;
  candleTime:       number;              // epoch seconds — the CLOSED candle
  candidateSide:    "long" | "short" | "no_trade";
  verdict:          CandleVerdict;
  confidence:       number;              // 0–100; < 80 → forced WAIT
  entryPrice:       number | null;
  slPrice:          number | null;
  tpPrice:          number | null;
  invalidationLevel:number | null;       // price that voids the setup
  rrRatio:          number | null;
  aiReasoning:      string;
  rejectionReason:  string | null;
  newsSentiment:    "bullish" | "bearish" | "neutral";
  newsSummary:      string;
  regime:           string;
  htfBias:          string;
  session:          string;
  patterns:         string[];
  strengths:        string[];
  weaknesses:       string[];
  marketBias:       "bullish" | "bearish" | "neutral";
  technicalContext: Record<string, unknown>;
  memoryUsed?:           boolean;
  lessonsLoaded?:        number;
  winnerAnalysisLoaded?: boolean;
  failureStatsLoaded?:   boolean;
  recentLossLoaded?:     boolean;
  memoryImpactScore?:    number;
}

export interface MemoryStore {
  version: number;
  updatedAt: string;
  totalTrades: number;
  trades: TradeMemoryEntry[];
  regimeStats: Record<string, { wins: number; losses: number; total: number }>;
  strategyStats: Record<string, { wins: number; losses: number; total: number }>;
  symbolStats: Record<string, { wins: number; losses: number; total: number }>;
  recentLessons: string[];
}
