import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { fetchPolygonSnapshot, isNyseOpen } from "./polygon";
import { logger } from "./logger";

// ── Client registry ───────────────────────────────────────────────────────────

interface WsClient { ws: WebSocket; symbol: string; }
const clients: Set<WsClient> = new Set();

function broadcast(symbol: string, message: object) {
  const data = JSON.stringify(message);
  let sent = 0;
  for (const c of clients) {
    if (c.symbol === symbol && c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(data);
      sent++;
    }
  }
  if (sent > 0) {
    _stats.forwarded += sent;
  }
}

function getActiveSymbols(): Set<string> {
  const s = new Set<string>();
  for (const c of clients) s.add(c.symbol);
  return s;
}

// ── Live stats ────────────────────────────────────────────────────────────────

interface RecentMsg {
  ev:    string;
  sym?:  string;
  p?:    number;
  t?:    number;
  ts:    number; // Date.now() when received
}

interface WsStatsData {
  // Polygon connection
  connected:         boolean;
  authenticated:     boolean;
  url:               string | null;
  subscribedSymbols: string[];
  // Per-type message counters (from Polygon)
  tMsgReceived:      number;
  amMsgReceived:     number;
  aMsgReceived:      number;
  statusMsgReceived: number;
  otherMsgReceived:  number;
  // Relay
  forwarded:         number;
  clientCount:       number;
  // Last message from Polygon
  lastSymbol:        string | null;
  lastPrice:         number | null;
  lastMsgTime:       number | null;
  // Last 20 messages (circular buffer)
  recentMsgs:        RecentMsg[];
}

const _stats: WsStatsData = {
  connected: false,
  authenticated: false,
  url: null,
  subscribedSymbols: [],
  tMsgReceived: 0,
  amMsgReceived: 0,
  aMsgReceived: 0,
  statusMsgReceived: 0,
  otherMsgReceived: 0,
  forwarded: 0,
  clientCount: 0,
  lastSymbol: null,
  lastPrice: null,
  lastMsgTime: null,
  recentMsgs: [],
};

function pushRecentMsg(msg: RecentMsg) {
  _stats.recentMsgs.push(msg);
  if (_stats.recentMsgs.length > 20) _stats.recentMsgs.shift();
}

export function getWsStats(): WsStatsData {
  return {
    ..._stats,
    subscribedSymbols: [...polygonSubscribed],
    connected:    polygonSocket !== null &&
                  (polygonSocket.readyState === WebSocket.OPEN ||
                   polygonSocket.readyState === WebSocket.CONNECTING),
    authenticated: polygonAuthed,
    url:           polygonUrl,
    clientCount:   clients.size,
    recentMsgs:    [..._stats.recentMsgs],
  };
}

// ── Polygon WebSocket streaming ───────────────────────────────────────────────
//
// This server is a PURE PRICE RELAY.  It does NOT construct OHLC bars.
// It does NOT poll snapshots.  The ONLY live data it sends to clients is:
//
//   { type: "price.update", symbol, price, timestamp }  — raw trade price
//   { type: "market.status", symbol, isOpen, price, lastClose } — open/closed
//
// Clients build OHLC candles themselves from the price stream.
//
// Two Polygon WS message types are consumed:
//   ev === "T"   (trade)             → throttled to TRADE_THROTTLE_MS per symbol
//   ev === "AM"  (aggregate per min) → immediate broadcast on minute close (1 msg/min)
//
// URL selection:
//   - Real-time (`wss://socket.polygon.io/stocks`) requires Stocks Starter+ plan.
//   - Delayed   (`wss://delayed.polygon.io/stocks`) works on the free tier (15-min delay).
//   If real-time auth fails, we automatically fall back to the delayed feed.

const REALTIME_WS_URL = "wss://socket.polygon.io/stocks";
const DELAYED_WS_URL  = "wss://delayed.polygon.io/stocks";
const TRADE_THROTTLE_MS = 1_000; // max 1 price.update per symbol per second from trades

let polygonSocket: WebSocket | null = null;
let polygonAuthed = false;
let polygonUrl = REALTIME_WS_URL;
let realtimeAuthFailed = false; // sticky flag — after a failed realtime auth, fall back to delayed
let wsPermanentlyDisabled = false; // sticky flag — both feeds rejected our key (free tier has no WS)
const polygonSubscribed = new Set<string>();
const lastBroadcastMs   = new Map<string, number>(); // per-symbol throttle clock
const lastKnownPrices   = new Map<string, number>(); // for market-status heartbeats

// Per-symbol log throttle: avoid spamming "first T message" more than once per 60 s
const firstTLoggedAt = new Map<string, number>();

