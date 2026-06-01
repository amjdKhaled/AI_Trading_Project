// ============================================================
// Polygon.io News Sentiment — 20-minute in-memory cache
// Refreshed lazily on cache expiry. Never fetched per candle.
// Falls back to neutral/stale on any API error.
// ============================================================

import { logger } from "../logger.js";

export interface NewsSentiment {
  symbol:    string;
  sentiment: "bullish" | "bearish" | "neutral";
  score:     number;        // -1.0 to +1.0
  headlines: string[];
  summary:   string;
  cachedAt:  number;        // epoch ms
  stale:     boolean;       // true if this is a fallback from expired cache
}

interface PolygonNewsArticle {
  title?:       string;
  description?: string;
  insights?:    Array<{ sentiment?: string; sentiment_reasoning?: string }>;
}

const CACHE_TTL_MS = 22 * 60 * 1000;  // 22 minutes (user asked 20–30)
const cache        = new Map<string, NewsSentiment>();

function sentimentFromScore(score: number): "bullish" | "bearish" | "neutral" {
  if (score >  0.15) return "bullish";
  if (score < -0.15) return "bearish";
  return "neutral";
}

function scoreArticles(articles: PolygonNewsArticle[]): number {
  let total = 0, count = 0;
  for (const a of articles) {
    if (!a.insights?.length) continue;
    for (const ins of a.insights) {
      if (ins.sentiment === "positive") { total += 1; count++; }
      else if (ins.sentiment === "negative") { total -= 1; count++; }
    }
  }
  return count > 0 ? total / count : 0;
}

async function fetchFromPolygon(symbol: string): Promise<NewsSentiment> {
  const apiKey = (process.env.POLYGON_API_KEY ?? "").trim();
  const url    = `https://api.polygon.io/v2/reference/news?ticker=${encodeURIComponent(symbol)}&limit=5&apiKey=${apiKey}`;

  const resp = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!resp.ok) throw new Error(`Polygon news ${resp.status}`);

  const data = await resp.json() as { results?: PolygonNewsArticle[] };
  const articles = data.results ?? [];

  const headlines = articles.map(a => a.title ?? "").filter(Boolean).slice(0, 5);
  const score     = scoreArticles(articles);
  const sentiment = sentimentFromScore(score);
  const summary   = headlines.slice(0, 3).join(" | ") || "No recent news";

  return { symbol, sentiment, score, headlines, summary, cachedAt: Date.now(), stale: false };
}

/**
 * Get news sentiment for a symbol.
 * Uses the in-memory cache if within TTL.
 * On network failure returns the stale cache (marked stale:true) or a neutral default.
 * Never throws.
 */
export async function getNewsSentiment(symbol: string): Promise<NewsSentiment> {
  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached;
  }

  try {
    const fresh = await fetchFromPolygon(symbol);
    cache.set(symbol, fresh);
    logger.info({ symbol, sentiment: fresh.sentiment, articles: fresh.headlines.length }, "News cache refreshed");
    return fresh;
  } catch (err) {
    logger.warn({ symbol, err }, "News fetch failed — using stale/neutral");
    if (cached) return { ...cached, stale: true };
    const neutral: NewsSentiment = {
      symbol, sentiment: "neutral", score: 0,
      headlines: [], summary: "News unavailable",
      cachedAt: Date.now(), stale: true,
    };
    cache.set(symbol, neutral);
    return neutral;
  }
}

/** Force-clear cache for a symbol (useful for testing). */
export function invalidateNewsCache(symbol: string): void {
  cache.delete(symbol);
}
