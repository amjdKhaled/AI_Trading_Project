import { useState, useEffect, useRef, useCallback } from "react";

// ── Server message types ───────────────────────────────────────────────────────
//
// The server is a pure price relay — it sends raw trade prices, NOT synthetic OHLC.
// Clients build candles themselves from the price stream.

export interface PriceUpdate {
  type: "price.update";
  symbol: string;
  price: number;
  timestamp: number; // Unix seconds
}

export interface MarketStatus {
  type: "market.status";
  symbol: string;
  isOpen: boolean;
  price: number;
  lastClose: number;
  timestamp?: number;
}

export interface SignalNew {
  type: "signal.new";
  signalId: string;
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  confidence: number;
  riskTag: string;
  barTime: string;
  grade?: "A+" | "A" | "B" | "Weak";
  patterns?: string[];
}

export interface SlUpdate {
  type: "sl.update";
  signalId: string;
  slPrice: number;
}

export interface SignalExit {
  type: "signal.exit";
  signalId: string;
  reason: string;
  exitPrice: number;
  barTime: string;
}

export type MarketEvent =
  | PriceUpdate
  | MarketStatus
  | SignalNew
  | SlUpdate
  | SignalExit;

interface UseMarketSocketResult {
  connected: boolean;
  lastPrice: PriceUpdate | null;
  isMarketOpen: boolean;
  marketPrice: number | null;
  newSignals: SignalNew[];
  slUpdates: SlUpdate[];
  signalExits: SignalExit[];
}

export function useMarketSocket(symbol: string | null): UseMarketSocketResult {
  const [connected,    setConnected]    = useState(false);
  const [lastPrice,    setLastPrice]    = useState<PriceUpdate | null>(null);
  const [isMarketOpen, setIsMarketOpen] = useState<boolean>(false);
  const [marketPrice,  setMarketPrice]  = useState<number | null>(null);
  const [newSignals,   setNewSignals]   = useState<SignalNew[]>([]);
  const [slUpdates,    setSlUpdates]    = useState<SlUpdate[]>([]);
  const [signalExits,  setSignalExits]  = useState<SignalExit[]>([]);

  const wsRef          = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    if (!symbol) return;
    if (wsRef.current) wsRef.current.close();

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host     = window.location.host;
    const base     = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
    const url      = `${protocol}//${host}${base}/ws?symbol=${encodeURIComponent(symbol)}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => { setConnected(true); };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as MarketEvent;
        switch (msg.type) {
          case "price.update": {
            const p = msg as PriceUpdate;
            if (p.price > 0) {
              setLastPrice(p);
              setIsMarketOpen(true);
              setMarketPrice(p.price);
            }
            break;
          }
          case "market.status": {
            const s = msg as MarketStatus;
            setIsMarketOpen(s.isOpen);
            // Only update displayed price if the server has a real value
            if (s.price > 0) setMarketPrice(s.price);
            break;
          }
          case "signal.new":
            setNewSignals((prev) => [msg as SignalNew, ...prev].slice(0, 20));
            break;
          case "sl.update":
            setSlUpdates((prev) => [msg as SlUpdate, ...prev].slice(0, 20));
            break;
          case "signal.exit":
            setSignalExits((prev) => [msg as SignalExit, ...prev].slice(0, 20));
            break;
        }
      } catch { /* ignore */ }
    };

    ws.onclose = () => {
      setConnected(false);
      reconnectTimer.current = setTimeout(() => connect(), 3000);
    };

    ws.onerror = () => { ws.close(); };
  }, [symbol]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); }
    };
  }, [connect]);

  return {
    connected,
    lastPrice,
    isMarketOpen,
    marketPrice,
    newSignals,
    slUpdates,
    signalExits,
  };
}
