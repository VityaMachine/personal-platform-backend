import { z } from "zod";
import { TaskPriority, type RoutineAction } from "../../../generated/prisma/client";
import { taskFields } from "../tasks.fields";
import type { RoutineWithRelations } from "./routines.repository";
import { routineStateSchema, routineSubtaskInputSchema } from "./routines.schemas";
import { endConditionSchema, localDateSchema, scheduleSchema, timezoneSchema } from "./routines.schedule";

const snapshotSchema = z.strictObject({
  autoGenerate: z.boolean().optional(),
  generationHorizonDays: z.number().int().min(1).max(30).optional(),
  id: z.uuid(), title: taskFields.title, description: z.string().nullable(), priority: z.enum(TaskPriority),
  areaId: z.uuid().nullable(), area: z.strictObject({ id: z.uuid(), name: z.string().min(1).max(80) }).nullable(),
  estimatedDurationMinutes: taskFields.duration, timezone: timezoneSchema, startDate: localDateSchema,
  schedule: scheduleSchema, endCondition: endConditionSchema,
  subtasks: z.array(routineSubtaskInputSchema.extend({
    id: z.uuid(), routineId: z.uuid(), position: z.number().int().nonnegative(),
  })),
  pausedAt: z.iso.datetime().nullable(), deletedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});
export const routineActionMetadataSchema = z.strictObject({ before: snapshotSchema.nullable(), after: snapshotSchema,
  effectiveDate: localDateSchema.optional(), scheduleVersionId: z.uuid().optional(), versionNumber: z.number().int().min(2).optional(),
});

export function toRoutineResponse(routine: RoutineWithRelations) {
  try {
    const parsed = routineStateSchema.safeParse({
      autoGenerate: routine.autoGenerate, generationHorizonDays: routine.generationHorizonDays,
      title: routine.title, description: routine.description, priority: routine.priority, areaId: routine.areaId,
      estimatedDurationMinutes: routine.estimatedDurationMinutes,
      subtasks: routine.subtasks.map(({ title, estimatedDurationMinutes }) => ({ title, estimatedDurationMinutes })),
      timezone: routine.timezone, startDate: routine.startDate, schedule: routine.schedule, endCondition: routine.endCondition,
    });
    if (!parsed.success || parsed.data.estimatedDurationMinutes !== routine.estimatedDurationMinutes) {
      throw new Error("Invalid stored Routine state.");
    }
    return { ...routine, schedule: parsed.data.schedule, endCondition: parsed.data.endCondition };
  } catch {
    throw new Error("Invalid stored Routine state.");
  }
}

export function toRoutineActionResponse(action: RoutineAction) {
  try {
    const metadata = routineActionMetadataSchema.parse(action.metadata);
    if (action.type === "SCHEDULE_VERSION_CREATED" && (!metadata.effectiveDate || !metadata.scheduleVersionId || !metadata.versionNumber)) {
      throw new Error("Missing schedule version metadata.");
    }
    if ((action.type === "CREATED") !== (metadata.before === null)) throw new Error("Invalid creation snapshot.");
    for (const snapshot of [metadata.before, metadata.after]) {
      if (!snapshot) continue;
      const state = routineStateSchema.parse({
        title: snapshot.title, description: snapshot.description, priority: snapshot.priority, areaId: snapshot.areaId,
        estimatedDurationMinutes: snapshot.estimatedDurationMinutes, timezone: snapshot.timezone, startDate: snapshot.startDate,
        schedule: snapshot.schedule, endCondition: snapshot.endCondition,
        subtasks: snapshot.subtasks.map(({ title, estimatedDurationMinutes }) => ({ title, estimatedDurationMinutes })),
      });
      if (snapshot.id !== action.routineId || snapshot.areaId !== (snapshot.area?.id ?? null)
        || state.estimatedDurationMinutes !== snapshot.estimatedDurationMinutes
        || snapshot.subtasks.some((child, position) => child.routineId !== snapshot.id || child.position !== position)) {
        throw new Error("Inconsistent Routine snapshot.");
      }
    }
    // Preserve the recorded names and snapshots, rather than joining current Areas.
    return action;
  } catch {
    throw new Error("Invalid stored Routine history.");
  }
}
