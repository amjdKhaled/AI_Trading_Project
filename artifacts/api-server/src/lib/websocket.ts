import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { db, signalsTable, symbolsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { FinnhubStream, fetchCandles, type OhlcvBar } from "./finnhub";
import { scoreSignal } from "./indicators";

interface WsClient {
  ws: WebSocket;
  symbol: string;
}

const clients: Set<WsClient> = new Set();

function broadcast(symbol: string, message: object) {
  const data = JSON.stringify(message);
  for (const client of clients) {
    if (client.symbol === symbol && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(data);
    }
  }
}

function broadcastAll(message: object) {
  const data = JSON.stringify(message);
  for (const client of clients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(data);
    }
  }
}

// ─── Per-symbol 5m bar builder ───────────────────────────────────────────────

interface LiveBar {
  time: number; // 5m-aligned unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Rolling 200-bar history per symbol for signal scoring
const barHistory = new Map<string, OhlcvBar[]>();
const liveBar = new Map<string, LiveBar>();

function onTrade(symbol: string, price: number, volume: number, ts: number) {
  const barTime = ts - (ts % 300); // snap to 5m boundary

  const existing = liveBar.get(symbol);
  if (!existing || existing.time !== barTime) {
    // New bar started — finalize old one
    if (existing) {
      const finalized: OhlcvBar = { ...existing };
      // Append to history
      const hist = barHistory.get(symbol) ?? [];
      hist.push(finalized);
      if (hist.length > 300) hist.shift();
      barHistory.set(symbol, hist);

      broadcast(symbol, { type: "bar.final", symbol, ...finalized });

      // Run signal engine on bar close
      analyzeAndEmit(symbol, hist).catch((err) =>
        logger.warn({ err }, "Signal engine error"),
      );
    }

    const bar: LiveBar = {
      time: barTime,
      open: price,
      high: price,
      low: price,
      close: price,
      volume,
    };
    liveBar.set(symbol, bar);
  } else {
    // Update current bar
    existing.high = Math.max(existing.high, price);
    existing.low = Math.min(existing.low, price);
    existing.close = price;
    existing.volume += volume;
  }

  // Broadcast partial update
  const bar = liveBar.get(symbol)!;
  broadcast(symbol, { type: "bar.partial", symbol, ...bar });
}

// ─── Signal engine ───────────────────────────────────────────────────────────

async function analyzeAndEmit(symbol: string, hist: OhlcvBar[]) {
  if (hist.length < 30) return;

  const scored = scoreSignal(hist);
  if (!scored.side) return;

  const last = hist[hist.length - 1];
  const atrVal = scored.atrVal;
  const sl =
    scored.side === "long"
      ? last.close - atrVal * 1.5
      : last.close + atrVal * 1.5;
  const tp =
    scored.side === "long"
      ? last.close + atrVal * 3
      : last.close - atrVal * 3;
  const rr =
    Math.round((Math.abs(tp - last.close) / Math.abs(last.close - sl)) * 100) /
    100;
  const riskTag =
    scored.confidence >= 80
      ? "Safe"
      : scored.confidence >= 70
        ? "Medium"
        : "Danger";
  const signalId = `SIG-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  try {
    await db.insert(signalsTable).values({
      signalId,
      symbol,
      timeframe: "5m",
      barTime: new Date(last.time * 1000),
      side: scored.side,
      entryPrice: last.close,
      slPrice: Math.round(sl * 100) / 100,
      tpPrice: Math.round(tp * 100) / 100,
      currentSlPrice: Math.round(sl * 100) / 100,
      confidence: scored.confidence,
      riskTag,
      state: "active",
      rrRatio: rr,
      pattern: scored.pattern,
      regime: scored.regime,
    });

    broadcast(symbol, {
      type: "signal.new",
      signalId,
      symbol,
      side: scored.side,
      entryPrice: last.close,
      slPrice: Math.round(sl * 100) / 100,
      tpPrice: Math.round(tp * 100) / 100,
      confidence: scored.confidence,
      riskTag,
      barTime: new Date(last.time * 1000).toISOString(),
    });

    logger.info({ symbol, side: scored.side, confidence: scored.confidence, pattern: scored.pattern }, "Signal emitted");
  } catch (err) {
    logger.warn({ err }, "Failed to insert signal");
  }
}

// ─── Warm up bar history from Finnhub REST ───────────────────────────────────

async function warmHistory(symbol: string) {
  try {
    const to = Math.floor(Date.now() / 1000);
    const from = to - 5 * 24 * 60 * 60; // 5 days back
    const bars = await fetchCandles(symbol, from, to);
    if (bars.length > 0) {
      barHistory.set(symbol, bars.slice(-300));
      logger.info({ symbol, count: bars.length }, "Warmed bar history");
    }
  } catch (err) {
    logger.warn({ err, symbol }, "Failed to warm bar history");
  }
}

// ─── Finnhub stream singleton ─────────────────────────────────────────────────

let stream: FinnhubStream | null = null;
const subscribedSymbols = new Set<string>();

function ensureSubscribed(symbol: string) {
  if (subscribedSymbols.has(symbol)) return;
  subscribedSymbols.add(symbol);
  if (!stream) {
    stream = new FinnhubStream(onTrade);
  }
  stream.subscribe(symbol);
  warmHistory(symbol).catch(() => {});
}

// ─── WebSocket server ─────────────────────────────────────────────────────────

export function setupWebSocket(server: Server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "/ws", "http://localhost");
    const symbol = (url.searchParams.get("symbol") ?? "NVDA").toUpperCase();
    const client: WsClient = { ws, symbol };
    clients.add(client);
    logger.info({ symbol }, "WebSocket client connected");

    ensureSubscribed(symbol);

    ws.send(
      JSON.stringify({
        type: "subscribed",
        symbol,
        tf: "5m",
        lastBarTime: new Date().toISOString(),
      }),
    );

    // Send latest partial bar if available
    const current = liveBar.get(symbol);
    if (current) {
      ws.send(JSON.stringify({ type: "bar.partial", symbol, ...current }));
    }

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          op?: string;
          symbol?: string;
          tf?: string;
        };
        if (msg.op === "subscribe" && msg.symbol) {
          const newSym = msg.symbol.toUpperCase();
          client.symbol = newSym;
          ensureSubscribed(newSym);
          ws.send(
            JSON.stringify({
              type: "subscribed",
              symbol: newSym,
              tf: msg.tf ?? "5m",
            }),
          );
        }
      } catch {
        // ignore
      }
    });

    ws.on("close", () => {
      clients.delete(client);
      logger.info({ symbol }, "WebSocket client disconnected");
    });

    ws.on("error", (err) => {
      logger.warn({ err }, "WebSocket error");
      clients.delete(client);
    });
  });

  logger.info("WebSocket server attached at /ws");
  return wss;
}
