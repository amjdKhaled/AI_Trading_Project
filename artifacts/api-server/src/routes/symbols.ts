import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, symbolsTable } from "@workspace/db";
import {
  ListSymbolsResponse,
  AddSymbolBody,
  RemoveSymbolParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/symbols", async (req, res): Promise<void> => {
  const rows = await db.select().from(symbolsTable).orderBy(symbolsTable.addedAt);
  res.json(ListSymbolsResponse.parse(rows));
});

router.post("/symbols", async (req, res): Promise<void> => {
  const parsed = AddSymbolBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db.insert(symbolsTable).values(parsed.data).returning();
  res.status(201).json(row);
});

router.delete("/symbols/:id", async (req, res): Promise<void> => {
  const params = RemoveSymbolParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .delete(symbolsTable)
    .where(eq(symbolsTable.id, params.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Symbol not found" });
    return;
  }
  res.sendStatus(204);
});

export default router;
