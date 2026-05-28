---
name: Express 5 silent 500s
description: Why async route handlers in this api-server need a 4-arg error middleware and per-route try/catch with phase tracking.
---

Express 5 forwards rejected promises from `async (req, res) => Promise<void>` handlers to its default error path. Without a registered 4-arg error middleware `(err, req, res, next)` placed AFTER `app.use("/api", router)`, the client receives a generic 500 with an empty body and the real exception is silently dropped — no stack, no log line beyond pino-http's status code.

**Why this bit us:** the user saw `GET /api/signals -> 500` locally for weeks with no actionable info because every handler was `async` returning `Promise<void>` and there was no global error handler. Pino-http logged "request completed statusCode 500" and nothing else.

**How to apply:**
- Every new async route should either fully wrap its body in try/catch OR rely on the global handler in `app.ts` for unhandled rejections.
- For routes with multiple awaited steps (DB select → external fetch → engine → DB insert → schema parse), use a `phase` string variable updated before each step and include it in the catch's log + JSON response. The user immediately knows whether it was Polygon, the engine, the DB, or zod that blew up.
- Inner best-effort try/catch blocks (e.g. signal seeding) must be NARROW — wrap only the steps that are genuinely allowed to fail silently. Putting the post-seed re-select or response parse inside the inner catch hides real DB/schema regressions as "seeding failed".
- Dev-mode JSON error responses should include `stack` so Windows users debugging without log access see the real exception; gate behind `NODE_ENV !== "production"`.
