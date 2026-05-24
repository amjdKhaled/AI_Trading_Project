import { WebSocket } from "ws";
import { logger } from "./logger";

const API_KEY = process.env["FINNHUB_API_KEY"] ?? "";
const BASE_URL = "https://finnhub.io/api/v1";

export interface OhlcvBar {
  time: number; // unix seconds, 5m-boundary aligned
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ─── REST: current quote (free tier) ────────────────────────────────────────

export async function fetchQuote(
  symbol: string,
): Promise<{ price: number; open: number; high: number; low: number; prevClose: number } | null> {
  const url = `${BASE_URL}/quote?symbol=${symbol}&token=${API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = (await res.json()) as { c: number; o: number; h: number; l: number; pc: number };
  if (!data.c) return null;
  return { price: data.c, open: data.o, high: data.h, low: data.l, prevClose: data.pc };
}

// ─── Build synthetic seed bars from a quote ─────────────────────────────────
// Creates realistic-looking 5m bars anchored to current price for a clean
// chart baseline before live ticks arrive. Used when candle history is 403.

export async function buildSeedBars(symbol: string, count = 200): Promise<OhlcvBar[]> {
  const quote = await fetchQuote(symbol);
  if (!quote) return [];

  const now = Math.floor(Date.now() / 1000);
  const intervalSec = 5 * 60;
  // Snap to 5m boundary
  const latestBarTime = now - (now % intervalSec);

  const bars: OhlcvBar[] = [];
  let price = quote.prevClose || quote.price;
  // Daily range to scale intraday moves
  const dailyRange = quote.high - quote.low;
  const atr = dailyRange > 0 ? dailyRange / 78 : price * 0.002; // ~78 5m bars/day

  // Use a seeded pseudo-random walk so bars are reproducible per session
  let seed = symbol.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  function rand() {
    seed = (seed * 1664525 + 1013904223) & 0xffffffff;
    return (seed >>> 0) / 0xffffffff;
  }

  // Walk toward current price over the session
  const targetDrift = (quote.price - quote.prevClose) / count;

  for (let i = count - 1; i >= 0; i--) {
    const time = latestBarTime - i * intervalSec;
    const move = (rand() - 0.485) * atr * 1.8 + targetDrift;
    const open = price;
    const close = Math.max(open + move, open * 0.95);
    const wickUp = rand() * atr * 0.5;
    const wickDown = rand() * atr * 0.5;
    const high = Math.max(open, close) + wickUp;
    const low = Math.min(open, close) - wickDown;
    const volume = Math.floor(50000 + rand() * 400000);
    bars.push({
      time,
      open: Math.round(open * 100) / 100,
      high: Math.round(high * 100) / 100,
      low: Math.round(low * 100) / 100,
      close: Math.round(close * 100) / 100,
      volume,
    });
    price = close;
  }

  // Snap last bar close to actual quote price
  if (bars.length > 0) {
    const last = bars[bars.length - 1];
    last.close = quote.price;
    last.high = Math.max(last.high, quote.price);
    last.low = Math.min(last.low, quote.price);
  }

  return bars;
}

// ─── WebSocket live trade feed ───────────────────────────────────────────────

type TradeHandler = (symbol: string, price: number, volume: number, ts: number) => void;

export class FinnhubStream {
  private ws: WebSocket | null = null;
  private subscribed = new Set<string>();
  private handler: TradeHandler;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(handler: TradeHandler) {
    this.handler = handler;
    this.connect();
  }

  private connect() {
    if (this.stopped) return;
    logger.info("Connecting to Finnhub WebSocket");
    const ws = new WebSocket(`wss://ws.finnhub.io?token=${API_KEY}`);
    this.ws = ws;

    ws.on("open", () => {
      logger.info("Finnhub WebSocket connected");
      for (const sym of this.subscribed) {
        ws.send(JSON.stringify({ type: "subscribe", symbol: sym }));
      }
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          type: string;
          data?: { s: string; p: number; v: number; t: number }[];
        };
        if (msg.type === "trade" && msg.data) {
          for (const t of msg.data) {
            this.handler(t.s, t.p, t.v, Math.floor(t.t / 1000));
          }
        }
      } catch {
        // ignore parse errors
      }
    });

    ws.on("close", () => {
      logger.warn("Finnhub WebSocket closed, reconnecting in 5s");
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(() => this.connect(), 5000);
      }
    });

    ws.on("error", (err) => {
      logger.warn({ err }, "Finnhub WebSocket error");
      ws.terminate();
    });
  }

  subscribe(symbol: string) {
    this.subscribed.add(symbol);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "subscribe", symbol }));
      logger.info({ symbol }, "Finnhub subscribed");
    }
  }

  unsubscribe(symbol: string) {
    this.subscribed.delete(symbol);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "unsubscribe", symbol }));
    }
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.terminate();
  }
}
