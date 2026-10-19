import cors from "cors";
import express from "express";

import { errorHandler } from "./middleware/error-handler";
import { tasksRouter } from "./routes/tasks";

const clientOrigin = process.env.CLIENT_ORIGIN ?? "http://localhost:3000";

export const app = express();

app.use(cors({ origin: clientOrigin }));
app.use(express.json());

app.get("/api/health", (_request, response) => {
  response.json({ status: "ok" });
});

app.use("/api/tasks", tasksRouter);

app.use(errorHandler);
