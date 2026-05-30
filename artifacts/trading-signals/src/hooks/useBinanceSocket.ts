// ── Binance WebSocket kline stream ─────────────────────────────────────────
//
// Connects directly to the public Binance stream endpoint (no API key needed).
// Stream URL: wss://stream.binance.com:9443/ws/{symbol}@kline_{interval}
//
// Emits:
//   connected       — WS connection state
//   liveBar         — the currently forming kline as full OHLCV (updated tick-by-tick)
//   lastPrice       — synthetic PriceUpdate (close price) for SL/TP monitoring in ChartPage
//   realtimeAvailable — false only if WS permanently fails

import { useState, useEffect, useRef, useCallback } from "react";
import type { PriceUpdate } from "./useMarketSocket";

export interface CryptoBar {
  time:   number;   // Unix seconds (kline open time)
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
  closed: boolean;  // true when the kline has officially closed
}

interface BinanceKlineMsg {
  e: string;   // event type — "kline"
  s: string;   // symbol
  k: {
    t: number; // kline open time ms
    o: string; h: string; l: string; c: string; v: string;
    x: boolean; // is kline closed?
    i: string;  // interval
  };
}

interface UseBinanceSocketResult {
  connected:          boolean;
  liveBar:            CryptoBar | null;
  lastPrice:          PriceUpdate | null;
  isMarketOpen:       true;           // crypto is 24/7
  realtimeAvailable:  boolean;
}

const BINANCE_WS_BASE = "wss://stream.binance.com:9443/ws";
const MAX_RECONNECT_DELAY_MS = 30_000;

export function useBinanceSocket(
  symbol: string | null,
  interval: string,
): UseBinanceSocketResult {
  const [connected,         setConnected]   = useState(false);
  const [liveBar,           setLiveBar]     = useState<CryptoBar | null>(null);
  const [lastPrice,         setLastPrice]   = useState<PriceUpdate | null>(null);
  const [realtimeAvailable, setRtAvail]     = useState(true);

  const wsRef              = useRef<WebSocket | null>(null);
  const reconnectTimer     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef  = useRef(1_000);

  const connect = useCallback(() => {
    if (!symbol) return;

    // Close any prior connection without triggering the reconnect path.
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
    }

    const stream = `${symbol.toLowerCase()}@kline_${interval}`;
    const url    = `${BINANCE_WS_BASE}/${stream}`;
    const ws     = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (ws !== wsRef.current) return;
      setConnected(true);
      setRtAvail(true);
      reconnectDelayRef.current = 1_000; // reset exponential backoff on success
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
    };

    ws.onmessage = (ev: MessageEvent<string>) => {
      if (ws !== wsRef.current) return;
      try {
        const msg = JSON.parse(ev.data) as BinanceKlineMsg;
        if (msg.e !== "kline") return;

        const k = msg.k;
        const bar: CryptoBar = {
          time:   Math.floor(k.t / 1000),
          open:   parseFloat(k.o),
          high:   parseFloat(k.h),
          low:    parseFloat(k.l),
          close:  parseFloat(k.c),
          volume: parseFloat(k.v),
          closed: k.x,
        };

        if (!isFinite(bar.open) || !isFinite(bar.close) || bar.time <= 0) return;

        setLiveBar(bar);
        setLastPrice({
          type:      "price.update",
          symbol:    symbol.toUpperCase(),
          price:     bar.close,
          timestamp: Math.floor(Date.now() / 1000),
        });
      } catch { /* ignore malformed frames */ }
    };

    ws.onclose = () => {
      if (ws !== wsRef.current) return;
      setConnected(false);
      const delay = reconnectDelayRef.current;
      reconnectDelayRef.current = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
      reconnectTimer.current = setTimeout(() => connect(), delay);
    };

    ws.onerror = () => {
      if (ws !== wsRef.current) return;
      setRtAvail(false);
      ws.close(); // triggers onclose → reconnect
    };
  }, [symbol, interval]);

  useEffect(() => {
    setLiveBar(null);
    setLastPrice(null);
    setConnected(false);

    connect();

    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    };
  }, [connect]);

  return {
    connected,
    liveBar,
    lastPrice,
    isMarketOpen: true,
    realtimeAvailable,
  };
}
