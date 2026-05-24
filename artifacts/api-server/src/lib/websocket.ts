import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { db, signalsTable, symbolsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

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

function generateSimulatedBar(symbol: string) {
  const basePrice: Record<string, number> = {
    NVDA: 1048, AAPL: 195, AMD: 168, MSFT: 430,
    TSLA: 285, AMZN: 196, META: 590, QQQ: 488,
  };
  const seed = symbol.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const base = basePrice[symbol] ?? 100 + (seed % 400);
  const move = (Math.random() - 0.485) * base * 0.006;
  const open = base;
  const close = Math.max(open + move, open * 0.97);
  const high = Math.max(open, close) * (1 + Math.random() * 0.003);
  const low = Math.min(open, close) * (1 - Math.random() * 0.003);
  const now = Math.floor(Date.now() / 1000);
  return {
    time: now - (now % 300),
    open: Math.round(open * 100) / 100,
    high: Math.round(high * 100) / 100,
    low: Math.round(low * 100) / 100,
    close: Math.round(close * 100) / 100,
    volume: Math.floor(100000 + Math.random() * 900000),
  };
}

const PATTERNS = ["orb_retest_reclaim", "trend_continuation", "mean_reversion_reclaim", "vwap_bounce", "hl_breakout"];
const REGIMES = ["trend_up", "trend_down", "range", "volatile"];
const RISK_TAGS = ["Safe", "Medium", "Danger"] as const;

async function maybeEmitSignal(symbol: string) {
  if (Math.random() > 0.15) return; // ~15% chance per bar
  const bar = generateSimulatedBar(symbol);
  const side = Math.random() > 0.5 ? "long" : "short";
  const atr = bar.close * 0.002;
  const sl = side === "long" ? bar.close - atr * 1.5 : bar.close + atr * 1.5;
  const tp = side === "long" ? bar.close + atr * 3 : bar.close - atr * 3;
  const confidence = Math.floor(60 + Math.random() * 35);
  const riskTag = confidence >= 80 ? "Safe" : confidence >= 70 ? "Medium" : "Danger";
  const rr = Math.round((Math.abs(tp - bar.close) / Math.abs(bar.close - sl)) * 100) / 100;

  const signalId = `SIG-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  try {
    await db.insert(signalsTable).values({
      signalId,
      symbol,
      timeframe: "5m",
      barTime: new Date(bar.time * 1000),
      side,
      entryPrice: bar.close,
      slPrice: Math.round(sl * 100) / 100,
      tpPrice: Math.round(tp * 100) / 100,
      currentSlPrice: Math.round(sl * 100) / 100,
      confidence,
      riskTag,
      state: "active",
      rrRatio: rr,
      pattern: PATTERNS[Math.floor(Math.random() * PATTERNS.length)],
      regime: REGIMES[Math.floor(Math.random() * REGIMES.length)],
    });

    broadcast(symbol, {
      type: "signal.new",
      signalId,
      symbol,
      side,
      entryPrice: bar.close,
      slPrice: Math.round(sl * 100) / 100,
      tpPrice: Math.round(tp * 100) / 100,
      confidence,
      riskTag,
      barTime: new Date(bar.time * 1000).toISOString(),
    });
  } catch (err) {
    logger.warn({ err }, "Failed to insert simulated signal");
  }
}

let simulationInterval: ReturnType<typeof setInterval> | null = null;

function startSimulation() {
  if (simulationInterval) return;
  simulationInterval = setInterval(async () => {
    if (clients.size === 0) return;
    const activeSymbols = new Set<string>();
    for (const c of clients) activeSymbols.add(c.symbol);

    for (const symbol of activeSymbols) {
      const bar = generateSimulatedBar(symbol);
      broadcast(symbol, { type: "bar.partial", symbol, ...bar });

      // Every ~5 ticks emit a final bar
      if (Math.random() > 0.8) {
        broadcast(symbol, { type: "bar.final", symbol, ...bar });
        await maybeEmitSignal(symbol);
      }
    }
  }, 3000);
}

export function setupWebSocket(server: Server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "/ws", "http://localhost");
    const symbol = url.searchParams.get("symbol") ?? "NVDA";
    const client: WsClient = { ws, symbol };
    clients.add(client);
    logger.info({ symbol }, "WebSocket client connected");

    ws.send(JSON.stringify({
      type: "subscribed",
      symbol,
      tf: "5m",
      lastBarTime: new Date().toISOString(),
    }));

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.op === "subscribe" && msg.symbol) {
          client.symbol = msg.symbol;
          ws.send(JSON.stringify({ type: "subscribed", symbol: msg.symbol, tf: msg.tf ?? "5m" }));
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

    startSimulation();
  });

  logger.info("WebSocket server attached at /ws");
  return wss;
}
