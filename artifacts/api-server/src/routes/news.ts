import { Router, type IRouter } from "express";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const REST_BASE = "https://api.polygon.io";
const apiKey    = () => process.env.POLYGON_API_KEY ?? "";

// 3-minute in-memory cache per symbol — avoids hammering Polygon on rapid
// symbol switches while keeping headlines reasonably fresh.
const NEWS_TTL_MS = 3 * 60 * 1_000;
const newsCache   = new Map<string, { data: NewsItem[]; expiresAt: number }>();

interface PolygonNewsResult {
  title?:         string;
  published_utc?: string;
  article_url?:   string;
  publisher?:     { name?: string };
  tickers?:       string[];
  description?:   string;
}
interface PolygonNewsResp {
  results?: PolygonNewsResult[];
  status?:  string;
}

interface NewsItem {
  title:        string;
  publishedUtc: string;
  articleUrl:   string;
  source:       string;
  tickers:      string[];
}

async function fetchNews(symbol: string, limit: number): Promise<NewsItem[]> {
  const cached = newsCache.get(symbol);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const url = new URL(`${REST_BASE}/v2/reference/news`);
  url.searchParams.set("ticker",     symbol);
  url.searchParams.set("limit",      String(limit));
  url.searchParams.set("order",      "desc");
  url.searchParams.set("sort",       "published_utc");
  url.searchParams.set("apiKey",     apiKey());

  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
    signal:  AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Polygon news HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as PolygonNewsResp;
  const items: NewsItem[] = (data.results ?? []).map((r) => ({
    title:        r.title        ?? "(no title)",
    publishedUtc: r.published_utc ?? new Date().toISOString(),
    articleUrl:   r.article_url  ?? "",
    source:       r.publisher?.name ?? "Unknown",
    tickers:      r.tickers ?? [],
  }));

  newsCache.set(symbol, { data: items, expiresAt: Date.now() + NEWS_TTL_MS });
  return items;
}

router.get("/news", async (req, res): Promise<void> => {
  const symbol = String(req.query.symbol ?? "").toUpperCase().trim();
  const limit  = Math.min(Number(req.query.limit ?? 10), 50);

  if (!symbol || symbol.length > 12) {
    res.status(400).json({ error: "symbol is required and must be ≤12 chars" });
    return;
  }

  try {
    const items = await fetchNews(symbol, limit);
    req.log?.info({ symbol, count: items.length }, "news served");
    res.json(items);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ symbol, err: msg }, "news fetch failed");
    res.status(502).json({ error: "news fetch failed", message: msg });
  }
});

export default router;