function polygonConnect() {
  if (wsPermanentlyDisabled) return;

  if (
    polygonSocket &&
    (polygonSocket.readyState === WebSocket.OPEN ||
     polygonSocket.readyState === WebSocket.CONNECTING)
  ) return;

  polygonUrl = realtimeAuthFailed ? DELAYED_WS_URL : REALTIME_WS_URL;
  logger.info({ url: polygonUrl }, "Connecting to Polygon market-data WebSocket…");
  const ws = new WebSocket(polygonUrl);
  polygonSocket = ws;

  ws.on("open", () => {
    ws.send(JSON.stringify({
      action: "auth",
      params: (process.env.POLYGON_API_KEY ?? "").trim(),
    }));
  });

  ws.on("message", (raw: Buffer) => {
    // Ignore frames from a stale socket whose close handler hasn't fired yet.
    if (ws !== polygonSocket) return;
    try {
      const msgs = JSON.parse(raw.toString()) as Array<Record<string, unknown>>;
      for (const msg of msgs) {

        if (msg.ev === "status") {
          _stats.statusMsgReceived++;
          pushRecentMsg({ ev: "status", sym: String(msg.status ?? ""), ts: Date.now() });

          if (msg.status === "auth_success") {
            polygonAuthed = true;
            logger.info({ url: polygonUrl }, "Polygon WS authenticated");
            polygonSubscribeNew([...getActiveSymbols()]);
          } else if (msg.status === "auth_failed") {
            logger.warn({ url: polygonUrl, msg: msg.message }, "Polygon WS auth failed");
            if (polygonUrl === REALTIME_WS_URL) {
              realtimeAuthFailed = true;
            } else {
              wsPermanentlyDisabled = true;
              logger.warn("Polygon WS unavailable on this plan — live updates disabled. Historical bars still work via REST.");
              broadcastCapability();
            }
            ws.close();
          } else {
            logger.info({ status: msg.status, message: msg.message }, "Polygon WS status");
          }

        } else if (msg.ev === "T" && typeof msg.sym === "string") {
          // Individual trade — relay the transaction price, throttled.
          const sym   = msg.sym as string;
          const price = typeof msg.p === "number" ? msg.p : 0;
          const ts    = typeof msg.t === "number"
            ? Math.floor((msg.t as number) / 1000)
            : Math.floor(Date.now() / 1000);

          _stats.tMsgReceived++;
          _stats.lastMsgTime  = Date.now();
          _stats.lastSymbol   = sym;
          _stats.lastPrice    = price;
          pushRecentMsg({ ev: "T", sym, p: price, t: ts, ts: Date.now() });

          // Log the very first trade message per symbol (once per 60 s)
          const lastLog = firstTLoggedAt.get(sym) ?? 0;
          if (Date.now() - lastLog > 60_000) {
            firstTLoggedAt.set(sym, Date.now());
            logger.info({
              sym,
              price,
              ts,
              tTotal: _stats.tMsgReceived,
              clients: clients.size,
            }, "Polygon T (trade) received");
          }

          if (price <= 0) continue;

          const now    = Date.now();
          const lastMs = lastBroadcastMs.get(sym) ?? 0;
          if (now - lastMs >= TRADE_THROTTLE_MS) {
            lastBroadcastMs.set(sym, now);
            lastKnownPrices.set(sym, price);
            broadcast(sym, { type: "price.update", symbol: sym, price, timestamp: ts });
          }

        } else if (msg.ev === "AM" && typeof msg.sym === "string") {
          // 1-minute aggregate completed.
          const sym   = msg.sym as string;
          const price = typeof msg.c === "number" ? msg.c : 0;
          const ts    = typeof msg.e === "number"
            ? Math.floor((msg.e as number) / 1000)
            : Math.floor(Date.now() / 1000);

          _stats.amMsgReceived++;
          _stats.lastMsgTime = Date.now();
          _stats.lastSymbol  = sym;
          _stats.lastPrice   = price;
          pushRecentMsg({ ev: "AM", sym, p: price, t: ts, ts: Date.now() });

          logger.info({
            sym,
            close: price,
            ts,
            amTotal: _stats.amMsgReceived,
            clients: clients.size,
          }, "Polygon AM (minute agg) received");

          if (price <= 0) continue;

          lastBroadcastMs.set(sym, Date.now());
          lastKnownPrices.set(sym, price);
          broadcast(sym, { type: "price.update", symbol: sym, price, timestamp: ts });

        } else if (msg.ev === "A" && typeof msg.sym === "string") {
          // Second aggregate — count it but don't relay (we use T and AM only)
          _stats.aMsgReceived++;
          _stats.lastMsgTime = Date.now();
          pushRecentMsg({ ev: "A", sym: msg.sym as string, ts: Date.now() });

        } else {
          _stats.otherMsgReceived++;
          pushRecentMsg({ ev: String(msg.ev ?? "?"), ts: Date.now() });
        }
        // All other message types (subscription acks, errors) are silently ignored
      }
    } catch { /* malformed frame — ignore */ }
  });

  ws.on("close", (code, reason) => {
    if (ws !== polygonSocket) {
      logger.info({ code }, "Stale Polygon WS close ignored");
      return;
    }
    polygonSocket = null;
    polygonAuthed = false;
    polygonSubscribed.clear();
    if (wsPermanentlyDisabled) {
      logger.info({ code, reason: reason.toString() }, "Polygon WS closed (permanently disabled — plan does not include WS)");
      return;
    }
    logger.info({ code, reason: reason.toString() }, "Polygon WS closed — reconnecting in 5 s");
    setTimeout(polygonConnect, 5_000);
  });

  ws.on("error", (err) => {
    if (ws !== polygonSocket) return;
    logger.warn({ err: err.message }, "Polygon WS error");
    ws.close();
  });
}

