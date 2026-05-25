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

const BASE_PRICES: Record<string, number> = {
  NVDA: 215, AAPL: 195, AMD: 130, MSFT: 430,
  TSLA: 285, AMZN: 196, META: 590, QQQ: 488,
};

function generateSimulatedBar(symbol: string) {
  const base = BASE_PRICES[symbol] ?? 100 + (symbol.split("").reduce((a, c) => a + c.charCodeAt(0), 0) % 400);
  const move = (Math.random() - 0.49) * base * 0.003;
  const open = base;
  const close = Math.max(open + move, open * 0.99);
  const high = Math.max(open, close) * (1 + Math.random() * 0.002);
  const low  = Math.min(open, close) * (1 - Math.random() * 0.002);
  const now  = Math.floor(Date.now() / 1000);
  return {
    time:   now - (now % 300),
    open:   Math.round(open  * 100) / 100,
    high:   Math.round(high  * 100) / 100,
    low:    Math.round(low   * 100) / 100,
    close:  Math.round(close * 100) / 100,
    volume: Math.floor(500_000 + Math.random() * 4_500_000),
  };
}

let simulationInterval: ReturnType<typeof setInterval> | null = null;

function startSimulation() {
  if (simulationInterval) return;
  simulationInterval = setInterval(() => {
    if (clients.size === 0) return;
    const activeSymbols = new Set<string>();
    for (const c of clients) activeSymbols.add(c.symbol);
    for (const symbol of activeSymbols) {
      broadcast(symbol, { type: "bar.partial", symbol, ...generateSimulatedBar(symbol) });
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

    ws.on("close", () => { clients.delete(client); logger.info({ symbol }, "WebSocket client disconnected"); });
    ws.on("error", (err) => { logger.warn({ err }, "WebSocket error"); clients.delete(client); });

    startSimulation();
  });

  logger.info("WebSocket server attached at /ws");
  return wss;
}
