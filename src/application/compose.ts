import type { Logger } from "pino";
import type { PrismaClient } from "../generated/prisma/client";
import { createApp } from "../app";
import { createDeleteArea } from "./delete-area";
import type { ApplicationConfig } from "../config/config";
import { getPrisma } from "../infrastructure/database/prisma";
import { createLogger } from "../infrastructure/logging/logger";
import { errorHandler } from "../http/middleware/error-handler";
import { createRequestLogger } from "../http/middleware/request-logger";
import { createAreasRepository } from "../modules/areas/areas.repository";
import { createAreasService } from "../modules/areas/areas.service";
import { createAreasRouter } from "../modules/areas/http/areas.routes";
import { createTasksRepository } from "../modules/tasks/tasks.repository";
import { createTasksService } from "../modules/tasks/tasks.service";
import { detachAreaLinks } from "../modules/tasks/area-links";
import { createTasksRouter } from "../modules/tasks/http/tasks.routes";
import { createRoutinesRepository } from "../modules/tasks/routines/routines.repository";
import { createRoutinesService } from "../modules/tasks/routines/routines.service";
import { createRoutinesRouter } from "../modules/tasks/routines/http/routines.routes";
import { createRoutineRunner } from "../modules/tasks/routines/runner/routines.runner";

export function composeApplication({ config, client = getPrisma, now = () => new Date(), logger = createLogger() }: {
  config: ApplicationConfig;
  client?: () => PrismaClient;
  now?: () => Date;
  logger?: Logger;
}) {
  const tasks = createTasksService(createTasksRepository(client), now);
  const areasRepository = createAreasRepository(client);
  const areas = createAreasService(areasRepository);
  const deleteArea = createDeleteArea(areasRepository, detachAreaLinks);
  const routinesRepository = createRoutinesRepository(client);
  const routines = createRoutinesService(routinesRepository, now);

  return {
    createHttpApp() {
      return createApp({
        routers: {
          tasks: createTasksRouter(tasks),
          areas: createAreasRouter(areas, deleteArea),
          routines: createRoutinesRouter(routines),
        },
        httpLogger: createRequestLogger(logger),
        errorHandler,
        clientOrigin: config.clientOrigin,
      });
    },
    createRunner() {
      return createRoutineRunner({ repository: routinesRepository, service: routines, logger, clock: () => now().getTime() });
    },
  };
}
