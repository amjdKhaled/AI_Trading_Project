import fs from "fs";
import path from "path";
import { logger } from "../logger.js";
import type { MemoryStore, TradeMemoryEntry } from "./types.js";

const MEMORY_PATH = path.resolve(process.cwd(), "../../memory/trades.json");
const MAX_TRADES = 2000;
const MAX_LESSONS = 50;

const EMPTY_STORE: MemoryStore = {
  version: 1,
  updatedAt: "",
  totalTrades: 0,
  trades: [],
  regimeStats: {},
  strategyStats: {},
  symbolStats: {},
  recentLessons: [],
};

function readRaw(): MemoryStore {
  try {
    const text = fs.readFileSync(MEMORY_PATH, "utf-8");
    return JSON.parse(text) as MemoryStore;
  } catch {
    return structuredClone(EMPTY_STORE);
  }
}

function writeRaw(store: MemoryStore): void {
  store.updatedAt = new Date().toISOString();
  fs.writeFileSync(MEMORY_PATH, JSON.stringify(store, null, 2), "utf-8");
}

function updateStats(
  stats: Record<string, { wins: number; losses: number; total: number }>,
  key: string,
  won: boolean,
): void {
  if (!stats[key]) stats[key] = { wins: 0, losses: 0, total: 0 };
  stats[key].total++;
  if (won) stats[key].wins++; else stats[key].losses++;
}

export function loadMemory(): MemoryStore {
  return readRaw();
}

export function appendTrade(entry: TradeMemoryEntry): void {
  const store = readRaw();
  store.trades.unshift(entry);
  if (store.trades.length > MAX_TRADES) store.trades = store.trades.slice(0, MAX_TRADES);
  store.totalTrades++;

  const won = entry.outcome === "tp_hit";
  updateStats(store.regimeStats,   entry.regime,   won);
  updateStats(store.strategyStats, entry.strategy, won);
  updateStats(store.symbolStats,   entry.symbol,   won);

  if (entry.lesson) {
    store.recentLessons.unshift(entry.lesson);
    if (store.recentLessons.length > MAX_LESSONS) {
      store.recentLessons = store.recentLessons.slice(0, MAX_LESSONS);
    }
  }

  writeRaw(store);
  logger.info({ signalId: entry.id, outcome: entry.outcome }, "Trade memory updated");
}

export function getRelevantContext(
  symbol: string,
  regime: string,
  strategy: string,
  side: "long" | "short",
  limit = 8,
): TradeMemoryEntry[] {
  const store = readRaw();
  return store.trades
    .filter(t =>
      (t.symbol === symbol || t.regime === regime) &&
      t.side === side
    )
    .slice(0, limit);
}

export function getStrategyWinRate(strategy: string): number | null {
  const store = readRaw();
  const s = store.strategyStats[strategy];
  if (!s || s.total < 3) return null;
  return s.wins / s.total;
}

export function getRegimeWinRate(regime: string): number | null {
  const store = readRaw();
  const s = store.regimeStats[regime];
  if (!s || s.total < 3) return null;
  return s.wins / s.total;
}

export function getMemorySummary(): {
  totalTrades: number;
  regimeStats: MemoryStore["regimeStats"];
  strategyStats: MemoryStore["strategyStats"];
  symbolStats: MemoryStore["symbolStats"];
  recentLessons: string[];
  updatedAt: string;
} {
  const store = readRaw();
  return {
    totalTrades:   store.totalTrades,
    regimeStats:   store.regimeStats,
    strategyStats: store.strategyStats,
    symbolStats:   store.symbolStats,
    recentLessons: store.recentLessons,
    updatedAt:     store.updatedAt,
  };
}
