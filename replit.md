# Signal — AI Trading Platform

A professional real-time trading signals platform with live NASDAQ candlestick charts, an AI signal engine, and a WebSocket data pipeline.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm --filter @workspace/trading-signals run dev` — run the frontend (port 22428)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)

## Required env

- `DATABASE_URL` — Postgres connection string (provisioned automatically)
- `SESSION_SECRET` — session signing secret
- `FINNHUB_API_KEY` — Finnhub API key for live market data

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite, Lightweight Charts v5, Tailwind, shadcn/ui, wouter
- API: Express 5 + WebSocket (`ws`)
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- Market data: Finnhub (free tier — quote + WebSocket trades)
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — OpenAPI contract (source of truth for all routes)
- `lib/api-zod/` — Zod schemas generated from OpenAPI
- `lib/api-client-react/` — React Query hooks generated from OpenAPI
- `lib/db/` — Drizzle ORM schema (`symbols`, `signals` tables)
- `artifacts/api-server/src/lib/finnhub.ts` — Finnhub REST + WebSocket client
- `artifacts/api-server/src/lib/websocket.ts` — live bar builder + signal broadcaster
- `artifacts/api-server/src/lib/indicators.ts` — EMA, RSI, ATR, VWAP, MACD, signal scoring
- `artifacts/api-server/src/routes/` — Express route handlers
- `artifacts/trading-signals/src/components/TradingChart.tsx` — Lightweight Charts v5 wrapper
- `artifacts/trading-signals/src/hooks/useMarketSocket.ts` — WebSocket React hook

## Architecture decisions

- **Finnhub free tier only supports quote + WebSocket** — historical 5m candles require premium. We build synthetic seed bars from the current-day quote on startup, then replace with real ticks as they arrive via WebSocket.
- **Bar builder lives in websocket.ts** — trades from Finnhub WS are aggregated into 5m OHLCV bars in memory per symbol; history is exported via `getBarHistory()` for the REST bars endpoint.
- **Signal engine runs on bar close** — `scoreSignal()` in `indicators.ts` computes EMA, RSI, ATR, VWAP, MACD, regime detection and engulfing patterns. Signals are only emitted above a 62-point confidence threshold to filter noise.
- **No repaint** — signals are written to DB on bar close and never mutate after insertion.
- **WebSocket proxy** — the `/ws` path is registered in `artifact.toml` so the Replit proxy forwards WS upgrades to the API server.

## Product

- Live 5m NASDAQ candlestick chart (Lightweight Charts v5, dark institutional UI)
- Watchlist panel with quick-add for NVDA, AAPL, AMD, MSFT, TSLA, QQQ
- AI signal engine: LONG/SHORT arrows anchored to candles with confidence %, SL/TP levels
- Signal history page with win-rate stats
- Real-time price updates via Finnhub WebSocket (live ticks → bar aggregation)

## User preferences

- Keep chart clean and minimal — no indicator overlays on chart, signals only
- Dark institutional color scheme (#0b0e14 background)
- Signals display: confidence %, pattern name, regime, SL/TP prices

## Gotchas

- Finnhub free plan: `/stock/candle` returns 403 for intraday resolutions — use `buildSeedBars()` as fallback
- Lightweight Charts v5 API changed: use `chart.addSeries(CandlestickSeries, ...)` and `createSeriesMarkers(series, [])` instead of v4 methods
- Always align bar times to `time - (time % 300)` before calling `series.update()`
- esbuild bundles everything into `dist/index.mjs` — dynamic imports work but must be awaited
