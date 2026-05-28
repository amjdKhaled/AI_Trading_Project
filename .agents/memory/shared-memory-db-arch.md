---
name: Shared memory DB architecture
description: Four new DB tables replace the flat JSON trade memory; JSON kept as read-only fallback.
---

# Shared Memory DB Architecture

## The rule
All AI memory writes go to DB (ai_lessons + ai_patterns) AND to the JSON file for backward compatibility. All AI memory reads try DB first, fall back to JSON on error.

**Why:** JSON was the original trade memory store. The DB tables were added as a proper relational store. Both are written on every reflect call so the JSON remains a valid bootstrap/import fallback.

**How to apply:** When adding new memory writes, call `appendTradeToDb(entry)` from `shared-memory.ts` AND `appendTrade(entry)` from `memory.ts`. Do not remove the JSON write path until all consumers are confirmed DB-only.

## Tables

| Table | Purpose |
|-------|---------|
| `ai_lessons` | Structured post-trade lessons; one row per closed signal. Has `failureCategory` enum (10 values). |
| `ai_patterns` | Historical setup library; one row per signal for similarity search. No unique constraint on signalId — multiple patterns per signal are possible. |
| `ai_market_regimes` | Time-series regime snapshots. Schema exists but NOT yet auto-populated. |
| `ai_chart_analyses` | Vision model (qwen2.5-vl:7b) outputs. Stored per analyze-chart call. |

## Key modules

- `lib/db/src/schema/ai-memory.ts` — Drizzle table definitions + `failureCategoryEnum`
- `artifacts/api-server/src/lib/ai/shared-memory.ts` — read/write surface; all DB functions are async
- `artifacts/api-server/src/lib/ai/memory.ts` — original JSON file store; kept as read-only fallback

## Migration

`scripts/src/migrate-memory.ts` reads `memory/trades.json` and bulk-inserts into ai_lessons + ai_patterns. Safe to run multiple times — skips on duplicate errors. Migrated 252 trades on initial run.
