import { Router, type Request, type RequestHandler, type Response } from "express";
import type { PrismaClient } from "../../generated/prisma/client";
import { createAreasController } from "./areas.controller";
import { createAreasRepository } from "./areas.repository";
import { areaIdSchema, createAreaSchema, deleteAreaSchema, listAreasSchema, updateAreaSchema } from "./areas.schemas";
import { createAreasService } from "./areas.service";

const route = <Locals extends Record<string, unknown>>(
  handler: (request: Request, response: Response<unknown, Locals>) => Promise<void>,
): RequestHandler<Request["params"], unknown, unknown, Request["query"], Locals> => (request, response, next) => {
  Promise.resolve(handler(request, response)).catch(next);
};
const validateId: RequestHandler = (request, response, next) => {
  response.locals.id = areaIdSchema.parse(request.params.id);
  next();
};
const validateQuery: RequestHandler = (request, _response, next) => {
  listAreasSchema.parse(request.query);
  next();
};
const validateCreate: RequestHandler = (request, response, next) => {
  response.locals.body = createAreaSchema.parse(request.body);
  next();
};
const validateUpdate: RequestHandler = (request, response, next) => {
  response.locals.body = updateAreaSchema.parse(request.body);
  next();
};
const validateDelete: RequestHandler = (request, _response, next) => {
  deleteAreaSchema.parse(request.body);
  next();
};
export function createAreasRouter(client?: () => PrismaClient) {
  const router = Router();
  const controller = createAreasController(createAreasService(createAreasRepository(client)));
  router.use(validateQuery);
  router.get("/", route(controller.list));
  router.post("/", validateCreate, route(controller.create));
  router.patch("/:id", validateId, validateUpdate, route(controller.update));
  router.delete("/:id", validateId, validateDelete, route(controller.remove));
  return router;
}
export const areasRouter = createAreasRouter();
