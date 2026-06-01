import { Router, type IRouter } from "express";
import { getWsStats } from "../lib/websocket";

const router: IRouter = Router();

// GET /api/ws-stats — live pipeline diagnostics (no auth, debug only)
router.get("/ws-stats", (_req, res): void => {
  res.setHeader("Cache-Control", "no-store");
  res.json(getWsStats());
});

export default router;
