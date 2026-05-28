import { config } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Load .env from the project root if it exists.
// This must be the first import in index.ts so env vars are available
// before any module (including lib/db) initializes at the top level.
//
// Path logic: in the esbuild bundle (dist/index.mjs), import.meta.dirname
// is <project>/artifacts/api-server/dist/ — three levels up is the project root.
// In the TypeScript source (src/), it is one level shallower but esbuild
// rewrites it at bundle time so the runtime path is always from dist/.
const projectRoot = resolve(import.meta.dirname, "..", "..", "..");
const envFile = resolve(projectRoot, ".env");

if (existsSync(envFile)) {
  config({ path: envFile });
}
