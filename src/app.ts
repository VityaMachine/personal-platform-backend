import cors from "cors";
import express, { type RequestHandler } from "express";

import { errorHandler } from "./middleware/error-handler";
import { requestLogger } from "./middleware/request-logger";
import { tasksRouter } from "./modules/tasks/tasks.routes";

const clientOrigin = process.env.CLIENT_ORIGIN ?? "http://localhost:3000";

export function createApp(httpLogger: RequestHandler = requestLogger) {
  const app = express();

  app.use(httpLogger);
  app.use(cors({ origin: clientOrigin, exposedHeaders: ["X-Request-Id"] }));
  app.use(express.json());

  app.get("/api/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.use("/api/tasks", tasksRouter);

  app.use(errorHandler);
  return app;
}

export const app = createApp();
