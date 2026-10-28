import type { Subtask, Task } from "../../generated/prisma/client";
import { ApiError } from "../../http/api-error";
import type { TasksTransactionRepository } from "./tasks.repository";
import type { CreateSubtaskInput, UpdateSubtaskInput } from "./http/subtasks.schemas";
import { sumSubtaskDurations } from "./tasks.fields";

type Transaction = TasksTransactionRepository;
type Dependencies = {
  findTask(id: string, tx: Transaction): Promise<Task>;
  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
};

export function createSubtasksService({ findTask, transaction }: Dependencies) {
  async function writableParent(taskId: string, tx: Transaction) {
    await tx.lock(taskId);
    const parent = await findTask(taskId, tx);
    if (parent.archivedAt) throw new ApiError(409, "Archived task subtasks cannot be changed.");
    return parent;
  }

  async function findSubtask(taskId: string, id: string, tx: Transaction) {
    const subtask = await tx.findSubtask(taskId, id);
    if (!subtask) throw new ApiError(404, "Subtask not found.");
    return subtask;
  }

  async function synchronize(tx: Transaction, parent: Task, subtaskId: string) {
    const subtasks = await tx.findSubtasks(parent.id);
    // Keep the last duration and status after deleting the final subtask.
    if (!subtasks.length) return;
    const duration = sumSubtaskDurations(subtasks);
    let status = parent.status;
    if (subtasks.every((subtask) => subtask.status === "TODO")) status = "TODO";
    else if (subtasks.every((subtask) => subtask.status === "DONE")) status = "DONE";
    else if (subtasks.some((subtask) => subtask.status === "IN_PROGRESS")) status = "IN_PROGRESS";
    else if (subtasks.some((subtask) => subtask.status === "DONE") &&
      subtasks.some((subtask) => subtask.status === "TODO") &&
      parent.status !== "PAUSED" && parent.status !== "POSTPONED") status = "IN_PROGRESS";
    if (duration === parent.estimatedDurationMinutes && status === parent.status) return;
    const updated = await tx.update(parent.id, { estimatedDurationMinutes: duration, status,
      ...(parent.status === "SKIPPED" && status !== "SKIPPED" ? { skipNote: null } : {}),
    });
    if (duration !== parent.estimatedDurationMinutes) {
      await tx.createAction(parent.id, "EDITED", {
        subtaskId,
        before: { estimatedDurationMinutes: parent.estimatedDurationMinutes },
        after: { estimatedDurationMinutes: updated.estimatedDurationMinutes },
      });
    }
    if (status !== parent.status) {
      await tx.createAction(parent.id, "STATUS_CHANGED", {
        subtaskId,
        before: { status: parent.status, cancellationNote: parent.cancellationNote,
          ...(parent.status === "SKIPPED" ? { skipNote: parent.skipNote } : {}) },
        after: { status: updated.status, cancellationNote: updated.cancellationNote,
          ...(parent.status === "SKIPPED" ? { skipNote: updated.skipNote } : {}) },
      });
    }
  }

  return {
    list(taskId: string) {
      return transaction(async (tx) => {
        await findTask(taskId, tx);
        return tx.findSubtasks(taskId);
      });
    },
    create(taskId: string, input: CreateSubtaskInput) {
      return transaction(async (tx) => {
        const parent = await writableParent(taskId, tx);
        const created = await tx.createSubtask(taskId, input);
        await tx.createAction(taskId, "SUBTASK_CREATED", { subtaskId: created.id, before: null, after: created });
        await synchronize(tx, parent, created.id);
        return created;
      });
    },
    update(taskId: string, id: string, input: UpdateSubtaskInput) {
      return transaction(async (tx) => {
        const parent = await writableParent(taskId, tx);
        const before = await findSubtask(taskId, id, tx);
        const updated = await tx.updateSubtask(id, input);
        const previous: Partial<Subtask> = {};
        const next: Partial<Subtask> = {};
        for (const key of ["title", "estimatedDurationMinutes", "cancellationNote"] as const) {
          if (before[key] !== updated[key]) {
            Object.assign(previous, { [key]: before[key] });
            Object.assign(next, { [key]: updated[key] });
          }
        }
        if (Object.keys(previous).length) {
          await tx.createAction(taskId, "SUBTASK_EDITED", { subtaskId: id, before: previous, after: next });
        }
        if (before.status !== updated.status) {
          await tx.createAction(taskId, "SUBTASK_STATUS_CHANGED", {
            subtaskId: id,
            before: { status: before.status, cancellationNote: before.cancellationNote },
            after: { status: updated.status, cancellationNote: updated.cancellationNote },
          });
        }
        await synchronize(tx, parent, id);
        return updated;
      });
    },
    remove(taskId: string, id: string) {
      return transaction(async (tx) => {
        const parent = await writableParent(taskId, tx);
        const before = await findSubtask(taskId, id, tx);
        const updated = await tx.updateSubtask(id, { deletedAt: new Date() });
        await tx.createAction(taskId, "SUBTASK_DELETED", {
          subtaskId: id, before: { deletedAt: before.deletedAt }, after: { deletedAt: updated.deletedAt },
        });
        await synchronize(tx, parent, id);
      });
    },
  };
}
