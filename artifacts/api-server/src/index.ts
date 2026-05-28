import "./env.js"; // Must be first — loads .env before any other module initializes
import http from "http";
import app from "./app";
import { logger } from "./lib/logger";
import { setupWebSocket } from "./lib/websocket";
import { db, signalsTable, symbolsTable } from "@workspace/db";
import { sql } from "drizzle-orm";

// ── Startup DB validation ────────────────────────────────────────────────────
// Runs before the HTTP server binds. If the schema has never been pushed
// (common on a fresh Windows clone), every route blows up with a cryptic
// "relation does not exist" 500. We catch that here and print the exact
// command the user needs to run — no more mystery 500s on first boot.
async function validateSchema(): Promise<void> {
  const REQUIRED = [
    { table: "signals",  drizzle: signalsTable },
    { table: "symbols",  drizzle: symbolsTable },
  ];

  const missing: string[] = [];

  for (const { table } of REQUIRED) {
    try {
      // Use a raw existence check rather than SELECT so we don't need rows.
      await db.execute(sql`SELECT 1 FROM ${sql.identifier(table)} LIMIT 1`);
    } catch (err) {
      const msg = String((err as Error).message ?? err);
      if (msg.includes("does not exist") || msg.includes("relation")) {
        missing.push(table);
      } else {
        // Unexpected DB error (connection refused, auth failure, etc.)
        logger.fatal(
          { err, table },
          "DB connectivity check failed — is PostgreSQL running and DATABASE_URL correct?",
        );
        process.exit(1);
      }
    }
  }

  if (missing.length > 0) {
    // Print a human-readable block so it's impossible to miss in terminal output.
    logger.fatal(
      { missing },
      [
        "",
        "════════════════════════════════════════════════════════",
        "  DATABASE SCHEMA MISSING — server cannot start",
        "════════════════════════════════════════════════════════",
        `  Missing tables: ${missing.join(", ")}`,
        "",
        "  Run this command ONCE to create the schema:",
        "    pnpm --filter @workspace/db run push",
        "",
        "  On Windows, set DATABASE_URL first:",
        '    $env:DATABASE_URL = "postgresql://user:pass@localhost:5432/trading_signals"',
        "    pnpm --filter @workspace/db run push",
        "",
        "  Then restart the API server.",
        "════════════════════════════════════════════════════════",
      ].join("\n"),
    );
    process.exit(1);
  }

  logger.info("DB schema OK — signals + symbols tables present");
}

// ── Symbol seeding ───────────────────────────────────────────────────────────
// Seeds the default watchlist on first run so the UI is not empty.
// Safe to call on every boot — only inserts when the table is completely empty.
const DEFAULT_SYMBOLS = [
  { symbol: "NVDA", name: "NVIDIA Corporation" },
  { symbol: "TSLA", name: "Tesla, Inc." },
  { symbol: "AAPL", name: "Apple Inc." },
  { symbol: "AMD",  name: "Advanced Micro Devices" },
  { symbol: "MSFT", name: "Microsoft Corporation" },
  { symbol: "QQQ",  name: "Invesco QQQ Trust" },
];

async function seedSymbols(): Promise<void> {
  const existing = await db.select().from(symbolsTable).limit(1);
  if (existing.length > 0) return; // Already seeded — nothing to do

  for (const s of DEFAULT_SYMBOLS) {
    try {
      await db.insert(symbolsTable).values(s);
    } catch { /* unique violation — race or duplicate; safe to skip */ }
  }
  logger.info(
    { symbols: DEFAULT_SYMBOLS.map(s => s.symbol) },
    "Seeded default watchlist symbols",
  );
}

// ── Boot sequence ────────────────────────────────────────────────────────────
// On Replit, PORT is injected by the workflow system.
// For local development, fall back to 5000.
const port = Number(process.env["PORT"] ?? "5000");

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${process.env["PORT"]}"`);
}

// Validate schema before binding — keeps error messages clear and actionable.
await validateSchema();
await seedSymbols();

const server = http.createServer(app);
setupWebSocket(server);

server.listen(port, () => {
  logger.info({ port }, "Server listening");
});

server.on("error", (err) => {
  logger.error({ err }, "Error listening on port");
  process.exit(1);
});
