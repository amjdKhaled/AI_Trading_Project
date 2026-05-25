import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { fetchAlpacaSnapshot, isNyseOpen } from "./alpaca";
import { logger } from "./logger";

// ── Client registry ───────────────────────────────────────────────────────────

interface WsClient { ws: WebSocket; symbol: string; }
const clients: Set<WsClient> = new Set();

function broadcast(symbol: string, message: object) {
  const data = JSON.stringify(message);
  for (const c of clients) {
    if (c.symbol === symbol && c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
  }
}

function getActiveSymbols(): Set<string> {
  const s = new Set<string>();
  for (const c of clients) s.add(c.symbol);
  return s;
}

// ── Alpaca WebSocket streaming ─────────────────────────────────────────────────
//
// This server is a PURE PRICE RELAY.  It does NOT construct OHLC bars.
// It does NOT poll snapshots.  The ONLY live data it sends to clients is:
//
//   { type: "price.update", symbol, price, timestamp }  — raw trade price
//   { type: "market.status", symbol, isOpen, price, lastClose } — open/closed
//
// Clients build OHLC candles themselves from the price stream.
//
// Two Alpaca WS message types are consumed:
//   T === "t"  (trade)  → throttled to TRADE_THROTTLE_MS per symbol
//   T === "b"  (1m bar) → immediate broadcast on bar close (1 msg/minute)

const ALPACA_WS_URL    = "wss://stream.data.alpaca.markets/v2/iex";
const TRADE_THROTTLE_MS = 1_000; // max 1 price.update per symbol per second from trades

let alpacaSocket: WebSocket | null = null;
let alpacaAuthed = false;
const alpacaSubscribed  = new Set<string>();
const lastBroadcastMs   = new Map<string, number>(); // per-symbol throttle clock
const lastKnownPrices   = new Map<string, number>(); // for market-status heartbeats

function alpacaConnect() {
  if (
    alpacaSocket &&
    (alpacaSocket.readyState === WebSocket.OPEN ||
     alpacaSocket.readyState === WebSocket.CONNECTING)
  ) return;

  logger.info("Connecting to Alpaca market-data WebSocket…");
  const ws = new WebSocket(ALPACA_WS_URL);
  alpacaSocket = ws;

  ws.on("open", () => {
    ws.send(JSON.stringify({
      action: "auth",
      key:    process.env.ALPACA_API_KEY    ?? "",
      secret: process.env.ALPACA_SECRET_KEY ?? "",
    }));
  });

  ws.on("message", (raw: Buffer) => {
    try {
      const msgs = JSON.parse(raw.toString()) as Array<Record<string, unknown>>;
      for (const msg of msgs) {

        if (msg.T === "success" && msg.msg === "authenticated") {
          alpacaAuthed = true;
          logger.info("Alpaca WS authenticated");
          alpacaSubscribeNew([...getActiveSymbols()]);

        } else if (msg.T === "t" && typeof msg.S === "string") {
          // Individual trade — relay the transaction price, throttled.
          // We subscribe to trades because they are the ground-truth price feed.
          // 1-minute bars are only ~60 updates/hour; trades give us ~1/sec granularity.
          const sym   = msg.S as string;
          const price = typeof msg.p === "number" ? msg.p : 0;
          const ts    = typeof msg.t === "string"
            ? Math.floor(new Date(msg.t as string).getTime() / 1000)
            : Math.floor(Date.now() / 1000);

          if (price <= 0) continue;

          const now    = Date.now();
          const lastMs = lastBroadcastMs.get(sym) ?? 0;
          if (now - lastMs >= TRADE_THROTTLE_MS) {
            lastBroadcastMs.set(sym, now);
            lastKnownPrices.set(sym, price);
            broadcast(sym, { type: "price.update", symbol: sym, price, timestamp: ts });
          }

        } else if (msg.T === "b" && typeof msg.S === "string") {
          // 1-minute bar completed.
          // Broadcast the bar's close price immediately — this is the definitive
          // end-of-minute price and is more accurate than any throttled trade tick.
          // Use the bar's START timestamp + 59s to represent the bar's close moment.
          const sym   = msg.S as string;
          const price = typeof msg.c === "number" ? msg.c : 0;
          const ts    = typeof msg.t === "string"
            ? Math.floor(new Date(msg.t as string).getTime() / 1000) + 59
            : Math.floor(Date.now() / 1000);

          if (price <= 0) continue;

          lastBroadcastMs.set(sym, Date.now()); // reset throttle (bar close supersedes trades)
          lastKnownPrices.set(sym, price);
          broadcast(sym, { type: "price.update", symbol: sym, price, timestamp: ts });
        }
        // All other message types (subscription acks, errors) are silently ignored
      }
    } catch { /* malformed frame — ignore */ }
  });

  ws.on("close", (code, reason) => {
    alpacaSocket  = null;
    alpacaAuthed  = false;
    alpacaSubscribed.clear();
    logger.info({ code, reason: reason.toString() }, "Alpaca WS closed — reconnecting in 5 s");
    setTimeout(alpacaConnect, 5_000);
  });

  ws.on("error", (err) => {
    logger.warn({ err: err.message }, "Alpaca WS error");
    ws.close();
  });
}

function alpacaSubscribeNew(symbols: string[]) {
  if (!alpacaSocket || !alpacaAuthed) return;
  const fresh = symbols.filter((s) => !alpacaSubscribed.has(s));
  if (fresh.length === 0) return;
  // Subscribe to both trades (real-time price) and bars (end-of-minute accuracy)
  alpacaSocket.send(JSON.stringify({ action: "subscribe", trades: fresh, bars: fresh }));
  fresh.forEach((s) => alpacaSubscribed.add(s));
  logger.info({ symbols: fresh }, "Alpaca trades + bars subscribed");
}

// ── Market status heartbeat ───────────────────────────────────────────────────
// Broadcasts open/closed status to all active clients every 60 seconds.
// Includes the last known price so the client can display it when the market
// is closed and no price.updates are flowing.

function broadcastMarketStatus() {
  const isOpen = isNyseOpen();
  for (const sym of getActiveSymbols()) {
    const price = lastKnownPrices.get(sym) ?? 0;
    broadcast(sym, {
      type:      "market.status",
      symbol:    sym,
      isOpen,
      price,
      lastClose: price,
    });
  }
}

let marketStatusTimer: ReturnType<typeof setInterval> | null = null;
function startMarketStatusHeartbeat() {
  if (marketStatusTimer) return;
  marketStatusTimer = setInterval(broadcastMarketStatus, 60_000);
}

// ── Public API: attach to HTTP server ─────────────────────────────────────────

export function setupWebSocket(server: Server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    const urlObj = new URL(req.url ?? "/ws", "http://localhost");
    const symbol = urlObj.searchParams.get("symbol")?.toUpperCase() ?? "NVDA";
    const client: WsClient = { ws, symbol };
    clients.add(client);
    logger.info({ symbol }, "WebSocket client connected");

    // On-connect: one snapshot fetch to establish market status and seed the price.
    // This is the ONLY HTTP snapshot call — it does NOT recur.
    fetchAlpacaSnapshot(symbol).then((snap) => {
      if (!snap || ws.readyState !== WebSocket.OPEN) return;
      const isOpen = isNyseOpen();
      const price  = snap.price;

      if (price > 0) lastKnownPrices.set(symbol, price);

      // Always send market status first so the client knows open/closed state
      ws.send(JSON.stringify({
        type:      "market.status",
        symbol,
        isOpen,
        price,
        lastClose: snap.prevClose || price,
      }));

      // If market is open, also seed the live price so the chart can start
      // building its first bar immediately (before the first Alpaca trade arrives)
      if (isOpen && price > 0) {
        ws.send(JSON.stringify({
          type:      "price.update",
          symbol,
          price,
          timestamp: Math.floor(Date.now() / 1000),
        }));
      }
    }).catch(() => {});

    ws.send(JSON.stringify({ type: "subscribed", symbol }));

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.op === "subscribe" && msg.symbol) {
          client.symbol = String(msg.symbol).toUpperCase();
          alpacaSubscribeNew([client.symbol]);
          ws.send(JSON.stringify({ type: "subscribed", symbol: client.symbol }));
        }
      } catch { /* ignore */ }
    });

    ws.on("close", () => {
      clients.delete(client);
      logger.info({ symbol: client.symbol }, "WS disconnected");
    });
    ws.on("error", () => { clients.delete(client); });

    alpacaConnect();
    alpacaSubscribeNew([symbol]);
    startMarketStatusHeartbeat();
  });

  // Pre-warm connection so it is ready before the first client arrives
  alpacaConnect();
  logger.info("WebSocket server attached at /ws");
  return wss;
}
