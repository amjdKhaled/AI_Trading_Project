---
name: Polygon migration status
description: What was done in the Polygon real-time migration, what works, and what the user still needs to do.
---

## What is already Polygon-native (all US equity data)
- Historical bars: `fetchPolygonBars` in polygon.ts → all timeframes (5m, 15m, 1h, 1d, 1w, 1M)
- Live price relay: websocket.ts connects to `wss://socket.polygon.io/stocks` (T.* + AM.*), falls back to delayed, then disables
- Snapshots: `fetchPolygonSnapshot` — price, daily OHLCV, prevClose
- News: Polygon /v2/reference/news (news.ts + ai/news.ts)
- UDF (TradingView datafeed adapter): all timeframes via fetchPolygonBars, data_status = "streaming"

## Crypto stays on Binance
- useBinanceSocket.ts (frontend WS) + routes/crypto.ts (Binance REST klines)
- Appropriate: Polygon crypto requires a separate add-on tier

## Dead code removed from routing
- bars.ts (synthetic mock PRNG bars) deregistered from routes/index.ts — file exists but is unreachable

## Diagnostics page added
- GET /api/diagnostics?symbol=X&interval=Y → snapshot + latestBars + getWsStatus()
- DiagnosticsPage.tsx at /diagnostics nav link

## Critical blocker — user must update POLYGON_API_KEY
- Current key = "Unknown API Key" (HTTP 401 on all Polygon REST calls)
- WS permanently disabled (wsPermanentlyDisabled = true) because both endpoints rejected old key
- After user updates POLYGON_API_KEY in Replit Secrets and restarts server:
  - wsPermanentlyDisabled resets (module-level, clears on restart)
  - WS will authenticate on wss://socket.polygon.io/stocks (Stocks Starter+ plan)
  - REST calls (bars, snapshot, news) will succeed
  - Diagnostics page will show live Polygon data
