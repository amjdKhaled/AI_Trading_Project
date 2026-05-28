import { defineConfig } from "drizzle-kit";
import path from "path";
import { existsSync } from "node:fs";
import { config as loadDotenv } from "dotenv";

// Auto-load .env from the project root so `pnpm --filter @workspace/db run push`
// works without manually exporting DATABASE_URL in every terminal session.
// The .env file is the same one the API server uses (api-server/src/env.ts).
// drizzle.config.ts lives at lib/db/ — two levels up is the project root.
const projectRoot = path.resolve(__dirname, "../..");
const envFile    = path.resolve(projectRoot, ".env");
if (existsSync(envFile)) {
  loadDotenv({ path: envFile });
}

if (!process.env.DATABASE_URL) {
  throw new Error(
    "\n\nDATABASE_URL is not set.\n" +
    "────────────────────────────────────────────────────\n" +
    "Option A (recommended) — create a .env file at the\n" +
    "project root (copy from .env.example):\n" +
    "  DATABASE_URL=postgresql://user:password@localhost:5432/trading_signals\n\n" +
    "Option B — set it in your current terminal session:\n" +
    "  PowerShell:  $env:DATABASE_URL = \"postgresql://...\"\n" +
    "  bash/zsh:    export DATABASE_URL=postgresql://...\n\n" +
    "Then re-run: pnpm --filter @workspace/db run push\n" +
    "────────────────────────────────────────────────────\n",
  );
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
