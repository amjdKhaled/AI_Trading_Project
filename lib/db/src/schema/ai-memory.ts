import { pgTable, text, serial, timestamp, integer, real, jsonb, boolean, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const failureCategoryEnum = pgEnum("failure_category", [
  "news_issue",
  "bad_entry",
  "poor_risk",
  "pattern_failure",
  "false_breakout",
  "weak_volume",
  "trend_reversal",
  "regime_mismatch",
  "incorrect_confidence",
  "entry_timing",
  "stop_placement",
  "takeprofit_placement",
  "support_resistance_failure",
  "trend_structure_break",
  "unknown",
]);

// ── ai_lessons ──────────────────────────────────────────────────
// Structured post-trade lessons written after each closed signal
export const aiLessonsTable = pgTable("ai_lessons", {
  id: serial("id").primaryKey(),
  signalId: text("signal_id").notNull(),
  symbol: text("symbol").notNull(),
  side: text("side").notNull(),
  strategy: text("strategy").notNull(),
  regime: text("regime").notNull(),
  session: text("session").notNull(),
  htfBias: text("htf_bias").notNull().default("neutral"),
  outcome: text("outcome").notNull(),
  lesson: text("lesson").notNull(),
  weaknesses: jsonb("weaknesses").$type<string[]>().notNull().default([]),
  failureCategory: failureCategoryEnum("failure_category").notNull().default("unknown"),
  trapType: text("trap_type"),
  continuationProbability: real("continuation_probability").notNull().default(0.5),
  reasoning: text("reasoning").notNull().default(""),
  confidence: integer("confidence").notNull().default(0),
  grade: text("grade").notNull().default("B"),
  rrRatio: real("rr_ratio").notNull().default(1),
  entryPrice: real("entry_price").notNull().default(0),
  exitPrice: real("exit_price"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertAiLessonSchema = createInsertSchema(aiLessonsTable).omit({ id: true, createdAt: true });
export type InsertAiLesson = z.infer<typeof insertAiLessonSchema>;
export type AiLesson = typeof aiLessonsTable.$inferSelect;

// ── ai_patterns ──────────────────────────────────────────────────
// Historical setup library — keyed by symbol + regime + side + pattern
export const aiPatternsTable = pgTable("ai_patterns", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  regime: text("regime").notNull(),
  side: text("side").notNull(),
  strategy: text("strategy").notNull(),
  patternTags: jsonb("pattern_tags").$type<string[]>().notNull().default([]),
  session: text("session").notNull().default("unknown"),
  htfBias: text("htf_bias").notNull().default("neutral"),
  outcome: text("outcome").notNull(),
  confidence: integer("confidence").notNull().default(0),
  rrRatio: real("rr_ratio").notNull().default(1),
  entryPrice: real("entry_price").notNull().default(0),
  exitPrice: real("exit_price"),
  durationBars: integer("duration_bars"),
  atrPct: real("atr_pct"),
  volumeState: text("volume_state").notNull().default("neutral"),
  structureState: text("structure_state").notNull().default("mixed"),
  signalId: text("signal_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertAiPatternSchema = createInsertSchema(aiPatternsTable).omit({ id: true, createdAt: true });
export type InsertAiPattern = z.infer<typeof insertAiPatternSchema>;
export type AiPattern = typeof aiPatternsTable.$inferSelect;

// ── ai_market_regimes ────────────────────────────────────────────
// Time-series regime snapshots per symbol
export const aiMarketRegimesTable = pgTable("ai_market_regimes", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  timeframe: text("timeframe").notNull().default("5m"),
  regime: text("regime").notNull(),
  htfBias: text("htf_bias").notNull().default("neutral"),
  atr: real("atr"),
  rsi: real("rsi"),
  macd: real("macd"),
  vwapDiff: real("vwap_diff"),
  snapshottedAt: timestamp("snapshotted_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertAiMarketRegimeSchema = createInsertSchema(aiMarketRegimesTable).omit({ id: true, snapshottedAt: true });
export type InsertAiMarketRegime = z.infer<typeof insertAiMarketRegimeSchema>;
export type AiMarketRegime = typeof aiMarketRegimesTable.$inferSelect;

// ── ai_chart_analyses ────────────────────────────────────────────
// Stores vision model (qwen2.5-vl:7b) + decision engine (qwen3:8b) outputs tied to a signal or standalone
export const aiChartAnalysesTable = pgTable("ai_chart_analyses", {
  id: serial("id").primaryKey(),
  signalId: text("signal_id"),
  symbol: text("symbol"),
  timeframe: text("timeframe"),
  trend: text("trend").notNull().default("neutral"),
  patterns: jsonb("patterns").$type<string[]>().notNull().default([]),
  resistanceLevels: jsonb("resistance_levels").$type<number[]>().notNull().default([]),
  supportLevels: jsonb("support_levels").$type<number[]>().notNull().default([]),
  volumeBehavior: text("volume_behavior").notNull().default("normal"),
  marketStructure: text("market_structure").notNull().default("unclear"),
  supplyZones: jsonb("supply_zones").$type<number[]>().notNull().default([]),
  demandZones: jsonb("demand_zones").$type<number[]>().notNull().default([]),
  summary: text("summary").notNull().default(""),
  confidence: integer("confidence").notNull().default(0),
  // Decision engine fields (qwen3:8b / fallback qwen2.5:7b) — nullable when Ollama is offline
  direction: text("direction"),
  entryPrice: real("entry_price"),
  slPrice: real("sl_price"),
  tpPrice: real("tp_price"),
  rrRatio: real("rr_ratio"),
  decisionConfidence: integer("decision_confidence"),
  successProbability: integer("success_probability"),
  technicalReasoning: text("technical_reasoning"),
  marketStructureReasoning: text("market_structure_reasoning"),
  historicalReasoning: text("historical_reasoning"),
  thumbnailBase64: text("thumbnail_base64"),
  rawResponse: text("raw_response"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertAiChartAnalysisSchema = createInsertSchema(aiChartAnalysesTable).omit({ id: true, createdAt: true });
export type InsertAiChartAnalysis = z.infer<typeof insertAiChartAnalysisSchema>;
export type AiChartAnalysis = typeof aiChartAnalysesTable.$inferSelect;

// ── ai_decisions ─────────────────────────────────────────────────────────────
// One row per candle-close AI decision — full pipeline output for each closed bar.
export const aiDecisionsTable = pgTable("ai_decisions", {
  id:                serial("id").primaryKey(),
  symbol:            text("symbol").notNull(),
  timeframe:         text("timeframe").notNull().default("5m"),
  candleTime:        timestamp("candle_time", { withTimezone: true }).notNull(),
  candidateSide:     text("candidate_side"),
  verdict:           text("verdict").notNull(),
  confidence:        integer("confidence").notNull().default(0),
  entryPrice:        real("entry_price"),
  slPrice:           real("sl_price"),
  tpPrice:           real("tp_price"),
  invalidationLevel: real("invalidation_level"),
  rrRatio:           real("rr_ratio"),
  technicalContext:  jsonb("technical_context").$type<Record<string, unknown>>(),
  aiReasoning:       text("ai_reasoning"),
  rejectionReason:   text("rejection_reason"),
  newsSummary:       text("news_summary"),
  newsSentiment:     text("news_sentiment"),
  regime:            text("regime"),
  htfBias:           text("htf_bias"),
  session:           text("session"),
  candidateScore:    integer("candidate_score"),
  patterns:          jsonb("patterns").$type<string[]>().notNull().default([]),
  outcome:           text("outcome"),
  outcomePrice:      real("outcome_price"),
  resolvedAt:        timestamp("resolved_at", { withTimezone: true }),
  reflected:         boolean("reflected").notNull().default(false),
  createdAt:         timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertAiDecisionSchema = createInsertSchema(aiDecisionsTable).omit({ id: true, createdAt: true });
export type InsertAiDecision = z.infer<typeof insertAiDecisionSchema>;
export type AiDecisionRow = typeof aiDecisionsTable.$inferSelect;
