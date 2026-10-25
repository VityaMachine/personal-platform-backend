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
import { calculateTaskSummary } from "./tasks.summary";
import { toAreaSnapshot } from "../areas/areas.mapper";
import { createTaskWithSubtasks } from "./tasks.creation";

export function createTasksService(repository: TasksRepository, now: () => Date = () => new Date()) {
  async function assignableArea(id: string | null | undefined, tx: TasksTransactionRepository) {
    if (!id) return null;
    const area = await tx.findAreaForAssignment(id);
    if (!area) throw new ApiError(404, "Area not found.");
    return { id: area.id, name: area.name };
  }
  async function summarize(tasks: TaskWithSubtasks[], tx: TasksTransactionRepository) {
    const actions = tasks.length ? await tx.findSummaryActions(tasks.map((task) => task.id)) : [];
    const grouped = new Map<string, typeof actions>();
    for (const action of actions) {
      const entries = grouped.get(action.taskId) ?? [];
      entries.push(action);
      grouped.set(action.taskId, entries);
    }
    const asOf = now();
    return tasks.map((task) => ({ ...task, summary: calculateTaskSummary(task, grouped.get(task.id) ?? [], asOf) }));
  }
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
      return transaction(async (tx) => summarize(await tx.findMany({
        deletedAt: null,
        archivedAt: query.archived === "true" ? { not: null } : null,
      }), tx));
    },
    get(id: string) {
      return transaction(async (tx) => (await summarize([await findTask(id, tx)], tx))[0]);
    },
    create(data: CreateTaskInput) {
      const { subtasks = [], ...fields } = data;
      return transaction(async (tx) => {
        const area = await assignableArea(fields.areaId, tx);
        const created = await createTaskWithSubtasks(tx, fields, subtasks, { area });
        const task = subtasks.length ? await findTask(created.id, tx) : { ...created, area, subtasks: [], routineOccurrence: null };
        return (await summarize([task], tx))[0];
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
        const areaChanged = fields.areaId !== undefined && fields.areaId !== before.areaId;
        // Even a same-ID write must take the Area lock before updating Task:
        // otherwise an FK check can reverse the deletion lock order.
        if (fields.areaId) await assignableArea(fields.areaId, tx);
        await tx.lock(id);
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
        if (areaChanged) {
          await tx.createAction(id, "AREA_CHANGED", {
            before: { areaId: before.areaId, area: toAreaSnapshot(before.area) },
            after: { areaId: updated.areaId, area: toAreaSnapshot(updated.area) },
          });
        }
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
        return (await summarize([updated], tx))[0];
      });
    },
    remove(id: string) {
      return transaction(async (tx) => {
        await tx.lock(id);
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
