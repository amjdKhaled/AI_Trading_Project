import { useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { useListSymbols } from "@workspace/api-client-react";
import { useActiveSymbol } from "@/lib/ActiveSymbolContext";
import { toast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";

const MIN_CONFIDENCE  = 70;
const POLL_INTERVAL   = 30_000;    // 30 s between polls
const LOOKBACK_ON_INIT = 5 * 60_000; // surface alerts from last 5 min on first mount

interface AlertRow {
  id:         number;
  symbol:     string;
  timeframe:  string;
  verdict:    string;
  confidence: number;
  entryPrice: number | null;
  rrRatio:    number | null;
  regime:     string | null;
  candleTime: string;
  createdAt:  string;
}

export function useSignalAlerts() {
  const { activeSymbol, setActiveSymbol } = useActiveSymbol();
  const [, navigate]                       = useLocation();
  const { data: symbolsData }              = useListSymbols();

  const lastCheckedRef   = useRef<number>(Date.now() - LOOKBACK_ON_INIT);
  const seenIdsRef       = useRef<Set<number>>(new Set());
  const activeSymbolRef  = useRef<string | null>(activeSymbol);

  useEffect(() => {
    activeSymbolRef.current = activeSymbol;
  }, [activeSymbol]);

  useEffect(() => {
    if (!symbolsData || symbolsData.length === 0) return;

    const checkAlerts = async () => {
      const symbols = symbolsData.map((s) => s.symbol);
      const since   = lastCheckedRef.current;
      lastCheckedRef.current = Date.now();

      try {
        const base   = (import.meta.env.BASE_URL ?? "").replace(/\/$/, "");
        const params = new URLSearchParams({
          since:         String(since),
          symbols:       symbols.join(","),
          minConfidence: String(MIN_CONFIDENCE),
        });
        const res = await fetch(`${base}/api/signals/alerts?${params}`);
        if (!res.ok) return;

        const alerts: AlertRow[] = await res.json();

        for (const alert of alerts) {
          if (seenIdsRef.current.has(alert.id)) continue;
          seenIdsRef.current.add(alert.id);

          if (alert.symbol === activeSymbolRef.current) continue;

          const isLong  = alert.verdict === "LONG";
          const rrText  = alert.rrRatio ? ` · R:R ${alert.rrRatio.toFixed(1)}` : "";
          const regText = alert.regime  ? ` · ${alert.regime}`                 : "";

          const sym = alert.symbol;

          toast({
            title: `${isLong ? "📈" : "📉"} ${alert.verdict} Signal — ${sym}`,
            description: `${alert.confidence}% confidence · ${alert.timeframe}${rrText}${regText}`,
            action: (
              <ToastAction
                altText={`View ${sym} chart`}
                onClick={() => {
                  setActiveSymbol(sym);
                  navigate("/");
                }}
              >
                View →
              </ToastAction>
            ),
          });
        }
      } catch {
        // Silently ignore — alerting is best-effort
      }
    };

    checkAlerts();
    const id = setInterval(checkAlerts, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [symbolsData, navigate, setActiveSymbol]);
}
