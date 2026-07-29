import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { bronzeSilverRouter } from "./routes/bronzeSilver.js";
import { catalogRouter } from "./routes/catalog.js";
import { connectionsRouter } from "./routes/connections.js";
import { levelsRouter } from "./routes/levels.js";
import { lineageRouter } from "./routes/lineage.js";
import { localRouter } from "./routes/local.js";
import { notebooksRouter } from "./routes/notebooks.js";
import { pipelineRouter } from "./routes/pipeline.js";
import { reconcileRouter } from "./routes/reconcile.js";
import { validateLogicRouter } from "./routes/validateLogic.js";

// Resolve .env relative to this file (not process.cwd()) so it loads correctly
// no matter which directory the server is started from.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, "../.env");
const dotenvResult = dotenv.config({ path: envPath });
console.log("[index] loading .env", {
  path: envPath,
  loaded: !dotenvResult.error,
  error: dotenvResult.error?.message,
});

const app = express();
const PORT = Number(process.env.PORT ?? 4000);

app.use(cors());
// Generous limit because /api/local/scan posts the text of every SQL file in an uploaded folder in
// one request; the route caps file count and total bytes itself.
app.use(express.json({ limit: "25mb" }));

app.use("/api/connections", connectionsRouter);
app.use("/api/catalogs", catalogRouter);
app.use("/api/notebooks", notebooksRouter);
app.use("/api/reconcile", reconcileRouter);
app.use("/api/bronze-silver", bronzeSilverRouter);
app.use("/api/lineage", lineageRouter);
app.use("/api/validate-logic", validateLogicRouter);
app.use("/api/levels", levelsRouter);
app.use("/api/pipeline", pipelineRouter);
app.use("/api/local", localRouter);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`recon server listening on http://localhost:${PORT}`);
});
