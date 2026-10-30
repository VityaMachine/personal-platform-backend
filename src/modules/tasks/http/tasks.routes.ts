import { Router, type Request, type RequestHandler, type Response } from "express";

import { createTasksController } from "./tasks.controller";
import { createTaskSchema, listTasksSchema, taskContextQuerySchema, taskIdSchema, updateTaskSchema } from "./tasks.schemas";
import type { TasksService } from "../tasks.service";
import { createSubtasksController } from "./subtasks.controller";
import { createSubtaskSchema, subtaskIdSchema, updateSubtaskSchema } from "./subtasks.schemas";
import { searchTasksSchema } from "./tasks.search.schemas";

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
const validateContext: RequestHandler = (request, response, next) => {
  response.locals.context = taskContextQuerySchema.parse(request.query);
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
const validateSubtaskId: RequestHandler = (request, response, next) => {
  response.locals.subtaskId = subtaskIdSchema.parse(request.params.subtaskId);
  next();
};
const validateSubtaskCreate: RequestHandler = (request, response, next) => {
  response.locals.body = createSubtaskSchema.parse(request.body);
  next();
};
const validateSubtaskUpdate: RequestHandler = (request, response, next) => {
  response.locals.body = updateSubtaskSchema.parse(request.body);
  next();
};

export function createTasksRouter(service: TasksService) {
  const router = Router();
  const controller = createTasksController(service);
  const subtasks = createSubtasksController(service.subtasks);

  router.get("/", validateList, route(controller.list));
  router.get("/search", (request, response, next) => {
    response.locals.query = searchTasksSchema.parse(request.query);
    next();
  }, route(controller.search));
  router.post("/", validateContext, validateCreate, route(controller.create));
  router.get("/:id/subtasks", validateId, route(subtasks.list));
  router.post("/:id/subtasks", validateId, validateSubtaskCreate, route(subtasks.create));
  router.patch("/:id/subtasks/:subtaskId", validateId, validateSubtaskId, validateSubtaskUpdate, route(subtasks.update));
  router.delete("/:id/subtasks/:subtaskId", validateId, validateSubtaskId, route(subtasks.remove));
  router.get("/:id/history", validateId, route(controller.history));
  router.get("/:id", validateId, validateContext, route(controller.get));
  router.patch("/:id", validateId, validateContext, validateUpdate, route(controller.update));
  router.delete("/:id", validateId, route(controller.remove));

  return router;
}
