import cors from "cors";
import express, { type ErrorRequestHandler, type RequestHandler, type Router } from "express";

export function createApp({ routers, httpLogger, errorHandler, clientOrigin }: {
  routers: { tasks: Router; areas: Router; routines: Router };
  httpLogger: RequestHandler;
  errorHandler: ErrorRequestHandler;
  clientOrigin: string;
}) {
  const app = express();

  app.use(httpLogger);
  app.use(cors({ origin: clientOrigin, exposedHeaders: ["X-Request-Id"] }));
  app.use(express.json());

  app.get("/api/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.use("/api/tasks", routers.tasks);
  app.use("/api/areas", routers.areas);
  app.use("/api/routines", routers.routines);

  app.use(errorHandler);
  return app;
}
