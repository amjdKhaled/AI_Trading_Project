import { pgTable, text, serial, timestamp, integer, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const signalsTable = pgTable("signals", {
  id: serial("id").primaryKey(),
  signalId: text("signal_id").notNull().unique(),
  symbol: text("symbol").notNull(),
  timeframe: text("timeframe").notNull().default("5m"),
  barTime: timestamp("bar_time", { withTimezone: true }).notNull(),
  side: text("side").notNull(), // 'long' | 'short'
  entryPrice: real("entry_price").notNull(),
  slPrice: real("sl_price").notNull(),
  tpPrice: real("tp_price").notNull(),
  currentSlPrice: real("current_sl_price"),
  confidence: integer("confidence").notNull(),
  riskTag: text("risk_tag").notNull(), // 'Safe' | 'Medium' | 'Danger'
  state: text("state").notNull().default("active"), // 'active' | 'tp_hit' | 'sl_hit' | 'expired'
  exitPrice: real("exit_price"),
  exitReason: text("exit_reason"),
  exitBarTime: timestamp("exit_bar_time", { withTimezone: true }),
  rrRatio: real("rr_ratio"),
  pattern: text("pattern"),
  regime: text("regime"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertSignalSchema = createInsertSchema(signalsTable).omit({ id: true, createdAt: true });
export type InsertSignal = z.infer<typeof insertSignalSchema>;
export type Signal = typeof signalsTable.$inferSelect;
