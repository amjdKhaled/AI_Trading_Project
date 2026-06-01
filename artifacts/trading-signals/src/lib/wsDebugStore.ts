// Lightweight singleton that collects frontend-side pipeline telemetry.
// Written to by: useMarketSocket (msg counts) and CandleStateManager (chart updates).
// Read by: WsDebugPanel.
//
// No React involved — plain JS module singleton so both hooks and classes can write
// to it without prop drilling.

export interface WsDebugFrontend {
  frontendMsgCount:  number;
  lastSymbol:        string | null;
  lastPrice:         number | null;
  lastMsgTime:       number | null;   // Date.now() ms
  chartUpdates:      number;          // writeToSeries calls (accepted ticks)
  chartRejects:      Record<string, number>; // reason → count
}

let _state: WsDebugFrontend = {
  frontendMsgCount: 0,
  lastSymbol:       null,
  lastPrice:        null,
  lastMsgTime:      null,
  chartUpdates:     0,
  chartRejects:     {},
};

const _listeners = new Set<() => void>();

export function patchWsDebug(patch: Partial<WsDebugFrontend>): void {
  _state = { ..._state, ...patch };
  for (const fn of _listeners) fn();
}

export function getWsDebug(): WsDebugFrontend {
  return _state;
}

export function subscribeWsDebug(fn: () => void): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

export function resetWsDebug(): void {
  _state = {
    frontendMsgCount: 0,
    lastSymbol:       null,
    lastPrice:        null,
    lastMsgTime:      null,
    chartUpdates:     0,
    chartRejects:     {},
  };
  for (const fn of _listeners) fn();
}
