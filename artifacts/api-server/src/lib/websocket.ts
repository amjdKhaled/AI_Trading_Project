import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
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

// Approximate recent market prices (yfinance auto-adjust, split-corrected)
const BASE_PRICES: Record<string, number> = {
  NVDA: 221,  AAPL: 202,  AMD: 110,  MSFT: 432,
  TSLA: 250,  AMZN: 196,  META: 598, QQQ: 492,
  SPY:  545,  GOOGL: 172, NFLX: 1110,
};

// Per-symbol last-price tracking so ticks are continuous
const lastClose: Record<string, number> = {};

function nextPrice(symbol: string): number {
  const base = BASE_PRICES[symbol] ?? 100 + (symbol.split("").reduce((a, c) => a + c.charCodeAt(0), 0) % 400);
  if (!lastClose[symbol]) lastClose[symbol] = base;
  const drift = (Math.random() - 0.49) * lastClose[symbol] * 0.0015;
  lastClose[symbol] = Math.max(lastClose[symbol] + drift, base * 0.85);
  return lastClose[symbol];
}

function generateBar(symbol: string) {
  const price  = nextPrice(symbol);
  const spread = price * 0.0012;
  const open   = price;
  const close  = Math.max(price + (Math.random() - 0.49) * spread, price * 0.998);
  const high   = Math.max(open, close) * (1 + Math.random() * 0.0008);
  const low    = Math.min(open, close) * (1 - Math.random() * 0.0008);
  const now    = Math.floor(Date.now() / 1000);
  return {
    time:   now - (now % 300),
    open:   Math.round(open  * 100) / 100,
    high:   Math.round(high  * 100) / 100,
    low:    Math.round(low   * 100) / 100,
    close:  Math.round(close * 100) / 100,
    volume: Math.floor(400_000 + Math.random() * 3_600_000),
  };
}

let simulationInterval: ReturnType<typeof setInterval> | null = null;

function startSimulation() {
  if (simulationInterval) return;
  simulationInterval = setInterval(() => {
    if (clients.size === 0) return;
    const active = new Set<string>();
    for (const c of clients) active.add(c.symbol);
    for (const symbol of active) {
      broadcast(symbol, { type: "bar.partial", symbol, ...generateBar(symbol) });
    }
  }, 3000);
}

export function setupWebSocket(server: Server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    const url    = new URL(req.url ?? "/ws", "http://localhost");
    const symbol = url.searchParams.get("symbol") ?? "NVDA";
    const client: WsClient = { ws, symbol };
    clients.add(client);
    logger.info({ symbol }, "WebSocket client connected");

    ws.send(JSON.stringify({ type: "subscribed", symbol, tf: "5m", lastBarTime: new Date().toISOString() }));

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.op === "subscribe" && msg.symbol) {
          client.symbol = msg.symbol;
          ws.send(JSON.stringify({ type: "subscribed", symbol: msg.symbol, tf: msg.tf ?? "5m" }));
        }
      } catch { /* ignore malformed */ }
    });

    ws.on("close", () => { clients.delete(client); logger.info({ symbol: client.symbol }, "WebSocket client disconnected"); });
    ws.on("error", (err) => { logger.warn({ err }, "WebSocket error"); clients.delete(client); });

    startSimulation();
  });

  logger.info("WebSocket server attached at /ws");
  return wss;
}
