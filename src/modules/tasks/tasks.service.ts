import { TaskStatus, type Task } from "../../generated/prisma/client";
import { ApiError } from "../../http/api-error";
import {
  TasksTransactionConflictError,
  type TaskWithSubtasks,
  type TasksRepository,
  type TasksTransactionRepository,
} from "./tasks.repository";
import type { CreateTaskInput, ListTasksInput, UpdateTaskInput } from "./http/tasks.schemas";
import { createSubtasksService } from "./subtasks.service";
import { calculateTaskSummary } from "./domain/tasks.summary";
import { toAreaSnapshot } from "../areas/http/areas.mapper";
import { createTaskWithSubtasks } from "./tasks.creation";
import { DEFAULT_TODAY_CONTEXT, isTaskToday, type TaskTodayContext } from "./domain/tasks.today";
import { verifiedTaskCompletion } from "./domain/tasks.completion";
import { isTaskBacklog } from "./domain/tasks.backlog";
import type { SearchTasksInput } from "./http/tasks.search.schemas";

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
    return { tasks, grouped };
  }
  function present(snapshot: Awaited<ReturnType<typeof summarize>>, context: Readonly<TaskTodayContext>, instant?: Date) {
    // Legacy reads capture time after commit; search supplies its single request instant.
    // Summary and calendar selection have independent rules over the same consistent snapshot.
    const asOf = instant ?? now();
    return snapshot.tasks.map((task) => {
      const actions = snapshot.grouped.get(task.id) ?? [];
      const outcome = task.status === "DONE" || task.status === "SKIPPED" ? verifiedTaskCompletion(task, actions, asOf) : null;
      const completedAt = outcome?.completedAt?.toISOString() ?? null;
      const skippedAt = outcome?.skippedAt?.toISOString() ?? null;
      return { ...task, completedAt, skippedAt,
        summary: calculateTaskSummary(task, actions, asOf),
        isToday: isTaskToday({ ...task, completedAt }, context, asOf),
        isBacklog: isTaskBacklog(task, asOf),
      };
    });
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
    async search(query: SearchTasksInput) {
      const asOf = now();
      const { selection, snapshot } = await transaction(async (tx) => {
        const selection = await tx.search(query, asOf);
        const tasks = selection.ids.length ? await tx.findMany({ id: { in: selection.ids } }) : [];
        const byId = new Map(tasks.map((task) => [task.id, task]));
        return { selection, snapshot: await summarize(selection.ids.map((id) => byId.get(id)!), tx) };
      });
      const counts = Object.fromEntries(Object.values(TaskStatus).map((status) => [status, selection.counts[status] ?? 0]));
      const totalPages = Math.ceil(selection.total / query.pageSize);
      return {
        items: present(snapshot, { ...DEFAULT_TODAY_CONTEXT, timezone: query.timezone }, asOf),
        page: query.page, pageSize: query.pageSize, totalItems: selection.total, totalPages,
        hasPreviousPage: selection.total > 0 && query.page > 1,
        hasNextPage: query.page < totalPages,
        summary: { totalItems: Object.values(counts).reduce((sum, count) => sum + count, 0), counts },
        asOf: asOf.toISOString(),
      };
    },
    async list(query: ListTasksInput) {
      const snapshot = await transaction(async (tx) => summarize(await tx.findMany({
        deletedAt: null,
        archivedAt: query.archived === "true" ? { not: null } : null,
      }), tx));
      const tasks = present(snapshot, query);
      if (query.view === "today") return tasks.filter((task) => task.isToday);
      if (query.view === "backlog") return tasks.filter((task) => task.isBacklog);
      return tasks;
    },
    async get(id: string, context: Readonly<TaskTodayContext> = DEFAULT_TODAY_CONTEXT) {
      const snapshot = await transaction(async (tx) => summarize([await findTask(id, tx)], tx));
      return present(snapshot, context)[0];
    },
    async create(data: CreateTaskInput, context: Readonly<TaskTodayContext> = DEFAULT_TODAY_CONTEXT) {
      const { subtasks = [], ...fields } = data;
      const snapshot = await transaction(async (tx) => {
        const area = await assignableArea(fields.areaId, tx);
        const created = await createTaskWithSubtasks(tx, fields, subtasks, { area });
        const task = subtasks.length ? await findTask(created.id, tx) : { ...created, area, subtasks: [], routineOccurrence: null };
        return summarize([task], tx);
      });
      return present(snapshot, context)[0];
    },
    history(id: string) {
      return transaction(async (tx) => {
        await findTask(id, tx);
        return tx.findHistory(id);
      });
    },
    async update(id: string, input: UpdateTaskInput, context: Readonly<TaskTodayContext> = DEFAULT_TODAY_CONTEXT) {
      const { archived, isCompleted, ...fields } = input;
      const snapshot = await transaction(async (tx) => {
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
        const nextStatus = status ?? before.status;
        if (nextStatus === "SKIPPED" && before.routineOccurrence === null) {
          throw new ApiError(400, "Only a Routine Task can be skipped.");
        }
        if (fields.skipNote !== undefined && fields.skipNote !== null && nextStatus !== "SKIPPED") {
          throw new ApiError(400, "skipNote requires SKIPPED status.");
        }
        if (nextStatus === "SKIPPED") {
          data.cancellationNote = null;
          if (before.status !== "SKIPPED") data.skipNote = fields.skipNote ?? null;
        } else if (before.status === "SKIPPED") data.skipNote = null;
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
        const editedKeys = ["title", "description", "priority", "plannedAt", "dueAt", "estimatedDurationMinutes", "cancellationNote", "skipNote"] as const;
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
            before: { status: before.status, cancellationNote: before.cancellationNote, skipNote: before.skipNote },
            after: { status: updated.status, cancellationNote: updated.cancellationNote, skipNote: updated.skipNote },
          });
        }
        if (Boolean(before.archivedAt) !== Boolean(updated.archivedAt)) {
          await tx.createAction(id, updated.archivedAt ? "ARCHIVED" : "UNARCHIVED", {
            before: { archivedAt: before.archivedAt },
            after: { archivedAt: updated.archivedAt },
          });
        }
        return summarize([updated], tx);
      });
      return present(snapshot, context)[0];
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
