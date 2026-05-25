---
name: Live candle architecture
description: Why the server is a pure price relay and the client builds all OHLC — history of the giant-candle bug and the final fix.
---

## The rule
The API server sends ONLY `{ type:"price.update", symbol, price, timestamp }` for live data. It subscribes to Alpaca trades (throttled 1/sec) and 1-minute bars (immediate on close). It never constructs OHLC. The client builds candles from the price stream.

## Why
Three layered bugs caused giant/malformed candles:

1. **Snapshot `open` field** — `fetchAlpacaSnapshot().dailyBar.o` is the DAY's open, not the current bar's open. Using it seeded every live bar with a many-dollar open deviation.

2. **`bar.final` OHLC overwrite** — Alpaca WS IEX streams only 1-MINUTE bars. Broadcasting them as `bar.final` replaced the accumulated 5m/15m OHLC with one minute of data every minute.

3. **Polling race** — Two concurrent writers (`pollSnapshots` HTTP + Alpaca WS bars) could arrive in any order and overwrite each other's accumulated OHLC state.

**Definitive fix:** server becomes a stateless price relay. One writer per chart: the client-side `useEffect` in `TradingChart.tsx` that builds OHLC from `lastPrice.price`.

## How to apply
- Server: `websocket.ts` subscribes `{ trades: [...], bars: [...] }`. Trades throttled at `TRADE_THROTTLE_MS = 1000ms`. Bar close bypasses throttle.
- Client: `TradingChart.tsx` live bar state machine uses only `lastPrice.price` + `lastPrice.timestamp`. No OHLC fields from server ever.
- G4 ATR filter now checks `Math.abs(price - refPrice) > maxDelta` (scalar, not range).
- SL/TP detection in `ChartPage.tsx` uses `lastPrice.price` directly (crossing check, not H/L).
- `BarUpdate` type removed from codebase; replaced by `PriceUpdate`.
