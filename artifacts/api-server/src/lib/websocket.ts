import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { db, signalsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { generateSignals } from "./analyzer/signals";
import type { OhlcvBar } from "./analyzer/types";

interface WsClient {
  ws: WebSocket;
  symbol: string;
}

const clients: Set<WsClient> = new Set();
const SIM_BARS: Map<string, OhlcvBar[]> = new Map(); // symbol → recent simulated bars

function broadcast(symbol: string, message: object) {
  const data = JSON.stringify(message);
  for (const client of clients) {
    if (client.symbol === symbol && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(data);
    }
  }
}

function basePrice(symbol: string): number {
  const map: Record<string, number> = {
    NVDA: 1048, AAPL: 195, AMD: 168, MSFT: 430,
    TSLA: 285, AMZN: 196, META: 590, QQQ: 488,
  };
  if (map[symbol]) return map[symbol];
  const seed = symbol.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return 100 + (seed % 400);
}

function generateSimulatedBar(symbol: string): OhlcvBar {
  const base = basePrice(symbol);
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
    volume: Math.floor(500000 + Math.random() * 4500000),
  };
}

// Run the full analysis engine and emit real signals
async function analyzeAndEmit(symbol: string, bars: OhlcvBar[]) {
  if (bars.length < 50) return;
  const { signals } = generateSignals(bars, symbol, "5m");
  for (const signal of signals) {
    // Persist
    try {
      await db.insert(signalsTable).values({
        signalId: signal.id,
        symbol: signal.symbol,
        timeframe: signal.timeframe,
        barTime: new Date(signal.barTime * 1000),
        side: signal.side,
        entryPrice: signal.entryPrice,
        slPrice: signal.slPrice,
        tpPrice: signal.tpPrice,
        currentSlPrice: signal.slPrice,
        confidence: signal.confidence,
        riskTag: signal.riskLevel,
        state: "active",
        rrRatio: Math.round(Math.abs(signal.tpPrice - signal.entryPrice) / Math.abs(signal.entryPrice - signal.slPrice) * 100) / 100,
        pattern: signal.patterns[0] ?? "analysis_engine",
        regime: "volatile",
      });
    } catch (err) {
      // dedup / race — ignore duplicates
    }

    // Broadcast
    broadcast(symbol, {
      type: "signal.new",
      signalId: signal.id,
      symbol: signal.symbol,
      side: signal.side,
      entryPrice: signal.entryPrice,
      slPrice: signal.slPrice,
      tpPrice: signal.tpPrice,
      confidence: signal.confidence,
      riskTag: signal.riskLevel,
      grade: signal.grade,
      patterns: signal.patterns,
      barTime: new Date(signal.barTime * 1000).toISOString(),
    });
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
      let bars = SIM_BARS.get(symbol) ?? [];
      bars.push(bar);
      if (bars.length > 200) bars = bars.slice(-200);
      SIM_BARS.set(symbol, bars);

      broadcast(symbol, { type: "bar.partial", symbol, ...bar });

      // Every ~5 ticks emit a final bar and run analysis
      if (Math.random() > 0.8) {
        broadcast(symbol, { type: "bar.final", symbol, ...bar });
        await analyzeAndEmit(symbol, bars);
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
