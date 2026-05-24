import { useState, useEffect, useRef, useCallback } from "react";

export interface BarUpdate {
  type: "bar.partial" | "bar.final";
  symbol: string;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
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

export type MarketEvent = BarUpdate | SignalNew | SlUpdate | SignalExit;

interface UseMarketSocketResult {
  connected: boolean;
  lastBar: BarUpdate | null;
  newSignals: SignalNew[];
  slUpdates: SlUpdate[];
  signalExits: SignalExit[];
}

export function useMarketSocket(symbol: string | null): UseMarketSocketResult {
  const [connected, setConnected] = useState(false);
  const [lastBar, setLastBar] = useState<BarUpdate | null>(null);
  const [newSignals, setNewSignals] = useState<SignalNew[]>([]);
  const [slUpdates, setSlUpdates] = useState<SlUpdate[]>([]);
  const [signalExits, setSignalExits] = useState<SignalExit[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    if (!symbol) return;
    if (wsRef.current) {
      wsRef.current.close();
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    const basePath = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
    const url = `${protocol}//${host}${basePath}/ws?symbol=${encodeURIComponent(symbol)}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
    };

    ws.onmessage = (ev) => {
      try {
        const msg: MarketEvent = JSON.parse(ev.data);
        if (msg.type === "bar.partial" || msg.type === "bar.final") {
          setLastBar(msg as BarUpdate);
        } else if (msg.type === "signal.new") {
          setNewSignals((prev) => [msg as SignalNew, ...prev].slice(0, 20));
        } else if (msg.type === "sl.update") {
          setSlUpdates((prev) => [msg as SlUpdate, ...prev].slice(0, 20));
        } else if (msg.type === "signal.exit") {
          setSignalExits((prev) => [msg as SignalExit, ...prev].slice(0, 20));
        }
      } catch {
        // ignore
      }
    };

    ws.onclose = () => {
      setConnected(false);
      reconnectTimer.current = setTimeout(() => connect(), 3000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [symbol]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    };
  }, [connect]);

  return { connected, lastBar, newSignals, slUpdates, signalExits };
}
