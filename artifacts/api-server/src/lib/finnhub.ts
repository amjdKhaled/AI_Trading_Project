import { WebSocket } from "ws";
import { logger } from "./logger";

const API_KEY = process.env["FINNHUB_API_KEY"] ?? "";
const BASE_URL = "https://finnhub.io/api/v1";

export interface OhlcvBar {
  time: number; // unix seconds, aligned to 5m boundary
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ─── REST: historical 5m candles ────────────────────────────────────────────

export async function fetchCandles(
  symbol: string,
  from: number,
  to: number,
): Promise<OhlcvBar[]> {
  const url = `${BASE_URL}/stock/candle?symbol=${symbol}&resolution=5&from=${from}&to=${to}&token=${API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Finnhub candle fetch failed: ${res.status}`);
  const data = (await res.json()) as {
    s: string;
    t?: number[];
    o?: number[];
    h?: number[];
    l?: number[];
    c?: number[];
    v?: number[];
  };
  if (data.s !== "ok" || !data.t) return [];
  return data.t.map((t, i) => ({
    time: t,
    open: data.o![i],
    high: data.h![i],
    low: data.l![i],
    close: data.c![i],
    volume: data.v![i],
  }));
}

// ─── REST: current quote ────────────────────────────────────────────────────

export async function fetchQuote(
  symbol: string,
): Promise<{ price: number; open: number; prevClose: number } | null> {
  const url = `${BASE_URL}/quote?symbol=${symbol}&token=${API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = (await res.json()) as { c: number; o: number; pc: number };
  return { price: data.c, open: data.o, prevClose: data.pc };
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
      // re-subscribe all symbols on reconnect
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
