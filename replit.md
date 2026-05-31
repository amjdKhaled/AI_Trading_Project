# Trading Signals

Institutional-grade trading signal analysis platform with local AI (Ollama) reflection. Streams real-time price data from Polygon.io, runs an aggressive-smart v3 signal engine, and persists trade memory for AI-powered regime and strategy analysis.

## Run & Operate (Replit)

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Windows Local Development

**Requirements:** Node.js 22 LTS, pnpm, VS Code, Ollama (for AI features), RTX 2070 / 32GB RAM

### First-time setup

```powershell
# 1. Install pnpm globally if not already installed
npm install -g pnpm

# 2. Clone/copy the project, then install all dependencies
pnpm install

# 3. Create a .env file at the project root (copy from .env.example).
#    The API server and drizzle-kit both load this automatically —
#    you do NOT need to export env vars in every terminal session.
#
#    Minimum contents of .env:
#      DATABASE_URL=postgresql://postgres:password@localhost:5432/trading_signals
#      POLYGON_API_KEY=your_polygon_api_key
#      SESSION_SECRET=any_random_string
#
#    (see .env.example in the project root for a ready-to-copy template)

# 4. CREATE THE DATABASE SCHEMA — run once after creating .env.
#    Without this every API call returns "relation does not exist" 500s.
#    The server prints the exact fix command if you forget this step.
pnpm --filter @workspace/db run push
```

### Run services (open separate terminals for each)

```powershell
# Terminal 1 — API server (http://localhost:5000)
pnpm --filter @workspace/api-server run dev

# Terminal 2 — Frontend (http://localhost:5173)
pnpm --filter @workspace/trading-signals run dev

# Terminal 3 — AI (Ollama)
ollama serve
# Pull the model once:
ollama pull qwen3:8b
```

### Open the app

- Frontend: http://localhost:5173
- API health: http://localhost:5000/api/healthz
- AI status: http://localhost:5000/api/ai/status

### Notes

- No `PORT` or `BASE_PATH` env vars needed locally — Vite defaults to port 5173 for the frontend and 5174 for the mockup sandbox.
- The Replit-specific plugins (`@replit/vite-plugin-cartographer`, `@replit/vite-plugin-dev-banner`) are automatically skipped when `REPL_ID` is not set (i.e. on your local machine).
- `scripts/post-merge.sh` is a Replit-internal hook — ignore it on Windows.
- The `DATABASE_URL` must point to a local PostgreSQL instance. Use [PostgreSQL for Windows](https://www.postgresql.org/download/windows/) or Docker.
- After cloning or pulling changes that touch `pnpm-workspace.yaml`, re-run `pnpm install` to update the lockfile.

## Stack

- pnpm workspaces, Node.js 22 LTS, TypeScript 5.9
- API: Express 5 + esbuild bundler
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- Frontend: React 19 + Vite 7 + Tailwind CSS 4 + Lightweight Charts
- AI: Ollama (local) — model `qwen3:8b` (fallback: `qwen2.5:7b`), no cloud inference
- API codegen: Orval (from OpenAPI spec)

## Where things live

- `artifacts/api-server/src/` — Express API server
  - `routes/` — API route handlers
  - `lib/analyzer/signals.ts` — aggressive-smart v3 signal engine
  - `lib/ai/` — Ollama client, trade memory, reflection, filter
  - `memory/trades.json` — persisted trade memory (AI learning store)
- `artifacts/trading-signals/src/` — React frontend
  - `pages/` — Chart, Signals, Watchlist, AI Engine pages
  - `components/` — UI components
- `lib/db/` — Drizzle schema + migrations
- `lib/api-spec/` — OpenAPI contract (source of truth for API types)
- `lib/api-zod/` — Generated Zod schemas from OpenAPI spec
- `lib/api-client-react/` — Generated React Query hooks from OpenAPI spec

## Architecture decisions

- **Contract-first API**: OpenAPI spec in `lib/api-spec` is the source of truth; Zod schemas and React Query hooks are generated from it via Orval.
- **Pure server relay**: WebSocket server is a pure price relay — `CandleStateManager` on the client is the sole writer to `candleSeries.update()`.
- **Local AI only**: All AI features use Ollama with `qwen3:8b` (fallback: `qwen2.5:7b`). No cloud inference, no OpenAI API keys.
- **Platform-agnostic native deps**: `pnpm-workspace.yaml` overrides are limited to version pins only — platform binary selection (esbuild, rollup, lightningcss, @tailwindcss/oxide) is handled by pnpm's native optional-dependency resolution, which installs only the binary for the current OS.
- **`cross-env`** wraps the api-server `dev` script so `NODE_ENV=development` is set correctly on both Windows and Linux.

## Product

- Real-time candlestick chart (Lightweight Charts) with live Polygon.io price feed
- Signal engine with regime-adaptive scoring: trending, vol-expansion, ranging, chop
- Watchlist management with per-symbol signal history
- AI Engine: trade memory, per-strategy win rates, Ollama-powered signal reflection

## User preferences

- Local AI only — Ollama + qwen3:8b (fallback qwen2.5:7b), no cloud inference, no OpenAI
- Windows 11 / Node 22 LTS / RTX 2070 8GB / 32GB RAM is the primary local dev environment
- Do not rewrite the app — prefer minimal targeted fixes

## Gotchas

- **Polygon rate limit**: Free tier = 5 req/min. Wait ~16s between TSLA and NVDA signal regenerations.
- **yfinance daily bars**: Timestamped at midnight ET (04:00 UTC). Correct daily bias offset = 17h to avoid lookahead.
- **AI bootstrap**: After regenerating signals, use the "Import Trades" button on the AI Engine page (or POST `/api/ai/reflect/batch`) to reload trade memory.
- **pnpm lockfile**: After changing `pnpm-workspace.yaml`, always run `pnpm install` (without `--frozen-lockfile`) to regenerate the lockfile.
- **Do not run `pnpm run dev` at the workspace root** — there is no root dev script. Run each service with `--filter`.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- `.agents/memory/` — agent memory: engine calibration, daily bias lessons, candle rendering, Polygon data source notes
