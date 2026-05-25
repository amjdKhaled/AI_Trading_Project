---
name: Live candle architecture
description: Why the server is a pure price relay and a single CandleStateManager owns all OHLC construction client-side. Background on the giant-candle bug history.
---

## The rule
The API server sends ONLY `{ type:"price.update", symbol, price, timestamp }` for live data. It subscribes to Alpaca trades (throttled 1/sec) and 1-minute bars (immediate on close). It never constructs OHLC. The client's `CandleStateManager` class is the SOLE writer to `candleSeries.update()` — no other call site exists.

## Why
Three layered bugs caused giant/malformed candles:

1. **Snapshot `open` field** — `fetchAlpacaSnapshot().dailyBar.o` is the DAY's open, not the current bar's open. Using it seeded every live bar with a many-dollar deviation.
2. **`bar.final` OHLC overwrite** — Alpaca WS IEX streams only 1-MINUTE bars. Broadcasting them as `bar.final` replaced accumulated 5m/15m OHLC every minute.
3. **Polling race** — Two concurrent writers (`pollSnapshots` HTTP + Alpaca WS bars) could overwrite each other's accumulated state.

## How to apply
- Server: `websocket.ts` only subscribes `{ trades, bars }` from Alpaca IEX, sends `price.update` per symbol throttled at 1Hz, bypassing throttle on 1-min bar close.
- Client: instantiate `CandleStateManager` in chart-init `useEffect`; pass it getters (not values) for symbol/interval so it always reads live config.
- Forward every WS tick via `csm.ingestTick(symbol, price, timestampSec)`. The manager runs validation guards (wrong_symbol, market_closed, invalid_price, spike_filtered, before_history, stale_tick, malformed_ohlc) and emits telemetry counters.
- Bars are `Object.freeze`d immutable records; new object on every tick — never mutate.
- Spike filter when ATR is available: `max(ATR*5, price*2%)`. Fallback when ATR=0: `price*1%` (tight enough for liquid equities — 5% was way too loose for high-priced stocks like NVDA).
- Telemetry React state updates must be throttled (~2s) or only pushed on notable events (bar finalized, new rejection). Pushing on every tick re-renders the whole chart's SVG overlay and kills the incremental-update path that makes lightweight-charts smooth.
- `lastHistTimeRef` boundary check (`t <= lastHist`) prevents live ticks from corrupting historical bars.
