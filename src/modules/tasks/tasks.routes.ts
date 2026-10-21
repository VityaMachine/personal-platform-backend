import { Router, type Request, type RequestHandler, type Response } from "express";

import type { PrismaClient } from "../../generated/prisma/client";
import { createTasksController } from "./tasks.controller";
import { createTasksRepository } from "./tasks.repository";
import { createTaskSchema, listTasksSchema, taskIdSchema, updateTaskSchema } from "./tasks.schemas";
import { createTasksService } from "./tasks.service";

const route = <Locals extends Record<string, unknown>>(
  handler: (request: Request, response: Response<unknown, Locals>) => Promise<void>,
): RequestHandler<Request["params"], unknown, unknown, Request["query"], Locals> => (request, response, next) => {
  Promise.resolve(handler(request, response)).catch(next);
};

const validateId: RequestHandler = (request, response, next) => {
  response.locals.id = taskIdSchema.parse(request.params.id);
  next();
};
const validateList: RequestHandler = (request, response, next) => {
  response.locals.query = listTasksSchema.parse(request.query);
  next();
};
const validateCreate: RequestHandler = (request, response, next) => {
  response.locals.body = createTaskSchema.parse(request.body);
  next();
};
const validateUpdate: RequestHandler = (request, response, next) => {
  response.locals.body = updateTaskSchema.parse(request.body);
  next();
};

export function createTasksRouter(client?: () => PrismaClient) {
  const router = Router();
  const controller = createTasksController(createTasksService(createTasksRepository(client)));

  router.get("/", validateList, route(controller.list));
  router.post("/", validateCreate, route(controller.create));
  router.get("/:id/history", validateId, route(controller.history));
  router.get("/:id", validateId, route(controller.get));
  router.patch("/:id", validateId, validateUpdate, route(controller.update));
  router.delete("/:id", validateId, route(controller.remove));

  return router;
}

export const tasksRouter = createTasksRouter();
