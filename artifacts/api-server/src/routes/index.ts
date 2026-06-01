import { Router, type IRouter } from "express";
import healthRouter from "./health";
import symbolsRouter from "./symbols";
import signalsRouter from "./signals";
import barsRouter from "./bars";
import historyRouter from "./history";
import udfRouter from "./udf";
import aiRouter from "./ai";
import cryptoRouter from "./crypto";
import newsRouter from "./news";

const router: IRouter = Router();

router.use(healthRouter);
router.use(symbolsRouter);
router.use(signalsRouter);
router.use(barsRouter);
router.use(historyRouter);
router.use(udfRouter);
router.use(aiRouter);
router.use(cryptoRouter);
router.use(newsRouter);

export default router;
