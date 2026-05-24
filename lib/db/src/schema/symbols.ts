import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const symbolsTable = pgTable("symbols", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull().unique(),
  name: text("name").notNull(),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertSymbolSchema = createInsertSchema(symbolsTable).omit({ id: true, addedAt: true });
export type InsertSymbol = z.infer<typeof insertSymbolSchema>;
export type Symbol = typeof symbolsTable.$inferSelect;