function polygonSubscribeNew(symbols: string[]) {
  if (!polygonSocket || !polygonAuthed) return;
  const fresh = symbols.filter((s) => !polygonSubscribed.has(s));
  if (fresh.length === 0) return;

  const channels = fresh.flatMap((s) => [`T.${s}`, `AM.${s}`]);
  const params   = channels.join(",");
  polygonSocket.send(JSON.stringify({ action: "subscribe", params }));
  fresh.forEach((s) => polygonSubscribed.add(s));

  // Log each channel on its own line so it's easy to verify in the server logs
  logger.info({ channels, params }, "Polygon subscribe sent");
  for (const ch of channels) {
    logger.info({ channel: ch }, "  → subscribed");
  }
}

// ── Capability broadcast ──────────────────────────────────────────────────────

function buildCapabilityMessage(symbol: string) {
  return {
    type:              "market.capability",
    symbol,
    realtimeAvailable: !wsPermanentlyDisabled,
    reason:            wsPermanentlyDisabled ? "plan_limit" : null,
  };
}

function broadcastCapability() {
  for (const sym of getActiveSymbols()) {
    broadcast(sym, buildCapabilityMessage(sym));
  }
}

// ── Market status heartbeat ───────────────────────────────────────────────────

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

// ── WS status export ──────────────────────────────────────────────────────────
export function getWsStatus(): {
  status:        "realtime" | "delayed" | "connecting" | "offline";
  url:           string | null;
  authenticated: boolean;
} {
  if (wsPermanentlyDisabled) return { status: "offline",    url: null,       authenticated: false };
  if (polygonAuthed)         return { status: realtimeAuthFailed ? "delayed" : "realtime", url: polygonUrl, authenticated: true };
  return                              { status: "connecting", url: polygonUrl, authenticated: false };
}

// ── Public API: attach to HTTP server ─────────────────────────────────────────

export function setupWebSocket(server: Server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    const urlObj = new URL(req.url ?? "/ws", "http://localhost");
    const symbol = urlObj.searchParams.get("symbol")?.toUpperCase() ?? "NVDA";
    const client: WsClient = { ws, symbol };
    clients.add(client);
    logger.info({ symbol, totalClients: clients.size }, "WebSocket client connected");

    // On-connect: one snapshot fetch to establish market status and seed the price.
    fetchPolygonSnapshot(symbol).then((snap) => {
      if (!snap || ws.readyState !== WebSocket.OPEN) return;
      const isOpen = isNyseOpen();
      const price  = snap.price;

      if (price > 0) lastKnownPrices.set(symbol, price);

      ws.send(JSON.stringify({
        type:      "market.status",
        symbol,
        isOpen,
        price,
        lastClose: snap.prevClose || price,
      }));

      logger.info({ symbol, isOpen, price, isNyseOpen: isOpen }, "market.status sent to client on connect");

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
    ws.send(JSON.stringify(buildCapabilityMessage(symbol)));

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.op === "subscribe" && msg.symbol) {
          client.symbol = String(msg.symbol).toUpperCase();
          polygonSubscribeNew([client.symbol]);
          ws.send(JSON.stringify({ type: "subscribed", symbol: client.symbol }));
        }
      } catch { /* ignore */ }
    });

    ws.on("close", () => {
      clients.delete(client);
      logger.info({ symbol: client.symbol, remainingClients: clients.size }, "WS disconnected");
    });
    ws.on("error", () => { clients.delete(client); });

    polygonConnect();
    polygonSubscribeNew([symbol]);
    startMarketStatusHeartbeat();
  });

  polygonConnect();
  logger.info("WebSocket server attached at /ws");
  return wss;
}
