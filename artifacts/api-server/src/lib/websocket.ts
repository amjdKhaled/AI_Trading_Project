import { WebSocketServer, WebSocket } from "ws";
import { spawn } from "child_process";
import path from "path";
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

// ── Real-price fetcher via yfinance_fetch.py live ─────────────────────────
const PYTHON_SCRIPT = path.join(process.cwd(), "src", "yfinance_fetch.py");

interface LivePrice {
  symbol: string;
  price: number;
  lastClose: number;
  isMarketOpen: boolean;
  timestamp: number;
  bar: { time: number; open: number; high: number; low: number; close: number; volume: number } | null;
  error?: string;
}

// In-process cache: avoid hammering yfinance on every tick
const priceCache = new Map<string, { data: LivePrice; ts: number }>();
const CACHE_TTL_MS = 12_000; // 12 seconds — yfinance updates ~every 15s

function fetchLivePrice(symbol: string): Promise<LivePrice | null> {
  const cached = priceCache.get(symbol);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return Promise.resolve(cached.data);

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const proc = spawn("python3", [PYTHON_SCRIPT, symbol, "live"]);
    proc.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
    proc.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    proc.on("close", () => {
      try {
        const data: LivePrice = JSON.parse(stdout.trim());
        if (!data.error) priceCache.set(symbol, { data, ts: Date.now() });
        resolve(data.error ? null : data);
      } catch {
        logger.warn({ symbol, stderr: stderr.slice(0, 200) }, "live price parse failed");
        resolve(null);
      }
    });
    proc.on("error", (err) => { logger.warn({ err, symbol }, "python spawn error"); resolve(null); });
    // Hard timeout: if yfinance hangs, don't block the interval
    setTimeout(() => { try { proc.kill(); } catch {} resolve(null); }, 9_000);
  });
}

// ── Broadcast real market data to all subscribed clients ─────────────────
async function broadcastMarketData() {
  if (clients.size === 0) return;

  const active = new Set<string>();
  for (const c of clients) active.add(c.symbol);

  for (const symbol of active) {
    const data = await fetchLivePrice(symbol);
    if (!data) continue;

    if (!data.isMarketOpen) {
      // Market closed — send status so the chart shows "CLOSED"
      broadcast(symbol, {
        type:       "market.status",
        symbol,
        isOpen:     false,
        price:      data.lastClose || data.price,
        lastClose:  data.lastClose,
        timestamp:  data.timestamp,
      });
    } else {
      // Market open — send the real current bar partial
      if (data.bar) {
        broadcast(symbol, {
          type:   "bar.partial",
          symbol,
          ...data.bar,
        });
      }
    }
  }
}

let pollInterval: ReturnType<typeof setInterval> | null = null;

function startPolling() {
  if (pollInterval) return;
  // Poll every 15 seconds — matches yfinance refresh cadence
  pollInterval = setInterval(() => { broadcastMarketData().catch(() => {}); }, 15_000);
  // Immediate first broadcast when polling starts
  broadcastMarketData().catch(() => {});
}

export function setupWebSocket(server: Server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    const url    = new URL(req.url ?? "/ws", "http://localhost");
    const symbol = url.searchParams.get("symbol") ?? "NVDA";
    const client: WsClient = { ws, symbol };
    clients.add(client);
    logger.info({ symbol }, "WebSocket client connected");

    // Send current market status immediately on connect
    fetchLivePrice(symbol).then((data) => {
      if (!data || ws.readyState !== WebSocket.OPEN) return;
      if (!data.isMarketOpen) {
        ws.send(JSON.stringify({ type: "market.status", symbol, isOpen: false, price: data.lastClose || data.price, lastClose: data.lastClose }));
      } else if (data.bar) {
        ws.send(JSON.stringify({ type: "bar.partial", symbol, ...data.bar }));
      }
    }).catch(() => {});

    ws.send(JSON.stringify({ type: "subscribed", symbol, tf: "5m" }));

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.op === "subscribe" && msg.symbol) {
          client.symbol = String(msg.symbol).toUpperCase();
          ws.send(JSON.stringify({ type: "subscribed", symbol: client.symbol, tf: msg.tf ?? "5m" }));
          // Send immediate status for the new symbol
          fetchLivePrice(client.symbol).then((data) => {
            if (!data || ws.readyState !== WebSocket.OPEN) return;
            if (!data.isMarketOpen) {
              ws.send(JSON.stringify({ type: "market.status", symbol: client.symbol, isOpen: false, price: data.lastClose || data.price, lastClose: data.lastClose }));
            } else if (data.bar) {
              ws.send(JSON.stringify({ type: "bar.partial", symbol: client.symbol, ...data.bar }));
            }
          }).catch(() => {});
        }
      } catch { /* ignore malformed */ }
    });

    ws.on("close", () => { clients.delete(client); logger.info({ symbol: client.symbol }, "WebSocket disconnected"); });
    ws.on("error", ()  => { clients.delete(client); });

    startPolling();
  });

  logger.info("WebSocket server attached at /ws");
  return wss;
}
