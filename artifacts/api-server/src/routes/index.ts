import { Router, type IRouter } from "express";
import healthRouter from "./health";
import symbolsRouter from "./symbols";
import signalsRouter from "./signals";
import historyRouter from "./history";
import udfRouter from "./udf";
import aiRouter from "./ai";
import cryptoRouter from "./crypto";
import newsRouter from "./news";
import diagnosticsRouter from "./diagnostics";

const router: IRouter = Router();

router.use(healthRouter);
router.use(symbolsRouter);
router.use(signalsRouter);
router.use(historyRouter);
router.use(udfRouter);
router.use(aiRouter);
router.use(cryptoRouter);
router.use(newsRouter);
router.use(diagnosticsRouter);

export default router;
