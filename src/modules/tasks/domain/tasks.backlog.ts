import { Temporal } from "@js-temporal/polyfill";
import type { RoutineOccurrence, Task } from "../../../generated/prisma/client";
import { daysSinceOccurrenceEnd } from "./tasks.calendar";

export type TaskBacklogInput = Pick<Task, "status" | "archivedAt" | "deletedAt" | "plannedAt" | "dueAt"> & {
  routineOccurrence: Pick<RoutineOccurrence, "startDate" | "endDate" | "timezone"> | null;
};

/** Needs a new plan: no clock, I/O, Today preferences or current Routine lookup. */
export function isTaskBacklog(task: TaskBacklogInput, now: Date): boolean {
  if (task.status !== "TODO" && task.status !== "PAUSED" && task.status !== "POSTPONED") return false;
  if (task.archivedAt !== null || task.deletedAt !== null) return false;
  if (task.plannedAt !== null && task.plannedAt.getTime() > now.getTime()) return false;
  if (task.dueAt !== null && task.dueAt.getTime() > now.getTime()) return false;
  return task.routineOccurrence === null || daysSinceOccurrenceEnd(
    task.routineOccurrence, Temporal.Instant.fromEpochMilliseconds(now.getTime()),
  ) > 0;
}
