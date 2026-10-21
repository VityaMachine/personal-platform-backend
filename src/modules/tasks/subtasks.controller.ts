import type { Request, Response } from "express";
import type { TasksService } from "./tasks.service";
import type { CreateSubtaskInput, UpdateSubtaskInput } from "./subtasks.schemas";

type SubtaskResponse<Body = unknown> = Response<unknown, { id: string; subtaskId: string; body: Body }>;

export function createSubtasksController(service: TasksService["subtasks"]) {
  return {
    async list(_request: Request, response: SubtaskResponse) {
      response.json(await service.list(response.locals.id));
    },
    async create(_request: Request, response: SubtaskResponse<CreateSubtaskInput>) {
      response.status(201).json(await service.create(response.locals.id, response.locals.body));
    },
    async update(_request: Request, response: SubtaskResponse<UpdateSubtaskInput>) {
      response.json(await service.update(response.locals.id, response.locals.subtaskId, response.locals.body));
    },
    async remove(_request: Request, response: SubtaskResponse) {
      await service.remove(response.locals.id, response.locals.subtaskId);
      response.status(204).end();
    },
  };
}
