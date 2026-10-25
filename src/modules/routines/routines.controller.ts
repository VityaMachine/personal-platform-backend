import type { Request, Response } from "express";
import type { CreateRoutineInput, UpdateRoutineInput } from "./routines.schemas";
import type { RoutinesService } from "./routines.service";

type RoutineResponse<Locals extends Record<string, unknown>> = Response<unknown, Locals>;
export function createRoutinesController(service: RoutinesService) {
  return {
    async list(_request: Request, response: Response) { response.json(await service.list()); },
    async get(_request: Request, response: RoutineResponse<{ id: string }>) { response.json(await service.get(response.locals.id)); },
    async create(_request: Request, response: RoutineResponse<{ body: CreateRoutineInput }>) {
      response.status(201).json(await service.create(response.locals.body));
    },
    async update(_request: Request, response: RoutineResponse<{ id: string; body: UpdateRoutineInput }>) {
      response.json(await service.update(response.locals.id, response.locals.body));
    },
    async remove(_request: Request, response: RoutineResponse<{ id: string }>) {
      await service.remove(response.locals.id);
      response.status(204).end();
    },
    async history(_request: Request, response: RoutineResponse<{ id: string }>) { response.json(await service.history(response.locals.id)); },
  };
}
