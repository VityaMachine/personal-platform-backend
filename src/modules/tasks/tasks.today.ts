import { Temporal } from "@js-temporal/polyfill";
import type { Task, RoutineOccurrence } from "../../generated/prisma/client";

export type TaskTodayContext = { timezone: string; overdueMode: "none" | "limited" | "all"; overdueDays: number };
export const DEFAULT_TODAY_CONTEXT: Readonly<TaskTodayContext> = { timezone: "UTC", overdueMode: "limited", overdueDays: 3 };
export type TaskTodayInput = Pick<Task, "status" | "archivedAt" | "deletedAt" | "plannedAt" | "dueAt"> & {
  routineOccurrence: Pick<RoutineOccurrence, "startDate" | "endDate" | "timezone"> | null;
};

/** Calendar selection only: no clock, I/O, summary dependency or current Routine lookup. */
export function isTaskToday(task: TaskTodayInput, context: Readonly<TaskTodayContext>, now: Date): boolean {
  if (task.status === "DONE" || task.status === "CANCELED" || task.archivedAt !== null || task.deletedAt !== null) return false;
  const instant = Temporal.Instant.fromEpochMilliseconds(now.getTime());
  const today = instant.toZonedDateTimeISO(context.timezone).toPlainDate();
  function matchesDate(value: Date | null): boolean {
    if (value === null) return false;
    const date = Temporal.Instant.fromEpochMilliseconds(value.getTime()).toZonedDateTimeISO(context.timezone).toPlainDate();
    const difference = date.until(today).days;
    if (difference < 0) return false;
    return context.overdueMode === "all" || (context.overdueMode === "none" ? difference === 0 : difference <= context.overdueDays);
  }
  // A deadline is independent, including when a personal plan is in the future.
  if (matchesDate(task.dueAt)) return true;
  if (task.plannedAt !== null) return matchesDate(task.plannedAt);
  const occurrence = task.routineOccurrence;
  if (occurrence === null) return false;
  const occurrenceToday = instant.toZonedDateTimeISO(occurrence.timezone).toPlainDate();
  if (Temporal.PlainDate.compare(occurrenceToday, occurrence.startDate) < 0) return false;
  const overdueDays = Temporal.PlainDate.from(occurrence.endDate).until(occurrenceToday).days;
  if (overdueDays <= 0) return true;
  return context.overdueMode === "all" || (context.overdueMode === "limited" && overdueDays <= context.overdueDays);
}
