// ============================================================
// One-time migration: reads memory/trades.json and inserts records
// into the new ai_lessons and ai_patterns DB tables.
// Safe to run multiple times — duplicate signalIds are skipped.
// ============================================================

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
// Import schema-only (no DB pool init — safe before DATABASE_URL is loaded)
import * as schema from "@workspace/db/schema";

const { Pool } = pg;

// ── Load .env FIRST before any code that needs DATABASE_URL ──
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../../");
const envPath = path.join(ROOT, ".env");
if (fs.existsSync(envPath)) {
  const envText = fs.readFileSync(envPath, "utf-8");
  for (const line of envText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
}

if (!process.env.DATABASE_URL) {
  console.error("❌  DATABASE_URL not set. Create a .env file or export DATABASE_URL.");
  process.exit(1);
}

interface TradeMemoryEntry {
  id: string;
  timestamp: string;
  symbol: string;
  timeframe: string;
  side: string;
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
  outcome: string;
  volumeState: string;
  structureState: string;
  patterns: string[];
  atrPct?: number;
  lesson?: string;
  weaknesses?: string[];
  trapType?: string | null;
  continuationProbability?: number;
}

interface MemoryStore {
  trades: TradeMemoryEntry[];
}

function inferFailureCategory(trade: TradeMemoryEntry): typeof schema.aiLessonsTable.$inferInsert.failureCategory {
  if (trade.outcome === "tp_hit") return "unknown";
  if (trade.trapType === "fake_breakout" || trade.trapType === "false_breakout") return "false_breakout";
  if (trade.trapType === "liquidity_sweep") return "weak_volume";
  if (trade.trapType === "counter_trend") return "trend_reversal";
  const lesson = (trade.lesson ?? "").toLowerCase();
  if (lesson.includes("news")) return "news_issue";
  if (lesson.includes("entry")) return "bad_entry";
  if (lesson.includes("risk")) return "poor_risk";
  if (lesson.includes("volume")) return "weak_volume";
  if (lesson.includes("pattern")) return "pattern_failure";
  if (lesson.includes("regime")) return "regime_mismatch";
  if (lesson.includes("confidence")) return "incorrect_confidence";
  return "unknown";
}

async function main(): Promise<void> {
  // Create pool and db AFTER env is loaded
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool, { schema });

  const memPath = path.join(ROOT, "memory", "trades.json");

  if (!fs.existsSync(memPath)) {
    console.log("ℹ️  memory/trades.json not found — nothing to migrate.");
    await pool.end();
    return;
  }

  const raw = fs.readFileSync(memPath, "utf-8");
  const store = JSON.parse(raw) as MemoryStore;
  const trades = store.trades ?? [];

  console.log(`📂  Found ${trades.length} trades in memory/trades.json`);

  let lessonsInserted = 0;
  let patternsInserted = 0;
  let skipped = 0;

  for (const trade of trades) {
    if (!trade.id || !trade.symbol || !trade.outcome) {
      skipped++;
      continue;
    }

    // ── ai_lessons ───────────────────────────────────────────
    try {
      await db.insert(schema.aiLessonsTable).values({
        signalId:                trade.id,
        symbol:                  trade.symbol,
        side:                    trade.side,
        strategy:                trade.strategy,
        regime:                  trade.regime,
        session:                 trade.session,
        htfBias:                 trade.htfBias ?? "neutral",
        outcome:                 trade.outcome,
        lesson:                  trade.lesson ?? `${trade.strategy} ${trade.side} in ${trade.regime}: ${trade.outcome}`,
        weaknesses:              trade.weaknesses ?? [],
        failureCategory:         inferFailureCategory(trade),
        trapType:                trade.trapType ?? null,
        continuationProbability: trade.continuationProbability ?? 0.5,
        reasoning:               "",
        confidence:              trade.confidence,
        grade:                   trade.grade,
        rrRatio:                 trade.rrRatio,
        entryPrice:              trade.entryPrice,
        exitPrice:               trade.exitPrice ?? null,
      });
      lessonsInserted++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("duplicate") && !msg.includes("unique")) {
        console.warn(`  ⚠️  ai_lessons insert failed for ${trade.id}: ${msg}`);
      } else {
        skipped++;
      }
    }

    // ── ai_patterns ──────────────────────────────────────────
    try {
      await db.insert(schema.aiPatternsTable).values({
        signalId:       trade.id,
        symbol:         trade.symbol,
        regime:         trade.regime,
        side:           trade.side,
        strategy:       trade.strategy,
        patternTags:    trade.patterns ?? [],
        session:        trade.session,
        htfBias:        trade.htfBias ?? "neutral",
        outcome:        trade.outcome,
        confidence:     trade.confidence,
        rrRatio:        trade.rrRatio,
        entryPrice:     trade.entryPrice,
        exitPrice:      trade.exitPrice ?? null,
        atrPct:         trade.atrPct ?? null,
        volumeState:    trade.volumeState,
        structureState: trade.structureState,
      });
      patternsInserted++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("duplicate") && !msg.includes("unique")) {
        console.warn(`  ⚠️  ai_patterns insert failed for ${trade.id}: ${msg}`);
      }
    }
  }

  console.log(`\n✅  Migration complete:`);
  console.log(`   ai_lessons  inserted: ${lessonsInserted}`);
  console.log(`   ai_patterns inserted: ${patternsInserted}`);
  console.log(`   skipped: ${skipped}`);

  await pool.end();
}

main().catch(err => {
  console.error("❌  Migration failed:", err);
  process.exit(1);
});
