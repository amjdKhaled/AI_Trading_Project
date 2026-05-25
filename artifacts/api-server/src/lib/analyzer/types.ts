// ============================================================
// Market Analysis Engine — Shared Types
// ============================================================

export interface OhlcvBar {
  time: number;  // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Side = "long" | "short";
export type SignalGrade = "A+" | "A" | "B" | "Weak";
export type RiskLevel = "Safe" | "Medium" | "Danger";

export interface PatternDetection {
  name: string;
  type: "bullish" | "bearish" | "neutral";
  index: number;       // bar index where pattern was detected
  confidence: number;  // 0–100
}

export interface StructurePoint {
  index: number;
  time: number;
  price: number;
  type: "HH" | "HL" | "LH" | "LL" | "swing-high" | "swing-low";
}

export interface VolumeAnalysis {
  rvol: number;                // relative volume (1.0 = avg)
  spike: boolean;
  climax: boolean;
  absorption: boolean;
  breakoutVol: boolean;
  distribution: boolean;
  accumulation: boolean;
}

export interface TrendState {
  direction: "up" | "down" | "sideways";
  strength: number;   // 0–100
  emaAligned: boolean;
  pullbackQuality: number; // 0–100
  exhaustion: boolean;
}

export interface VolatilityState {
  atr: number;
  expanding: boolean;
  contracting: boolean;
  compression: boolean;
  breakoutProbability: number; // 0–100
}

export interface MomentumState {
  rsi: number;
  macdHist: number;
  divergence: "bullish" | "bearish" | "none";
  hiddenDivergence: "bullish" | "bearish" | "none";
  accelerating: boolean;
  strength: number; // 0–100
}

export interface SignalCandidate {
  side: Side;
  barIndex: number;
  time: number;
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  confidence: number;       // raw 0–100
  grade: SignalGrade;
  riskLevel: RiskLevel;
  riskScore: number;       // 0–100 (higher = worse)
  patterns: string[];
  structureConfirm: boolean;
  volumeConfirm: boolean;
  trendConfirm: boolean;
  momentumConfirm: boolean;
  candleConfirm: boolean;
  volatilityOk: boolean;
}

export interface TradingSignal {
  id: string;
  side: Side;
  symbol: string;
  timeframe: string;
  barTime: number;
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  confidence: number;
  grade: SignalGrade;
  riskLevel: RiskLevel;
  patterns: string[];
  state: "active" | "tp_hit" | "sl_hit" | "expired";
  createdAt: string;
}
