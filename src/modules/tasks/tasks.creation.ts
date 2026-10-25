import type { Prisma } from "../../generated/prisma/client";
import { sumSubtaskDurations } from "./tasks.fields";
import type { TasksTransactionRepository } from "./tasks.repository";

type CreationContext = {
  area: { id: string; name: string } | null;
  routineOccurrence?: { id: string; routineId: string; occurrenceKey: string; startDate: string; endDate: string;
    timezone: string; localTime: string | null; instant: Date | null; snapshot?: Prisma.JsonValue };
};

/** Shared transactional domain creation. The caller validates input, locks Area and owns the transaction. */
export async function createTaskWithSubtasks(
  tx: TasksTransactionRepository,
  fields: Prisma.TaskUncheckedCreateInput,
  subtasks: readonly { title: string; estimatedDurationMinutes: number }[],
  context: CreationContext,
) {
  const created = await tx.create({ ...fields, status: "TODO", plannedAt: fields.plannedAt ?? null,
    areaId: context.area?.id ?? null,
    estimatedDurationMinutes: subtasks.length ? sumSubtaskDurations(subtasks) : fields.estimatedDurationMinutes,
    ...(context.routineOccurrence ? { routineOccurrenceId: context.routineOccurrence.id } : {}),
  });
  await tx.createAction(created.id, "CREATED", {
    before: null, after: { ...created, area: context.area },
    ...(context.routineOccurrence ? { origin: { type: "ROUTINE", routineId: context.routineOccurrence.routineId },
      routineOccurrence: context.routineOccurrence } : {}),
  });
  for (const template of subtasks) {
    const child = await tx.createSubtask(created.id, { title: template.title,
      estimatedDurationMinutes: template.estimatedDurationMinutes, status: "TODO" });
    await tx.createAction(created.id, "SUBTASK_CREATED", { subtaskId: child.id, before: null, after: child });
  }
  return created;
}
