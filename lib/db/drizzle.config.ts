import { defineConfig } from "drizzle-kit";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

// ESM-safe __dirname equivalent. The lib/db package has "type":"module" so
// __dirname is not defined — we derive it from import.meta.url instead.
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// Auto-load .env from the project root so `pnpm --filter @workspace/db run push`
// works without manually exporting DATABASE_URL in every terminal session.
// drizzle.config.ts is at lib/db/ — two levels up is the project root.
const envFile = resolve(__dirname, "../../.env");
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
  // Relative path — drizzle-kit resolves it from this config file's location,
  // which is platform-safe on both Windows and Linux without __dirname hacks.
  schema: "./src/schema/index.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
