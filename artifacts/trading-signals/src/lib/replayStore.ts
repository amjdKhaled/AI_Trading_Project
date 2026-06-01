export interface ReplayMarkerItem {
  candleTime: number;
  decision:   "LONG" | "SHORT";
  entry:      number | null;
  stopLoss:   number | null;
  takeProfit: number | null;
  rrRatio:    number | null;
  confidence: number;
}

type Listener = (key: string, markers: ReplayMarkerItem[]) => void;

let _key     = "";
let _markers: ReplayMarkerItem[] = [];
const _listeners = new Set<Listener>();

export function setReplayMarkers(key: string, markers: ReplayMarkerItem[]): void {
  _key     = key;
  _markers = markers;
  for (const fn of _listeners) fn(key, markers);
}

export function getReplayState(): { key: string; markers: ReplayMarkerItem[] } {
  return { key: _key, markers: _markers };
}

export function subscribeReplayMarkers(fn: Listener): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

export function clearReplayMarkers(): void {
  setReplayMarkers("", []);
}
