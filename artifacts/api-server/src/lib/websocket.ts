import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { fetchPolygonSnapshot, isNyseOpen } from "./polygon";
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

function polygonConnect() {
  // Polygon's free tier rejects WS auth on *both* realtime and delayed feeds.
  // Once we've confirmed both refuse our key, stop reconnecting forever — the
  // reconnect loop otherwise hammers Polygon and burns the 5-req/min REST budget
  // (which the history endpoint shares). Live updates simply require a paid plan.
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
          if (msg.status === "auth_success") {
            polygonAuthed = true;
            logger.info({ url: polygonUrl }, "Polygon WS authenticated");
            polygonSubscribeNew([...getActiveSymbols()]);
          } else if (msg.status === "auth_failed") {
            logger.warn({ url: polygonUrl, msg: msg.message }, "Polygon WS auth failed");
            if (polygonUrl === REALTIME_WS_URL) {
              // Plan doesn't include real-time — try delayed next.
              realtimeAuthFailed = true;
            } else {
              // Delayed also rejected. Free tier has no WS access at all.
              // Disable WS reconnects permanently to stop the spam loop, and
              // tell every connected client so the UI can surface it.
              wsPermanentlyDisabled = true;
              logger.warn("Polygon WS unavailable on this plan — live updates disabled. Historical bars still work via REST.");
              broadcastCapability();
            }
            ws.close();
          }

        } else if (msg.ev === "T" && typeof msg.sym === "string") {
          // Individual trade — relay the transaction price, throttled.
          const sym   = msg.sym as string;
          const price = typeof msg.p === "number" ? msg.p : 0;
          const ts    = typeof msg.t === "number"
            ? Math.floor((msg.t as number) / 1000)
            : Math.floor(Date.now() / 1000);

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
          // Broadcast the bar's close price — this is the definitive end-of-minute
          // price and is more accurate than any throttled trade tick.
          const sym   = msg.sym as string;
          const price = typeof msg.c === "number" ? msg.c : 0;
          // `s` = bar start ms, `e` = bar end ms. Use end as the timestamp.
          const ts    = typeof msg.e === "number"
            ? Math.floor((msg.e as number) / 1000)
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
    // Only the currently-active socket may mutate shared state. A late close
    // from a superseded socket would otherwise clobber a healthy connection
    // and trigger a duplicate reconnect.
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
    // Same identity guard as close — ignore errors from a superseded socket.
    if (ws !== polygonSocket) return;
    logger.warn({ err: err.message }, "Polygon WS error");
    ws.close();
  });
}

function polygonSubscribeNew(symbols: string[]) {
  if (!polygonSocket || !polygonAuthed) return;
  const fresh = symbols.filter((s) => !polygonSubscribed.has(s));
  if (fresh.length === 0) return;
  // Subscribe to both trades (real-time price) and minute aggregates (end-of-minute accuracy).
  // Polygon supports comma-separated multi-symbol subscriptions per channel.
  const tradesParam = fresh.map((s) => `T.${s}`).join(",");
  const aggsParam   = fresh.map((s) => `AM.${s}`).join(",");
  polygonSocket.send(JSON.stringify({ action: "subscribe", params: `${tradesParam},${aggsParam}` }));
  fresh.forEach((s) => polygonSubscribed.add(s));
  logger.info({ symbols: fresh }, "Polygon trades + minute aggs subscribed");
}

// ── Capability broadcast ──────────────────────────────────────────────────────
// Tells every connected client whether real-time data is available. Sent once
// per client on connect, and again to all clients when WS is permanently
// disabled (so the UI can switch to a "historical only" display).

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

// ── WS status export ──────────────────────────────────────────────────────────
// Returns the current Polygon WebSocket connection state for diagnostics.
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
    logger.info({ symbol }, "WebSocket client connected");

    // On-connect: one snapshot fetch to establish market status and seed the price.
    // This is the ONLY HTTP snapshot call — it does NOT recur.
    fetchPolygonSnapshot(symbol).then((snap) => {
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
      // building its first bar immediately (before the first Polygon trade arrives)
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
    // Tell the client up-front whether real-time updates will flow.
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
      logger.info({ symbol: client.symbol }, "WS disconnected");
    });
    ws.on("error", () => { clients.delete(client); });

    polygonConnect();
    polygonSubscribeNew([symbol]);
    startMarketStatusHeartbeat();
  });

  // Pre-warm connection so it is ready before the first client arrives
  polygonConnect();
  logger.info("WebSocket server attached at /ws");
  return wss;
}
