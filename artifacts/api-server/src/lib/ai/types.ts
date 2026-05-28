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

export interface AiReflection {
  outcome: "tp_hit" | "sl_hit" | "expired";
  lesson: string;
  weaknesses: string[];
  trapType: string | null;
  continuationProbability: number;
  reasoning: string;
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
