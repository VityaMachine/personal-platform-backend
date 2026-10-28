import type { Request, Response } from "express";
import { toAreaResponse } from "./areas.mapper";
import type { CreateAreaInput, UpdateAreaInput } from "./areas.schemas";
import type { AreasService } from "../areas.service";

type AreaResponse<Locals extends Record<string, unknown>> = Response<unknown, Locals>;
export function createAreasController(service: AreasService, deleteArea: (id: string) => Promise<void>) {
  return {
    async list(_request: Request, response: Response) {
      response.json((await service.list()).map(toAreaResponse));
    },
    async create(_request: Request, response: AreaResponse<{ body: CreateAreaInput }>) {
      response.status(201).json(toAreaResponse(await service.create(response.locals.body)));
    },
    async update(_request: Request, response: AreaResponse<{ id: string; body: UpdateAreaInput }>) {
      response.json(toAreaResponse(await service.update(response.locals.id, response.locals.body)));
    },
    async remove(_request: Request, response: AreaResponse<{ id: string }>) {
      await deleteArea(response.locals.id);
      response.status(204).end();
    },
  };
}
