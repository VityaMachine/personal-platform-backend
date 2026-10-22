import type { Task } from "../../generated/prisma/client";
import { ApiError } from "../../lib/api-error";
import {
  TasksTransactionConflictError,
  type TaskWithSubtasks,
  type TasksRepository,
  type TasksTransactionRepository,
} from "./tasks.repository";
import type { CreateTaskInput, ListTasksInput, UpdateTaskInput } from "./tasks.schemas";
import { createSubtasksService } from "./subtasks.service";

export function createTasksService(repository: TasksRepository) {
  async function findTask(id: string, reader: Pick<TasksRepository, "findFirst"> = repository) {
    const task = await reader.findFirst({ id, deletedAt: null });
    if (!task) throw new ApiError(404, "Task not found.");
    return task;
  }

  async function transaction<T>(work: (tx: TasksTransactionRepository) => Promise<T>): Promise<T> {
    try {
      return await repository.transaction(work);
    } catch (error) {
      if (error instanceof TasksTransactionConflictError) {
        throw new ApiError(409, "Task changed concurrently. Retry the request.");
      }
      throw error;
    }
  }

  return {
    subtasks: createSubtasksService({ findTask, transaction }),
    list(query: ListTasksInput) {
      return repository.findMany({
        deletedAt: null,
        archivedAt: query.archived === "true" ? { not: null } : null,
      });
    },
    get: findTask,
    create(data: CreateTaskInput) {
      return transaction(async (tx) => {
        const created = await tx.create({ ...data, plannedAt: data.plannedAt ?? null });
        await tx.createAction(created.id, "CREATED", { before: null, after: created });
        return { ...created, subtasks: [] } satisfies TaskWithSubtasks;
      });
    },
    history(id: string) {
      return transaction(async (tx) => {
        await findTask(id, tx);
        return tx.findHistory(id);
      });
    },
    update(id: string, input: UpdateTaskInput) {
      const { archived, isCompleted, ...fields } = input;
      return transaction(async (tx) => {
        const before = await findTask(id, tx);
        if (fields.estimatedDurationMinutes !== undefined && before.subtasks.length) {
          throw new ApiError(409, "Task duration is calculated from its subtasks.");
        }
        const data: Partial<Task> = { ...fields };
        const status = fields.status ?? (isCompleted === undefined ? undefined : isCompleted ? "DONE" : "TODO");
        if (status !== undefined) data.status = status;
        if (status === "POSTPONED" && before.status !== "POSTPONED" && fields.plannedAt === undefined) {
          data.plannedAt = null;
        }
        if (archived !== undefined) data.archivedAt = archived ? before.archivedAt ?? new Date() : null;
        const updated = await tx.update(id, data);
        const editedKeys = ["title", "description", "priority", "plannedAt", "dueAt", "estimatedDurationMinutes", "cancellationNote"] as const;
        const previous: Record<string, unknown> = {};
        const next: Record<string, unknown> = {};
        for (const key of editedKeys) {
          if (JSON.stringify(before[key]) !== JSON.stringify(updated[key])) {
            previous[key] = before[key];
            next[key] = updated[key];
          }
        }
        if (Object.keys(previous).length) {
          await tx.createAction(id, "EDITED", { before: previous, after: next });
        }
        if (before.status !== updated.status) {
          await tx.createAction(id, "STATUS_CHANGED", {
            before: { status: before.status, cancellationNote: before.cancellationNote },
            after: { status: updated.status, cancellationNote: updated.cancellationNote },
          });
        }
        if (Boolean(before.archivedAt) !== Boolean(updated.archivedAt)) {
          await tx.createAction(id, updated.archivedAt ? "ARCHIVED" : "UNARCHIVED", {
            before: { archivedAt: before.archivedAt },
            after: { archivedAt: updated.archivedAt },
          });
        }
        return updated;
      });
    },
    remove(id: string) {
      return transaction(async (tx) => {
        const before = await findTask(id, tx);
        const updated = await tx.update(id, { deletedAt: new Date() });
        await tx.createAction(id, "DELETED", {
          before: { deletedAt: before.deletedAt },
          after: { deletedAt: updated.deletedAt },
        });
      });
    },
  };
}

export type TasksService = ReturnType<typeof createTasksService>;
