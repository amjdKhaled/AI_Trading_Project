---
name: Polygon.io data source (free tier constraints)
description: Constraints and patterns for using Polygon.io as the SIP intraday data source on the free tier.
---

## Why Polygon over Alpaca paper for "match TradingView"
Alpaca paper/free accounts only expose the IEX feed (~2% of US equity volume). All "missing candles / fake dojis / fragmented movement / wrong highs/lows vs TradingView" symptoms trace back to IEX-only data, not aggregation bugs. Polygon serves consolidated SIP (all ~16 US exchanges) on REST even on the free tier, so OHLCV matches TradingView/ThinkOrSwim.

**Why:** No client-side aggregation rewrite can fix sparse IEX coverage — OHLC is first/max/min/last of trades *received*. Fix the data source upstream, not the math downstream.

## Free-tier limits to design around
- 5 REST requests/minute (hard 429 after).
- ~10k bars per response regardless of `limit=50000` request — pagination via `next_url` is needed for larger windows.
- No WebSocket access on either `wss://socket.polygon.io/stocks` (realtime) or `wss://delayed.polygon.io/stocks` (delayed); both reply `auth_failed`. WS requires a paid Stocks plan.
- Historical depth is gated by plan; free tier serves roughly the last 2 years of intraday aggregates.

## How to apply
- **Cap intraday lookback per interval** so cold-cache `/history` fits in one response: 5m → ~180 days, 15m → ~540 days. Larger windows are possible but each extra page costs ~13s due to 429 backoff.
- **429 backoff** in the REST client: wait 13s (just over the 12s "smooth" 5/min window) and retry, max 3 attempts.
- **WS lifecycle**: try realtime first → on `auth_failed` switch to delayed → on second `auth_failed` set a sticky `wsPermanentlyDisabled` flag and stop reconnecting forever (otherwise the reconnect loop hammers Polygon and burns the shared REST budget). On all WS event handlers (`message`/`close`/`error`) guard with `if (ws !== activeSocket) return` to ignore late events from superseded sockets.
- **Tell the client** when WS is permanently disabled via an explicit `market.capability { realtimeAvailable: false, reason: "plan_limit" }` message; render a "HIST ONLY" badge in the chart header so users aren't waiting for live updates that will never arrive.
- **`next_url` requires re-appending `apiKey`** on every paginated hop — Polygon omits the key from the URL it gives you.

## Endpoints in use
- Aggregates: `GET /v2/aggs/ticker/{sym}/range/{mult}/{timespan}/{from_ms}/{to_ms}?adjusted=true&sort=asc&limit=50000`
- Snapshot:   `GET /v2/snapshot/locale/us/markets/stocks/tickers/{sym}`
- WS auth:    `{action:"auth",params:"<API_KEY>"}`; subscribe `{action:"subscribe",params:"T.NVDA,AM.NVDA"}`; trade event `ev:"T"`, minute-aggregate event `ev:"AM"`.

## Bucket alignment gotcha (CRITICAL)
Polygon's `/v2/aggs/ticker/{sym}/range/{mult}/{timespan}/{from}/{to}` anchors the aggregate windows to **whatever `from` value you pass**, not to wall-clock boundaries. If `from` is a ms epoch like `1764180465568` (18:07:45.568 UTC), 5m bars come back at :03/:08/:13/…/:43/:48 instead of :00/:05/:10/…/:40/:45, and the chart will visibly drift from TradingView even though the underlying trades are identical.

**Why:** Polygon treats `from` as the bucket origin. Date strings (`YYYY-MM-DD`) are parsed as 00:00 UTC, which divides evenly into every supported intraday multiplier, so buckets snap to the wall clock.

**How to apply:** Always pass `from`/`to` as `YYYY-MM-DD` strings, never as raw ms epochs. Sanity-check: after a fetch, every bar should satisfy `time % (multiplier * 60) === 0`.
