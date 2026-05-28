import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// ── Global error handler ─────────────────────────────────────────────────────
// Express 5 forwards unhandled promise rejections from async route handlers
// here. Without this middleware, the client gets a generic 500 with an empty
// body and the *real* exception is silently discarded. This logs the full
// stack with route context and returns a structured JSON error the frontend
// can actually display.
//
// Signature MUST be (err, req, res, next) with 4 args — Express identifies
// error middleware by arity. The `next` param is required even when unused.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, req: Request, res: Response, _next: NextFunction): void => {
  const route = req.url.split("?")[0];
  const ctx = {
    err,
    stack:  err.stack,
    method: req.method,
    route,
    query:  req.query,
  };
  // Use the per-request pino-http logger when available so the error is
  // correlated with the request line that triggered it.
  (req.log ?? logger).error(ctx, `Unhandled error in ${req.method} ${route}`);

  if (res.headersSent) return;
  res.status(500).json({
    error:   "Internal server error",
    message: err.message,
    route,
    method:  req.method,
    // Stack is included in development to make Windows debugging trivial.
    // In production this is omitted to avoid leaking implementation details.
    ...(process.env.NODE_ENV !== "production" ? { stack: err.stack } : {}),
  });
});

export default app;
