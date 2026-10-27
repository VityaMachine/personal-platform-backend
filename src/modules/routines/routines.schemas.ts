import { z } from "zod";
import { TaskPriority } from "../../generated/prisma/client";
import { ApiError } from "../../lib/api-error";
import { sumSubtaskDurations, taskFields } from "../tasks/tasks.fields";
import { endConditionSchema, localDateSchema, scheduleSchema, timezoneSchema } from "./routines.schedule";

export const routineSubtaskInputSchema = z.strictObject({
  title: taskFields.title, estimatedDurationMinutes: taskFields.duration,
});
const fields = {
  autoGenerate: z.boolean().default(false),
  generationHorizonDays: z.number().int().min(1).max(30).default(7),
  title: taskFields.title,
  description: z.string().nullable(),
  priority: z.enum(TaskPriority),
  areaId: z.uuid().transform((value) => value.toLowerCase()).nullable(),
  estimatedDurationMinutes: taskFields.duration,
  subtasks: z.array(routineSubtaskInputSchema),
  timezone: timezoneSchema,
  startDate: localDateSchema,
  schedule: scheduleSchema,
  endCondition: endConditionSchema,
};
const stateObject = z.strictObject({ ...fields, estimatedDurationMinutes: fields.estimatedDurationMinutes.optional() });
export const routineStateSchema = stateObject.superRefine((data, ctx) => {
  if (!data.subtasks.length && data.estimatedDurationMinutes === undefined) {
    ctx.addIssue({ code: "custom", path: ["estimatedDurationMinutes"], message: "Duration is required without subtasks." });
  }
  if (data.endCondition.type === "UNTIL_DATE" && data.endCondition.date < data.startDate) {
    ctx.addIssue({ code: "custom", path: ["endCondition", "date"], message: "End date must not precede startDate." });
  }
}).transform((data) => ({ ...data,
  estimatedDurationMinutes: data.subtasks.length ? sumSubtaskDurations(data.subtasks) : data.estimatedDurationMinutes!,
}));
export const createRoutineSchema = stateObject.extend({
  description: fields.description.default(null), priority: fields.priority.default("MEDIUM"),
  areaId: fields.areaId.default(null), subtasks: fields.subtasks.default([]),
  endCondition: endConditionSchema.default({ type: "NEVER" }),
}).transform((data) => routineStateSchema.parse(data));
export const updateRoutineSchema = z.strictObject({
  autoGenerate: fields.autoGenerate.removeDefault().optional(),
  generationHorizonDays: fields.generationHorizonDays.removeDefault().optional(),
  title: fields.title.optional(), description: fields.description.optional(), priority: fields.priority.optional(),
  areaId: fields.areaId.optional(), estimatedDurationMinutes: fields.estimatedDurationMinutes.optional(),
  subtasks: fields.subtasks.optional(), timezone: fields.timezone.optional(), startDate: fields.startDate.optional(),
  schedule: fields.schedule.optional(), endCondition: fields.endCondition.optional(), paused: z.boolean().optional(),
}).refine((data) => Object.keys(data).length > 0, "At least one field is required.");
export const routineIdSchema = z.unknown().transform((id) => {
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) throw new ApiError(400, "Invalid routine id.");
  return parsed.data.toLowerCase();
});
export const routineQuerySchema = z.strictObject({});
export type RoutineState = z.output<typeof routineStateSchema>;
export type CreateRoutineInput = z.output<typeof createRoutineSchema>;
export type UpdateRoutineInput = z.output<typeof updateRoutineSchema>;
