import { Router, type IRouter } from "express";
import healthRouter from "./health";
import symbolsRouter from "./symbols";
import signalsRouter from "./signals";
import barsRouter from "./bars";
import historyRouter from "./history";

const router: IRouter = Router();

router.use(healthRouter);
router.use(symbolsRouter);
router.use(signalsRouter);
router.use(barsRouter);
router.use(historyRouter);

export default router;
