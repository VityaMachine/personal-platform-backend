import { Router, type Request, type RequestHandler, type Response } from "express";
import type { PrismaClient } from "../../generated/prisma/client";
import { createRoutinesController } from "./routines.controller";
import { createRoutinesRepository } from "./routines.repository";
import { createRoutineSchema, routineIdSchema, routineQuerySchema, updateRoutineSchema } from "./routines.schemas";
import { createRoutinesService } from "./routines.service";

const route = <Locals extends Record<string, unknown>>(
  handler: (request: Request, response: Response<unknown, Locals>) => Promise<void>,
): RequestHandler<Request["params"], unknown, unknown, Request["query"], Locals> => (request, response, next) => {
  Promise.resolve(handler(request, response)).catch(next);
};
const validateId: RequestHandler = (request, response, next) => {
  response.locals.id = routineIdSchema.parse(request.params.id); next();
};
const validateQuery: RequestHandler = (request, _response, next) => { routineQuerySchema.parse(request.query); next(); };
const validateCreate: RequestHandler = (request, response, next) => {
  response.locals.body = createRoutineSchema.parse(request.body); next();
};
const validateUpdate: RequestHandler = (request, response, next) => {
  response.locals.body = updateRoutineSchema.parse(request.body); next();
};
export function createRoutinesRouter(client?: () => PrismaClient, now?: () => Date) {
  const router = Router();
  const controller = createRoutinesController(createRoutinesService(createRoutinesRepository(client), now));
  router.use(validateQuery);
  router.get("/", route(controller.list));
  router.post("/", validateCreate, route(controller.create));
  router.get("/:id/history", validateId, route(controller.history));
  router.get("/:id", validateId, route(controller.get));
  router.patch("/:id", validateId, validateUpdate, route(controller.update));
  router.delete("/:id", validateId, route(controller.remove));
  return router;
}
export const routinesRouter = createRoutinesRouter();
