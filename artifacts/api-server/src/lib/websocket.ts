import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { fetchAlpacaSnapshot, isNyseOpen } from "./alpaca";
import { logger } from "./logger";

// ── Client registry ──────────────────────────────────────────────────────────

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

// ── Alpaca WebSocket streaming ────────────────────────────────────────────────
// Receives completed bars in real time during market hours.

const ALPACA_WS_URL = "wss://stream.data.alpaca.markets/v2/iex";

let alpacaSocket: WebSocket | null = null;
let alpacaAuthed = false;
const alpacaSubscribed = new Set<string>();

function alpacaConnect() {
  if (alpacaSocket && (alpacaSocket.readyState === WebSocket.OPEN || alpacaSocket.readyState === WebSocket.CONNECTING)) return;

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
          // Subscribe to all currently-active symbols
          alpacaSubscribeNew([...getActiveSymbols()]);

        } else if (msg.T === "b" && typeof msg.S === "string") {
          // 1-minute bar completed from Alpaca WS.
          //
          // IMPORTANT: We do NOT broadcast bar.final here.  Alpaca only streams
          // 1-minute bars, but clients may be viewing 5m or 15m charts.  Sending
          // bar.final with 1-minute OHLC would overwrite the client's accumulated
          // 5m/15m state every minute, producing giant candles.
          //
          // Instead: use the accurate 1-minute close to update currentBars, then
          // immediately broadcast bar.partial so clients get a more timely update
          // than waiting for the next 10-second poll cycle.
          const sym  = msg.S as string;
          const now  = Date.now() / 1000;
          const barTs = Math.floor(now / 300) * 300;
          const prev  = currentBars.get(sym);
          const isNewBar = prev?.time !== barTs;
          const close = typeof msg.c === "number" ? msg.c : (prev?.close ?? 0);
          if (close <= 0) continue; // ignore malformed bar
          const updatedBar: CurrentBar = {
            time:   barTs,
            open:   isNewBar ? close : (prev?.open ?? close),
            high:   isNewBar ? close : Math.max(close, prev?.high ?? close),
            low:    isNewBar ? close : Math.min(close, prev?.low  ?? close),
            close,
            volume: (prev?.volume ?? 0) + (typeof msg.v === "number" ? msg.v : 0),
          };
          currentBars.set(sym, updatedBar);
          broadcast(sym, { type: "bar.partial", symbol: sym, ...updatedBar });
        }
        // Ignore subscription confirmations and other messages
      }
    } catch { /* malformed — ignore */ }
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
  alpacaSocket.send(JSON.stringify({ action: "subscribe", bars: fresh }));
  fresh.forEach((s) => alpacaSubscribed.add(s));
  logger.info({ symbols: fresh }, "Alpaca bars subscribed");
}

// ── Snapshot polling: partial bars + market-closed status ───────────────────
// Every 10 seconds we fetch a snapshot for each active symbol.
//   • Market OPEN  → broadcast bar.partial with real OHLCV
//   • Market CLOSED → broadcast market.status with last close

interface CurrentBar { time: number; open: number; high: number; low: number; close: number; volume: number; }
const currentBars = new Map<string, CurrentBar>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function pollSnapshots() {
  const active = getActiveSymbols();
  if (active.size === 0) return;

  const marketOpen = isNyseOpen();
  const now = Date.now() / 1000;

  for (const symbol of active) {
    const snap = await fetchAlpacaSnapshot(symbol).catch(() => null);
    if (!snap) continue;

    if (!marketOpen) {
      // Market closed — freeze the price line, no candle movement
      broadcast(symbol, {
        type:      "market.status",
        symbol,
        isOpen:    false,
        price:     snap.prevClose || snap.price,
        lastClose: snap.prevClose || snap.price,
        timestamp: Math.floor(now),
      });
      continue;
    }

    // Market open — build / update the current partial 5-minute bar
    const barTs = Math.floor(now / 300) * 300; // floor to 5-minute boundary
    const prev  = currentBars.get(symbol);
    const isNewBar = prev?.time !== barTs;

    // CRITICAL: snap.open is the DAILY market-open price (e.g. $218.50 at 9:30 AM),
    // NOT the price at the start of this 5m bar. Using snap.open as the bar open
    // creates a synthetic giant candle spanning from the day's open to the current price.
    // Always use snap.price as the open for the first tick of a new 5m bar.
    const updatedBar: CurrentBar = {
      time:   barTs,
      open:   isNewBar ? snap.price : prev!.open,
      high:   isNewBar ? snap.price : Math.max(snap.price, prev!.high),
      low:    isNewBar ? snap.price : Math.min(snap.price, prev!.low),
      close:  snap.price,
      volume: snap.volume,
    };
    currentBars.set(symbol, updatedBar);

    broadcast(symbol, { type: "bar.partial", symbol, ...updatedBar });
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => { pollSnapshots().catch(() => {}); }, 10_000);
  // Immediate first poll
  pollSnapshots().catch(() => {});
}

// ── Public API: attach to HTTP server ─────────────────────────────────────────

export function setupWebSocket(server: Server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    const urlObj  = new URL(req.url ?? "/ws", "http://localhost");
    const symbol  = urlObj.searchParams.get("symbol")?.toUpperCase() ?? "NVDA";
    const client: WsClient = { ws, symbol };
    clients.add(client);
    logger.info({ symbol }, "WebSocket client connected");

    // Send immediate snapshot on connect
    fetchAlpacaSnapshot(symbol).then((snap) => {
      if (!snap || ws.readyState !== WebSocket.OPEN) return;
      if (!isNyseOpen()) {
        ws.send(JSON.stringify({
          type:      "market.status",
          symbol,
          isOpen:    false,
          price:     snap.prevClose || snap.price,
          lastClose: snap.prevClose || snap.price,
        }));
      } else {
        const now   = Date.now() / 1000;
        const barTs = Math.floor(now / 300) * 300;
        // IMPORTANT: snap.open/high/low are the DAILY bar values, not the current 5m bar.
        // Using them here would inject a giant day-range candle into the intraday chart.
        // Instead, seed the partial bar at the current price — the polling loop will
        // build up the real 5m O/H/L/C from repeated snap.price samples.
        ws.send(JSON.stringify({
          type: "bar.partial", symbol,
          time: barTs,
          open:   snap.price,
          high:   snap.price,
          low:    snap.price,
          close:  snap.price,
          volume: snap.volume,
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

    ws.on("close", () => { clients.delete(client); logger.info({ symbol: client.symbol }, "WS disconnected"); });
    ws.on("error", () => { clients.delete(client); });

    // Ensure Alpaca stream is up and this symbol is subscribed
    alpacaConnect();
    alpacaSubscribeNew([symbol]);
    startPolling();
  });

  // Pre-warm Alpaca connection so it's ready before the first client arrives
  alpacaConnect();
  logger.info("WebSocket server attached at /ws");
  return wss;
}
