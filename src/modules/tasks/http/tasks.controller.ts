import type { Request, Response } from "express";

import { toTaskResponse } from "./tasks.mapper";
import type { CreateTaskInput, ListTasksInput, UpdateTaskInput } from "./tasks.schemas";
import type { TasksService } from "../tasks.service";
import type { TaskTodayContext } from "../domain/tasks.today";
import type { SearchTasksInput } from "./tasks.search.schemas";

type TaskResponse<Locals extends Record<string, unknown>> = Response<unknown, Locals>;

export function createTasksController(service: TasksService) {
  return {
    async search(_request: Request, response: TaskResponse<{ query: SearchTasksInput }>) {
      const result = await service.search(response.locals.query);
      response.json({ ...result, items: result.items.map(toTaskResponse) });
    },
    async list(_request: Request, response: TaskResponse<{ query: ListTasksInput }>) {
      const tasks = await service.list(response.locals.query);
      response.json(tasks.map(toTaskResponse));
    },
    async create(_request: Request, response: TaskResponse<{ body: CreateTaskInput; context: TaskTodayContext }>) {
      const task = await service.create(response.locals.body, response.locals.context);
      response.status(201).json(toTaskResponse(task));
    },
    async history(_request: Request, response: TaskResponse<{ id: string }>) {
      response.json(await service.history(response.locals.id));
    },
    async get(_request: Request, response: TaskResponse<{ id: string; context: TaskTodayContext }>) {
      const task = await service.get(response.locals.id, response.locals.context);
      response.json(toTaskResponse(task));
    },
    async update(_request: Request, response: TaskResponse<{ id: string; body: UpdateTaskInput; context: TaskTodayContext }>) {
      const task = await service.update(response.locals.id, response.locals.body, response.locals.context);
      response.json(toTaskResponse(task));
    },
    async remove(_request: Request, response: TaskResponse<{ id: string }>) {
      await service.remove(response.locals.id);
      response.status(204).end();
    },
  };
}
