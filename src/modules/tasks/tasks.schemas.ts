import { z } from "zod";

import { TaskPriority, TaskStatus } from "../../generated/prisma/client";
import { ApiError } from "../../http/api-error";
import { sumSubtaskDurations, taskFields } from "./tasks.fields";
import { initialSubtaskSchema } from "./subtasks.schemas";
import { timezoneSchema } from "./routines/routines.schedule";

const { title, duration, note } = taskFields;
const dateTime = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
const areaId = z.uuid().transform((value) => value.toLowerCase()).nullable().optional();

export const createTaskSchema = z.strictObject({
  title,
  areaId,
  description: z.string().nullable().optional(),
  plannedAt: dateTime.optional(),
  priority: z.enum(TaskPriority).default("MEDIUM"),
  dueAt: dateTime,
  estimatedDurationMinutes: duration.optional(),
  status: z.literal("TODO").optional(),
  subtasks: z.array(initialSubtaskSchema).optional(),
}).superRefine((data, ctx) => {
  if (!data.subtasks?.length) {
    if (data.estimatedDurationMinutes === undefined) {
      ctx.addIssue({ code: "custom", path: ["estimatedDurationMinutes"], message: "Duration is required without subtasks." });
    }
    if (data.status !== undefined) {
      ctx.addIssue({ code: "custom", path: ["status"], message: "Status is only accepted when creating subtasks." });
    }
  }
}).transform((data) => ({
  ...data,
  // The refinement requires a duration when there are no initial subtasks.
  estimatedDurationMinutes: data.subtasks?.length
    ? sumSubtaskDurations(data.subtasks) : data.estimatedDurationMinutes!,
}));

export const updateTaskSchema = z.strictObject({
  title: title.optional(),
  areaId,
  description: z.string().nullable().optional(),
  status: z.enum(TaskStatus).optional(),
  priority: z.enum(TaskPriority).optional(),
  isCompleted: z.boolean().optional(),
  plannedAt: dateTime.nullable().optional(),
  dueAt: dateTime.nullable().optional(),
  estimatedDurationMinutes: duration.optional(),
  cancellationNote: note.optional(),
  skipNote: z.string().trim().min(1).max(2000).nullable().optional(),
  archived: z.boolean().optional(),
}).refine((data) => Object.keys(data).length > 0, "At least one field is required.")
  .refine((data) => data.status === undefined || data.isCompleted === undefined,
    "Send either status or isCompleted.")
  .refine((data) => data.status !== "CANCELED" || data.cancellationNote !== undefined,
    { message: "CANCELED requires a nonempty cancellationNote.", path: ["cancellationNote"] });

export const taskContextQuerySchema = z.strictObject({
  timezone: timezoneSchema.default("UTC"),
  overdueMode: z.enum(["none", "limited", "all"]).default("limited"),
  overdueDays: z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().min(1).max(365)).default(3),
});
export const listTasksSchema = taskContextQuerySchema.extend({
  archived: z.enum(["true", "false"]).optional(),
  view: z.enum(["today", "backlog"]).optional(),
}).refine((query) => query.archived !== "true" || query.view === undefined, "archived=true cannot be combined with view=today or view=backlog.");

// Keep the existing id error message instead of the generic Zod error response.
export const taskIdSchema = z.unknown().transform((id) => {
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) throw new ApiError(400, "Invalid task id.");
  return parsed.data;
});

export type CreateTaskInput = z.output<typeof createTaskSchema>;
export type UpdateTaskInput = z.output<typeof updateTaskSchema>;
export type ListTasksInput = z.output<typeof listTasksSchema>;
