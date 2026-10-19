import { Router } from "express";
import { z } from "zod";

import { Prisma } from "../generated/prisma/client";
import { getPrisma } from "../lib/prisma";

const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().optional(),
});

const taskIdSchema = z.uuid();
const updateTaskStatusSchema = z.strictObject({
  isCompleted: z.boolean(),
});

export const tasksRouter = Router();

tasksRouter.get("/", async (_request, response, next) => {
  try {
    const tasks = await getPrisma().task.findMany({
      orderBy: { createdAt: "desc" },
    });

    response.json(tasks);
  } catch (error) {
    next(error);
  }
});

tasksRouter.post("/", async (request, response, next) => {
  const result = createTaskSchema.safeParse(request.body);

  if (!result.success) {
    response.status(400).json({
      error: {
        message: "Invalid task data.",
        details: result.error.issues.map(({ path, message }) => ({
          path,
          message,
        })),
      },
    });
    return;
  }

  try {
    const task = await getPrisma().task.create({ data: result.data });

    response.status(201).json(task);
  } catch (error) {
    next(error);
  }
});

tasksRouter.patch("/:id", async (request, response, next) => {
  const idResult = taskIdSchema.safeParse(request.params.id);

  if (!idResult.success) {
    response.status(400).json({ error: { message: "Invalid task id." } });
    return;
  }

  const result = updateTaskStatusSchema.safeParse(request.body);

  if (!result.success) {
    response.status(400).json({
      error: {
        message: "Invalid task data.",
        details: result.error.issues.map(({ path, message }) => ({
          path,
          message,
        })),
      },
    });
    return;
  }

  try {
    const task = await getPrisma().task.update({
      where: { id: idResult.data },
      data: result.data,
    });

    response.json(task);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      response.status(404).json({ error: { message: "Task not found." } });
      return;
    }

    next(error);
  }
});

tasksRouter.delete("/:id", async (request, response, next) => {
  const idResult = taskIdSchema.safeParse(request.params.id);

  if (!idResult.success) {
    response.status(400).json({ error: { message: "Invalid task id." } });
    return;
  }

  try {
    await getPrisma().task.delete({
      where: { id: idResult.data },
    });

    response.status(204).end();
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      response.status(404).json({ error: { message: "Task not found." } });
      return;
    }

    next(error);
  }
});
